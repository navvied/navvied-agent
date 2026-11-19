//! A small WebSocket client for the loopback address: the app listens to what the program says (for notices and the
//! tray) and can send it a command (stop the current task). Text frames only, which is all the protocol uses.

use crate::http::loopback;
use crate::sha1::{base64, sha1};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const KEY_PROTOCOL: &str = "navvied-key.";
const MAX_FRAME: u64 = 16 * 1024 * 1024;
/// Once a frame has started, the rest must follow within this long.
const FRAME_BODY_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub struct Writer(Arc<Mutex<TcpStream>>);

impl Writer {
    /// One masked text frame, as a client must send.
    pub fn send_text(&self, text: &str) -> io::Result<()> {
        self.frame(0x1, text.as_bytes())
    }

    fn frame(&self, opcode: u8, payload: &[u8]) -> io::Result<()> {
        let mut mask = [0u8; 4];
        getrandom::fill(&mut mask).map_err(|e| io::Error::other(e.to_string()))?;
        let mut out = vec![0x80 | opcode];
        match payload.len() {
            n if n < 126 => out.push(0x80 | n as u8),
            n if n <= 0xFFFF => {
                out.push(0x80 | 126);
                out.extend_from_slice(&(n as u16).to_be_bytes());
            }
            n => {
                out.push(0x80 | 127);
                out.extend_from_slice(&(n as u64).to_be_bytes());
            }
        }
        out.extend_from_slice(&mask);
        out.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
        self.0.lock().unwrap_or_else(|e| e.into_inner()).write_all(&out)
    }

    pub fn close(&self) {
        let _ = self.frame(0x8, &[]);
        let _ = self.0.lock().unwrap_or_else(|e| e.into_inner()).shutdown(std::net::Shutdown::Both);
    }
}

pub struct Reader {
    inner: BufReader<TcpStream>,
    raw: TcpStream,
    writer: Writer,
}

/// Connects, proves the other side speaks WebSocket and carries on after `since` (0 for everything kept).
pub fn connect(port: u16, key: &str, since: u64, timeout: Duration) -> io::Result<(Reader, Writer)> {
    let stream = TcpStream::connect_timeout(&loopback(port), timeout)?;
    stream.set_nodelay(true)?;
    stream.set_read_timeout(Some(timeout))?;
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce).map_err(|e| io::Error::other(e.to_string()))?;
    let nonce = base64(&nonce);
    let protocol = format!("{KEY_PROTOCOL}{key}");
    let mut w = stream.try_clone()?;
    write!(
        w,
        "GET /ws?since={since} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {nonce}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: {protocol}\r\n\r\n"
    )?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut status = String::new();
    reader.read_line(&mut status)?;
    if !status.contains(" 101 ") {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, format!("the program refused the connection: {}", status.trim())));
    }
    let want = base64(&sha1(format!("{nonce}{GUID}").as_bytes()));
    let mut accepted = false;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line)?;
        if line.trim().is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            accepted |= k.trim().eq_ignore_ascii_case("sec-websocket-accept") && v.trim() == want;
        }
    }
    if !accepted {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "the handshake answer was wrong"));
    }
    let writer = Writer(Arc::new(Mutex::new(w)));
    Ok((Reader { inner: reader, raw: stream, writer: writer.clone() }, writer))
}

impl Reader {
    /// The next text message. `Ok(None)` means nothing arrived within `wait`; an error means the connection ended.
    pub fn next(&mut self, wait: Duration) -> io::Result<Option<String>> {
        self.raw.set_read_timeout(Some(wait.max(Duration::from_millis(1))))?;
        match self.inner.fill_buf() {
            Ok([]) => return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "closed")),
            Ok(_) => {}
            Err(e) if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => return Ok(None),
            Err(e) => return Err(e),
        }
        self.raw.set_read_timeout(Some(FRAME_BODY_TIMEOUT))?;
        let mut message: Vec<u8> = Vec::new();
        loop {
            let mut head = [0u8; 2];
            self.inner.read_exact(&mut head)?;
            let (fin, opcode, masked) = (head[0] & 0x80 != 0, head[0] & 0x0F, head[1] & 0x80 != 0);
            let len = match head[1] & 0x7F {
                126 => {
                    let mut b = [0u8; 2];
                    self.inner.read_exact(&mut b)?;
                    u64::from(u16::from_be_bytes(b))
                }
                127 => {
                    let mut b = [0u8; 8];
                    self.inner.read_exact(&mut b)?;
                    u64::from_be_bytes(b)
                }
                n => u64::from(n),
            };
            if len > MAX_FRAME {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "a frame was too large"));
            }
            let mut mask = [0u8; 4];
            if masked {
                self.inner.read_exact(&mut mask)?;
            }
            let mut payload = vec![0u8; len as usize];
            self.inner.read_exact(&mut payload)?;
            if masked {
                payload.iter_mut().enumerate().for_each(|(i, b)| *b ^= mask[i % 4]);
            }
            match opcode {
                0x0..=0x2 => {
                    if message.len() as u64 + len > MAX_FRAME {
                        return Err(io::Error::new(io::ErrorKind::InvalidData, "a message was too large"));
                    }
                    message.extend_from_slice(&payload);
                    if fin {
                        return Ok(Some(String::from_utf8_lossy(&message).into_owned()));
                    }
                }
                0x8 => return Err(io::Error::new(io::ErrorKind::ConnectionAborted, "closed")),
                0x9 => self.writer.frame(0xA, &payload)?,
                _ => {}
            }
        }
    }
}
