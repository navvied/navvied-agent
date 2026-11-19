//! The one-time key that lets the window talk to the program inside the app.

use std::fmt;

const URL_SAFE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Unpadded base64url, the alphabet the program's key check and a WebSocket subprotocol both accept.
pub fn base64url(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..=chunk.len() {
            out.push(URL_SAFE[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
}

/// A secret. It cannot be printed by accident: `Debug` hides it and there is no `Display`.
#[derive(Clone, PartialEq, Eq)]
pub struct Token(String);

impl Token {
    /// 24 random bytes from the operating system.
    pub fn generate() -> std::io::Result<Token> {
        let mut raw = [0u8; 24];
        getrandom::fill(&mut raw).map_err(|e| std::io::Error::other(e.to_string()))?;
        Ok(Token(base64url(&raw)))
    }

    /// For tests and for restoring a key the program was started with.
    pub fn from_string(text: String) -> Option<Token> {
        let ok = (8..=512).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_alphanumeric() || b"._~+-".contains(&b));
        ok.then_some(Token(text))
    }

    /// The only way to read it. Call sites are the few places that must hand it on.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Token(<hidden>)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_token_is_32_url_safe_characters_and_never_repeats() {
        let a = Token::generate().unwrap();
        let b = Token::generate().unwrap();
        assert_ne!(a, b);
        assert_eq!(a.expose().len(), 32);
        assert!(a.expose().bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'));
        assert!(Token::from_string(a.expose().to_owned()).is_some(), "the program must accept what is generated");
    }

    #[test]
    fn debug_never_shows_it() {
        let t = Token::generate().unwrap();
        assert!(!format!("{t:?}").contains(t.expose()));
    }

    #[test]
    fn base64url_matches_known_values() {
        assert_eq!(base64url(b""), "");
        assert_eq!(base64url(b"f"), "Zg");
        assert_eq!(base64url(b"fo"), "Zm8");
        assert_eq!(base64url(b"foo"), "Zm9v");
        assert_eq!(base64url(&[0xfb, 0xff]), "-_8");
    }

    #[test]
    fn odd_keys_are_refused() {
        assert!(Token::from_string("short".into()).is_none());
        assert!(Token::from_string("has space in it!".into()).is_none());
    }
}
