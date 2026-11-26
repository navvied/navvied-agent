//! Turns what the program says (one JSON event per line) into what the person should be told: a notice when a long
//! task is done or an answer is needed, and what the tray shows while the program works.

use std::time::Duration;

/// A notice never carries file contents. A path or command title only appears when details are switched on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Notice {
    Finished,
    NeedsYou { detail: Option<String> },
    /// The agent asked the person something; `detail` is its first question.
    Question { detail: Option<String> },
}

impl Notice {
    pub fn text(&self) -> (&'static str, String) {
        match self {
            Notice::Finished => ("navvied finished", "Your task is done. Open navvied to read the answer.".to_owned()),
            Notice::NeedsYou { detail: Some(d) } => ("navvied needs you", format!("It asks to: {d}")),
            Notice::Question { detail: Some(q) } => ("navvied needs you", format!("A question: {q}")),
            Notice::NeedsYou { detail: None } | Notice::Question { detail: None } => ("navvied needs you", "It needs an answer before it can go on.".to_owned()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Activity {
    pub working: bool,
    /// The start of the request, only when details are on.
    pub title: Option<String>,
    pub since: Option<Duration>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Update {
    Notice(Notice),
    Activity(Activity),
}

#[derive(Debug, Clone)]
pub struct Settings {
    pub notices: bool,
    pub details: bool,
    /// A task shorter than this ends without a notice.
    pub min_task: Duration,
}

impl Default for Settings {
    fn default() -> Settings {
        Settings { notices: true, details: true, min_task: Duration::from_secs(30) }
    }
}

pub struct Tracker {
    pub settings: Settings,
    working_since: Option<Duration>,
    prompt: Option<String>,
}

/// One line, no control characters, never longer than `max` characters.
fn tidy(text: &str, max: usize) -> String {
    let flat: String = text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let flat = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > max {
        format!("{}…", flat.chars().take(max - 1).collect::<String>())
    } else {
        flat
    }
}

impl Tracker {
    pub fn new(settings: Settings) -> Tracker {
        Tracker { settings, working_since: None, prompt: None }
    }

    pub fn activity(&self) -> Activity {
        Activity {
            working: self.working_since.is_some(),
            title: self.working_since.and(self.prompt.clone()).filter(|_| self.settings.details),
            since: self.working_since,
        }
    }

    /// `now` is the time since the app started, supplied by the caller so tests need no clock.
    pub fn feed(&mut self, line: &str, now: Duration) -> Vec<Update> {
        let Ok(json) = serde_json::from_str::<serde_json::Value>(line) else { return Vec::new() };
        let field = |k: &str| json.get(k).and_then(|v| v.as_str());
        match field("ev") {
            Some("user") => {
                self.prompt = field("text").map(|t| tidy(t, 60));
                Vec::new()
            }
            Some("taken") if self.working_since.is_none() => {
                self.working_since = Some(now);
                vec![Update::Activity(self.activity())]
            }
            Some("done") => {
                let started = self.working_since.take();
                let mut out = vec![Update::Activity(self.activity())];
                let long = started.is_some_and(|s| now.saturating_sub(s) >= self.settings.min_task);
                if self.settings.notices && long && field("stop") == Some("end_turn") {
                    out.push(Update::Notice(Notice::Finished));
                }
                out
            }
            Some("approval") if self.settings.notices => {
                let detail = field("title").map(|t| tidy(t, 120)).filter(|t| !t.is_empty() && self.settings.details);
                vec![Update::Notice(Notice::NeedsYou { detail })]
            }
            Some("question") if self.settings.notices => {
                let first = json.get("questions").and_then(|q| q.get(0)).and_then(|q| q.get("question")).and_then(|v| v.as_str());
                let detail = first.map(|t| tidy(t, 120)).filter(|t| !t.is_empty() && self.settings.details);
                vec![Update::Notice(Notice::Question { detail })]
            }
            _ => Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    fn notices(updates: Vec<Update>) -> Vec<Notice> {
        updates.into_iter().filter_map(|u| if let Update::Notice(n) = u { Some(n) } else { None }).collect()
    }

    #[test]
    fn a_long_task_that_ends_well_gives_one_notice() {
        let mut t = Tracker::new(Settings::default());
        t.feed(r#"{"ev":"taken","qid":"a"}"#, s(10));
        assert_eq!(notices(t.feed(r#"{"ev":"done","stop":"end_turn"}"#, s(100))), vec![Notice::Finished]);
    }

    #[test]
    fn a_short_task_gives_none() {
        let mut t = Tracker::new(Settings::default());
        t.feed(r#"{"ev":"taken","qid":"a"}"#, s(10));
        assert!(notices(t.feed(r#"{"ev":"done","stop":"end_turn"}"#, s(20))).is_empty());
    }

    #[test]
    fn a_cancelled_or_failed_task_gives_none() {
        for stop in ["cancelled", "error"] {
            let mut t = Tracker::new(Settings::default());
            t.feed(r#"{"ev":"taken","qid":"a"}"#, s(0));
            assert!(notices(t.feed(&format!(r#"{{"ev":"done","stop":"{stop}"}}"#), s(500))).is_empty());
        }
    }

    #[test]
    fn an_approval_asks_for_the_person() {
        let mut t = Tracker::new(Settings::default());
        let n = notices(t.feed(r#"{"ev":"approval","id":"1","title":"Edit src/a.ts","options":[]}"#, s(1)));
        assert_eq!(n, vec![Notice::NeedsYou { detail: Some("Edit src/a.ts".into()) }]);
        assert_eq!(n[0].text(), ("navvied needs you", "It asks to: Edit src/a.ts".to_owned()));
    }

    #[test]
    fn a_question_asks_for_the_person_with_the_first_question_in_the_words_of_the_card() {
        let mut t = Tracker::new(Settings::default());
        let line = r#"{"ev":"question","id":"q1","questions":[{"question":"Which folder\n\u0007should I use?","choices":["a","b"]},{"question":"Second?"}]}"#;
        let n = notices(t.feed(line, s(1)));
        assert_eq!(n, vec![Notice::Question { detail: Some("Which folder should I use?".into()) }]);
        assert_eq!(n[0].text(), ("navvied needs you", "A question: Which folder should I use?".to_owned()));
    }

    #[test]
    fn a_long_question_is_shortened_and_a_question_with_no_words_still_asks() {
        let mut t = Tracker::new(Settings::default());
        let long = "b".repeat(500);
        let n = notices(t.feed(&format!(r#"{{"ev":"question","id":"q","questions":[{{"question":"{long}"}}]}}"#), s(1)));
        let Notice::Question { detail: Some(d) } = &n[0] else { panic!() };
        assert_eq!(d.chars().count(), 120);
        for line in [r#"{"ev":"question","id":"q","questions":[]}"#, r#"{"ev":"question","id":"q"}"#, r#"{"ev":"question","id":"q","questions":[{"question":""}]}"#] {
            assert_eq!(notices(t.feed(line, s(2))), vec![Notice::Question { detail: None }]);
        }
    }

    #[test]
    fn without_details_no_name_or_path_is_carried() {
        let mut t = Tracker::new(Settings { details: false, ..Settings::default() });
        t.feed(r#"{"ev":"user","text":"fix secrets.env please"}"#, s(0));
        t.feed(r#"{"ev":"taken"}"#, s(0));
        assert_eq!(t.activity().title, None);
        let n = notices(t.feed(r#"{"ev":"approval","id":"1","title":"Edit secrets.env"}"#, s(1)));
        assert_eq!(n, vec![Notice::NeedsYou { detail: None }]);
        assert!(!n[0].text().1.contains("secrets"));
        let q = notices(t.feed(r#"{"ev":"question","id":"2","questions":[{"question":"Delete secrets.env?"}]}"#, s(1)));
        assert_eq!(q, vec![Notice::Question { detail: None }]);
        assert!(!q[0].text().1.contains("secrets"));
    }

    #[test]
    fn notices_off_gives_none_at_all() {
        let mut t = Tracker::new(Settings { notices: false, ..Settings::default() });
        t.feed(r#"{"ev":"taken"}"#, s(0));
        assert!(notices(t.feed(r#"{"ev":"approval","id":"1","title":"x"}"#, s(1))).is_empty());
        assert!(notices(t.feed(r#"{"ev":"question","id":"1","questions":[{"question":"x"}]}"#, s(1))).is_empty());
        assert!(notices(t.feed(r#"{"ev":"done","stop":"end_turn"}"#, s(900))).is_empty());
    }

    #[test]
    fn activity_follows_the_turn_and_shortens_the_title() {
        let mut t = Tracker::new(Settings::default());
        let long = "a".repeat(200);
        t.feed(&format!(r#"{{"ev":"user","text":"{long}\n\u0007x"}}"#), s(0));
        let up = t.feed(r#"{"ev":"taken"}"#, s(5));
        let Update::Activity(a) = &up[0] else { panic!() };
        assert!(a.working && a.since == Some(s(5)));
        assert_eq!(a.title.as_ref().unwrap().chars().count(), 60);
        assert!(!a.title.as_ref().unwrap().chars().any(char::is_control));
        t.feed(r#"{"ev":"done","stop":"end_turn"}"#, s(6));
        assert!(!t.activity().working);
    }

    #[test]
    fn junk_and_unknown_events_are_ignored() {
        let mut t = Tracker::new(Settings::default());
        for line in ["", "not json", "{}", r#"{"ev":"text","text":"hi"}"#, r#"{"ev":7}"#] {
            assert!(t.feed(line, s(1)).is_empty());
        }
    }
}
