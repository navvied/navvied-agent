//! A tiny HTTP client for the loopback address. It only ever talks to the program this app started.

use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::time::Duration;

pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl Reply {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

pub fn loopback(port: u16) -> SocketAddr {
    SocketAddr::from((Ipv4Addr::LOCALHOST, port))
}

/// One GET with the key in a header, never in the address.
pub fn get(port: u16, path: &str, bearer: Option<&str>, timeout: Duration) -> io::Result<Reply> {
    let mut stream = TcpStream::connect_timeout(&loopback(port), timeout)?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    let auth = bearer.map(|b| format!("Authorization: Bearer {b}\r\n")).unwrap_or_default();
    write!(stream, "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{auth}Connection: close\r\n\r\n")?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw)?;
    parse_reply(&String::from_utf8_lossy(&raw))
}

fn parse_reply(text: &str) -> io::Result<Reply> {
    let bad = || io::Error::new(io::ErrorKind::InvalidData, "not an HTTP reply");
    let (head, body) = text.split_once("\r\n\r\n").ok_or_else(bad)?;
    let mut lines = head.lines();
    let status = lines.next().and_then(|l| l.split_whitespace().nth(1)).and_then(|s| s.parse().ok()).ok_or_else(bad)?;
    let headers: Vec<(String, String)> = lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_owned(), v.trim().to_owned())).collect();
    let chunked = headers.iter().any(|(k, v)| k.eq_ignore_ascii_case("transfer-encoding") && v.eq_ignore_ascii_case("chunked"));
    Ok(Reply { status, headers, body: if chunked { dechunk(body) } else { body.to_owned() } })
}

fn dechunk(mut rest: &str) -> String {
    let mut out = String::new();
    while let Some((size, after)) = rest.split_once("\r\n") {
        let Ok(n) = usize::from_str_radix(size.split(';').next().unwrap_or("").trim(), 16) else { break };
        if n == 0 || after.len() < n {
            break;
        }
        out.push_str(&after[..n]);
        rest = after[n..].trim_start_matches("\r\n");
    }
    out
}

/// What the program says about itself at `/api/info`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Info {
    pub version: String,
    pub model: Option<String>,
    pub cwd: String,
}

pub fn probe_info(port: u16, token: &str, timeout: Duration) -> io::Result<Info> {
    let reply = get(port, "/api/info", Some(token), timeout)?;
    if reply.status != 200 {
        return Err(io::Error::other(format!("the program answered {}", reply.status)));
    }
    let json: serde_json::Value = serde_json::from_str(&reply.body).map_err(io::Error::other)?;
    let text = |k: &str| json.get(k).and_then(|v| v.as_str()).map(str::to_owned);
    Ok(Info { version: text("version").unwrap_or_default(), model: text("model"), cwd: text("cwd").unwrap_or_default() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_reply_is_split_into_status_headers_and_body() {
        let r = parse_reply("HTTP/1.1 200 OK\r\nX-Navvied: 1\r\nContent-Length: 2\r\n\r\nhi").unwrap();
        assert_eq!((r.status, r.body.as_str(), r.header("x-navvied")), (200, "hi", Some("1")));
    }

    #[test]
    fn a_chunked_body_is_joined() {
        let r = parse_reply("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n").unwrap();
        assert_eq!(r.body, "hello world");
    }

    #[test]
    fn rubbish_is_an_error() {
        assert!(parse_reply("nope").is_err());
    }
}
