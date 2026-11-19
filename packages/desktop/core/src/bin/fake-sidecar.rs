//! A stand-in for `navvied serve --http` that the tests can steer with environment variables. It speaks just enough:
//! the ready line, `/api/info` with a key check, and a WebSocket that replays scripted events.
//!
//! FAKE_FAIL_FIRST_N / FAKE_CRASH_FIRST_N + FAKE_COUNTER_FILE: fail or crash the first N launches.
//! FAKE_CRASH_AFTER_MS: crash this long after starting, every launch.
//! FAKE_EXIT_AT_ONCE, FAKE_NO_READY, FAKE_IGNORE_STDIN, FAKE_LEAK_TOKEN: the named misbehaviour.
//! FAKE_PID_FILE: write its own process id there.
//! FAKE_GRANDCHILD_FILE: start a long sleeper and write its process id there.
//! FAKE_EVENTS: lines sent after a WebSocket connects (`sleep:MS` pauses). FAKE_CANCEL_FILE: written when `cancel` arrives.

use navvied_desktop_core::sha1::{base64, sha1};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::Duration;
use std::{env, fs, process, thread};

const GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

fn flag(name: &str) -> bool {
    env::var(name).is_ok_and(|v| v == "1")
}

fn count_launch() -> u32 {
    let Ok(path) = env::var("FAKE_COUNTER_FILE") else { return u32::MAX };
    let n = fs::read_to_string(&path).ok().and_then(|s| s.trim().parse::<u32>().ok()).unwrap_or(0) + 1;
    let _ = fs::write(&path, n.to_string());
    n
}

fn frame(text: &str) -> Vec<u8> {
    let b = text.as_bytes();
    let mut out = vec![0x81];
    if b.len() < 126 {
        out.push(b.len() as u8);
    } else {
        out.push(126);
        out.extend_from_slice(&(b.len() as u16).to_be_bytes());
    }
    out.extend_from_slice(b);
    out
}

