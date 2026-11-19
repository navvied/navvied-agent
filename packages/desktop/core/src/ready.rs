//! The one line the program prints when it is listening.

const PREFIX: &str = "navvied-ready ";

/// `navvied-ready {"port":51234}` gives 51234. Anything else is not the ready line.
pub fn parse_ready(line: &str) -> Option<u16> {
    let json: serde_json::Value = serde_json::from_str(line.trim().strip_prefix(PREFIX)?).ok()?;
    let port = json.get("port")?.as_u64()?;
    u16::try_from(port).ok().filter(|p| *p > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ready_line_gives_the_port() {
        assert_eq!(parse_ready(r#"navvied-ready {"port":51234}"#), Some(51234));
        assert_eq!(parse_ready("navvied-ready {\"port\":8787}\n"), Some(8787));
    }

    #[test]
    fn anything_else_is_not_ready() {
        for line in [
            "",
            "navvied is listening.",
            "navvied-ready",
            r#"navvied-ready {"port":0}"#,
            r#"navvied-ready {"port":70000}"#,
            r#"navvied-ready {"port":"x"}"#,
            r#"x navvied-ready {"port":1}"#,
        ] {
            assert_eq!(parse_ready(line), None, "{line}");
        }
    }
}
