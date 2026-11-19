//! Replaces secrets in text before it is written anywhere.

use std::sync::RwLock;

const MARK: &str = "[key]";
/// A shorter value would replace ordinary words.
const MIN_SECRET: usize = 8;

#[derive(Default)]
pub struct Redactor {
    secrets: RwLock<Vec<String>>,
}

impl Redactor {
    pub fn new() -> Redactor {
        Redactor::default()
    }

    pub fn add(&self, secret: &str) {
        if secret.len() >= MIN_SECRET {
            let mut all = self.secrets.write().unwrap_or_else(|e| e.into_inner());
            if !all.iter().any(|s| s == secret) {
                all.push(secret.to_owned());
            }
        }
    }

    pub fn clean(&self, text: &str) -> String {
        let all = self.secrets.read().unwrap_or_else(|e| e.into_inner());
        all.iter().fold(text.to_owned(), |acc, s| acc.replace(s.as_str(), MARK))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_secret_is_replaced_wherever_it_sits() {
        let r = Redactor::new();
        r.add("s3cretvalue-123");
        assert_eq!(r.clean("key s3cretvalue-123 and navvied-key.s3cretvalue-123"), "key [key] and navvied-key.[key]");
    }

    #[test]
    fn short_values_are_never_treated_as_secrets() {
        let r = Redactor::new();
        r.add("abc");
        assert_eq!(r.clean("abc abc"), "abc abc");
    }
}