fn handle(mut stream: TcpStream, token: String, cwd: String) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut first = String::new();
    if reader.read_line(&mut first).is_err() {
        return;
    }
    let mut headers = Vec::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 || line.trim().is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            headers.push((k.trim().to_ascii_lowercase(), v.trim().to_owned()));
        }
    }
    let header = |n: &str| headers.iter().find(|(k, _)| k == n).map(|(_, v)| v.clone()).unwrap_or_default();
    let host_ok = header("host").starts_with("127.0.0.1") || header("host").starts_with("localhost");
    let protocol = header("sec-websocket-protocol");
    let given = header("authorization")
        .strip_prefix("Bearer ")
        .map(str::to_owned)
        .or_else(|| protocol.strip_prefix("navvied-key.").map(str::to_owned))
        .unwrap_or_default();
    let path = first.split_whitespace().nth(1).unwrap_or("/");
    let reply = |status: &str, body: &str| {
        format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
    };
    if !host_ok {
        let _ = stream.write_all(reply("403 Forbidden", "forbidden").as_bytes());
    } else if path.starts_with("/api/info") {
        let out = if given == token {
            reply("200 OK", &format!(r#"{{"version":"fake","model":"fake-model","cwd":{},"session":null}}"#, serde_json_string(&cwd)))
        } else {
            reply("401 Unauthorized", "unauthorised")
        };
        let _ = stream.write_all(out.as_bytes());
    } else if path.starts_with("/ws") {
        if given != token {
            let _ = stream.write_all(reply("401 Unauthorized", "unauthorised").as_bytes());
            return;
        }
        let accept = base64(&sha1(format!("{}{GUID}", header("sec-websocket-key")).as_bytes()));
        let _ = write!(stream, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\nSec-WebSocket-Protocol: {protocol}\r\n\r\n");
        let mut tx = stream.try_clone().unwrap();
        thread::spawn(move || {
            for line in env::var("FAKE_EVENTS").unwrap_or_default().lines() {
                eprintln!("fake: event line {line:?}");
                if let Some(ms) = line.strip_prefix("sleep:") {
                    thread::sleep(Duration::from_millis(ms.parse().unwrap_or(0)));
                } else if !line.is_empty() && tx.write_all(&frame(line)).is_err() {
                    return;
                }
            }
        });
        let mut head = [0u8; 2];
        while reader.read_exact(&mut head).is_ok() {
            let mut len = u64::from(head[1] & 0x7F);
            if len == 126 {
                let mut b = [0u8; 2];
                let _ = reader.read_exact(&mut b);
                len = u64::from(u16::from_be_bytes(b));
            }
            let mut mask = [0u8; 4];
            let _ = reader.read_exact(&mut mask);
            let mut payload = vec![0u8; len as usize];
            let _ = reader.read_exact(&mut payload);
            payload.iter_mut().enumerate().for_each(|(i, b)| *b ^= mask[i % 4]);
            if String::from_utf8_lossy(&payload).contains(r#""cmd":"cancel""#) {
                if let Ok(f) = env::var("FAKE_CANCEL_FILE") {
                    let _ = fs::write(f, "cancel");
                }
            }
            if head[0] & 0x0F == 0x8 {
                break;
            }
        }
    } else {
        let _ = stream.write_all(reply("404 Not Found", "not found").as_bytes());
    }
}

fn serde_json_string(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn main() {
    if env::args().any(|a| a == "--sleeper") {
        thread::sleep(Duration::from_secs(600));
        return;
    }
    let token = env::var("NAVVIED_SERVE_TOKEN").unwrap_or_default();
    let args: Vec<String> = env::args().collect();
    let value = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let port: u16 = value("--port").and_then(|p| p.parse().ok()).unwrap_or(0);
    let cwd = value("--cwd").unwrap_or_default();
    let launch = count_launch();
    if let Ok(f) = env::var("FAKE_PID_FILE") {
        let _ = fs::write(f, process::id().to_string());
    }
    let first_n = |name: &str| env::var(name).ok().and_then(|v| v.parse::<u32>().ok()).is_some_and(|n| launch <= n);

    if flag("FAKE_LEAK_TOKEN") {
        eprintln!("debug: starting with key {token}");
        println!("debug: key is {token}");
    }
    if flag("FAKE_EXIT_AT_ONCE") || first_n("FAKE_FAIL_FIRST_N") {
        process::exit(3);
    }
    if let Ok(file) = env::var("FAKE_GRANDCHILD_FILE") {
        let mut child = process::Command::new(env::current_exe().unwrap()).arg("--sleeper").stdin(process::Stdio::null()).spawn().unwrap();
        let _ = fs::write(file, child.id().to_string());
        thread::spawn(move || {
            let _ = child.wait();
        });
    }
    let listener = match TcpListener::bind(("127.0.0.1", port)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("error: could not listen: {e}");
            process::exit(1);
        }
    };
    let real_port = listener.local_addr().unwrap().port();
    if !flag("FAKE_IGNORE_STDIN") {
        thread::spawn(|| {
            let mut sink = Vec::new();
            let _ = std::io::stdin().read_to_end(&mut sink);
            process::exit(0);
        });
    } else {
        thread::spawn(|| loop {
            thread::sleep(Duration::from_secs(60));
        });
    }
    if first_n("FAKE_CRASH_FIRST_N") {
        thread::spawn(|| {
            thread::sleep(Duration::from_millis(150));
            process::exit(9);
        });
    }
    if let Some(ms) = env::var("FAKE_CRASH_AFTER_MS").ok().and_then(|v| v.parse::<u64>().ok()) {
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(ms));
            process::exit(9);
        });
    }
    if !flag("FAKE_NO_READY") {
        eprintln!(r#"navvied-ready {{"port":{real_port}}}"#);
    }
    for stream in listener.incoming().flatten() {
        let (t, c) = (token.clone(), cwd.clone());
        thread::spawn(move || handle(stream, t, c));
    }
}
