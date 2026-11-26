//! The log: what a process tells its operator, as the API tells it (pino): one line of JSON
//! for each thing said, with its level as a number, the time in milliseconds, what it is
//! about as fields, and the message last.
//!
//! A `Logger` is handed to whatever has something to say. Where it goes is its sink's to
//! know: the standard output of a process of its own, or a list that whoever called keeps,
//! which is how what a trust plugin says inside the API reaches the log of the request it is
//! said for.

use std::io::Write;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::{Map, Value, json};

/// How much a line matters, with pino's numbers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub enum Level {
    Trace = 10,
    Debug = 20,
    Info = 30,
    Warn = 40,
    Error = 50,
    Fatal = 60,
}

impl Level {
    /// The level a setting names (`logLevel`); none for `silent`, which says nothing, and
    /// `info` for a word that is no level.
    pub fn named(name: &str) -> Option<Self> {
        match name.to_ascii_lowercase().as_str() {
            "silent" => None,
            "trace" => Some(Self::Trace),
            "debug" => Some(Self::Debug),
            "warn" => Some(Self::Warn),
            "error" => Some(Self::Error),
            "fatal" => Some(Self::Fatal),
            _ => Some(Self::Info),
        }
    }

    /// The level by the name pino gives it.
    pub fn name(self) -> &'static str {
        match self {
            Self::Trace => "trace",
            Self::Debug => "debug",
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
            Self::Fatal => "fatal",
        }
    }
}

/// One thing said: its level, what it is about, and the message.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Entry {
    pub level: Level,
    pub fields: Map<String, Value>,
    pub msg: String,
}

/// Where what is said goes.
pub trait Sink: Send + Sync {
    fn write(&self, entry: Entry);
}

/// The standard output, a line of JSON for each entry, as pino writes one.
struct Stdout {
    pid: u32,
    hostname: String,
}

impl Sink for Stdout {
    fn write(&self, entry: Entry) {
        let mut line = Map::new();
        line.insert("level".to_owned(), json!(entry.level as u8));
        line.insert("time".to_owned(), json!(crate::time::system_now()));
        line.insert("pid".to_owned(), json!(self.pid));
        line.insert("hostname".to_owned(), json!(self.hostname));
        for (name, value) in entry.fields {
            line.insert(name, value);
        }
        line.insert("msg".to_owned(), json!(entry.msg));
        // One write for the line, so two tasks' lines never mix. A closed output is nobody's to tell.
        let mut text = Value::Object(line).to_string();
        text.push('\n');
        let _ = std::io::stdout().lock().write_all(text.as_bytes());
    }
}

/// A list of what was said, for whoever asked to read afterwards.
#[derive(Default)]
pub struct Collected(Mutex<Vec<Entry>>);

impl Collected {
    /// What was said since this was last asked, which it then holds no more.
    pub fn take(&self) -> Vec<Entry> {
        std::mem::take(&mut *self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()))
    }
}

impl Sink for Collected {
    fn write(&self, entry: Entry) {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).push(entry);
    }
}

/// What a process says with. A copy says to the same place.
#[derive(Clone)]
pub struct Logger {
    sink: Option<Arc<dyn Sink>>,
    /// What is less than this is not said.
    min: Level,
    /// Fields every line has, as a child logger of pino's has its bindings.
    bound: Map<String, Value>,
}

impl Logger {
    /// A logger that writes the standard output, from the level the settings name.
    pub fn stdout(level: &str) -> Self {
        let Some(min) = Level::named(level) else { return Self::none() };
        let hostname = std::env::var("HOSTNAME")
            .ok()
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "localhost".to_owned());
        Self {
            sink: Some(Arc::new(Stdout {
                pid: std::process::id(),
                hostname,
            })),
            min,
            bound: Map::new(),
        }
    }

    /// A logger that says nothing.
    pub fn none() -> Self {
        Self {
            sink: None,
            min: Level::Fatal,
            bound: Map::new(),
        }
    }

    /// A logger that keeps what is said, every level of it, and the list it keeps it in.
    pub fn collecting() -> (Self, Arc<Collected>) {
        let collected = Arc::new(Collected::default());
        (Self::to(collected.clone()), collected)
    }

    /// A logger that says everything to a sink.
    pub fn to(sink: Arc<dyn Sink>) -> Self {
        Self {
            sink: Some(sink),
            min: Level::Trace,
            bound: Map::new(),
        }
    }

    /// This logger, with fields that every line of it then has.
    pub fn with(&self, fields: Value) -> Self {
        let mut child = self.clone();
        if let Value::Object(fields) = fields {
            child.bound.extend(fields);
        }
        child
    }

    /// Says one thing: `fields` is an object of what it is about, or null for nothing.
    pub fn log(&self, level: Level, fields: Value, msg: &str) {
        let Some(sink) = &self.sink else { return };
        if level < self.min {
            return;
        }
        let mut all = self.bound.clone();
        if let Value::Object(fields) = fields {
            all.extend(fields);
        }
        sink.write(Entry {
            level,
            fields: all,
            msg: msg.to_owned(),
        });
    }

    pub fn debug(&self, fields: Value, msg: &str) {
        self.log(Level::Debug, fields, msg);
    }

    pub fn info(&self, fields: Value, msg: &str) {
        self.log(Level::Info, fields, msg);
    }

    pub fn warn(&self, fields: Value, msg: &str) {
        self.log(Level::Warn, fields, msg);
    }

    pub fn error(&self, fields: Value, msg: &str) {
        self.log(Level::Error, fields, msg);
    }
}

/// An error as a line's `err` field holds one: its message, with what caused it.
pub fn err(error: &anyhow::Error) -> Value {
    json!({ "type": "Error", "message": format!("{error:#}") })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_what_is_said_with_the_fields_it_is_bound_to() {
        let (log, said) = Logger::collecting();
        let child = log.with(json!({ "run": 7 }));
        child.warn(json!({ "list": "*" }), "slow");
        log.info(Value::Null, "plain");
        let entries = said.take();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].level, Level::Warn);
        assert_eq!(Value::Object(entries[0].fields.clone()), json!({ "run": 7, "list": "*" }));
        assert_eq!(entries[1].msg, "plain");
        assert!(said.take().is_empty());
    }

    #[test]
    fn says_nothing_under_its_level() {
        assert_eq!(Level::named("silent"), None);
        assert_eq!(Level::named("WARN"), Some(Level::Warn));
        assert_eq!(Level::named("nonsense"), Some(Level::Info));
        Logger::none().error(Value::Null, "unheard");
    }
}
