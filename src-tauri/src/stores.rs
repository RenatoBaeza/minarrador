//! The three list stores beside settings.json: quick-copy shorthands, to-do
//! tasks and the dictation archive.
//!
//! Each is its own file because the settings store coerces every value against
//! a scalar default, and a list of records does not fit that shape. Each has one
//! `normalize` gate that runs on the file and on whatever a window sends.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use crate::types::{Dictation, Snippet, Todo};

pub(crate) fn write_atomic<T: Serialize>(file: &Path, value: &T) {
    if let Some(dir) = file.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let tmp = file.with_extension("json.tmp");
    if let Ok(text) = serde_json::to_string_pretty(value) {
        if fs::write(&tmp, text).is_ok() {
            let _ = fs::rename(&tmp, file);
        }
    }
}

fn read_value(file: &Path) -> Value {
    fs::read_to_string(file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null)
}

/// A cached list behind one JSON file.
pub struct ListStore<T> {
    file: PathBuf,
    items: Mutex<Vec<T>>,
    normalize: fn(&Value) -> Vec<T>,
}

impl<T: Clone + Serialize + DeserializeOwned> ListStore<T> {
    pub fn open(file: PathBuf, normalize: fn(&Value) -> Vec<T>) -> Self {
        let items = normalize(&read_value(&file));
        ListStore { file, items: Mutex::new(items), normalize }
    }

    pub fn list(&self) -> Vec<T> {
        self.items.lock().unwrap().clone()
    }

    pub fn save(&self, value: &Value) -> Vec<T> {
        let next = (self.normalize)(value);
        write_atomic(&self.file, &next);
        *self.items.lock().unwrap() = next.clone();
        next
    }

    fn replace(&self, next: Vec<T>) -> Vec<T> {
        write_atomic(&self.file, &next);
        *self.items.lock().unwrap() = next.clone();
        next
    }
}

fn str_field<'a>(o: &'a Value, key: &str) -> Option<&'a str> {
    o.get(key).and_then(Value::as_str)
}

fn take(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

fn flat(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub mod snippets {
    use super::*;
    pub const COUNT: usize = 40;
    pub const LABEL: usize = 60;
    pub const TEXT: usize = 20_000;

    /// Keeps only `{label, text}`; a shorthand with nothing to copy is a dead
    /// menu row, so it is dropped. The text is copied verbatim — indentation and
    /// trailing newlines are often the point.
    pub fn normalize(stored: &Value) -> Vec<Snippet> {
        let Some(items) = stored.as_array() else { return vec![] };
        items
            .iter()
            .filter(|i| i.is_object())
            .filter_map(|i| {
                let text = take(str_field(i, "text").unwrap_or(""), TEXT);
                if text.trim().is_empty() {
                    return None;
                }
                Some(Snippet { label: take(str_field(i, "label").unwrap_or("").trim(), LABEL), text })
            })
            .take(COUNT)
            .collect()
    }
}

pub mod todos {
    use super::*;
    pub const PRIORITIES: [&str; 4] = ["none", "low", "medium", "high"];
    pub const COUNT: usize = 1000;
    pub const TITLE: usize = 200;
    pub const PROJECT: usize = 60;
    pub const DESCRIPTION: usize = 50_000;

    pub fn due_date(value: &str) -> String {
        let re = regex::Regex::new(r"^\d{4}-\d{2}-\d{2}$").unwrap();
        if re.is_match(value) && chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok() {
            value.to_string()
        } else {
            String::new()
        }
    }

    fn timestamp(value: Option<&str>, fallback: &str) -> String {
        match value {
            Some(v) if chrono::DateTime::parse_from_rfc3339(v).is_ok() || chrono::NaiveDate::parse_from_str(v, "%Y-%m-%d").is_ok() => v.into(),
            _ => fallback.into(),
        }
    }

    /// A task needs only a title; unknown priorities and impossible dates fall
    /// back to empty, and duplicate ids are reissued.
    pub fn normalize(stored: &Value) -> Vec<Todo> {
        let Some(items) = stored.as_array() else { return vec![] };
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let mut seen = HashSet::new();
        let mut out = vec![];
        for i in items.iter().filter(|i| i.is_object()) {
            let title = take(&flat(str_field(i, "title").unwrap_or("")), TITLE);
            if title.is_empty() {
                continue;
            }
            let mut id = take(str_field(i, "id").unwrap_or("").trim(), 64);
            if id.is_empty() || seen.contains(&id) {
                id = uuid::Uuid::new_v4().to_string();
            }
            seen.insert(id.clone());
            let priority = str_field(i, "priority").filter(|p| PRIORITIES.contains(p)).unwrap_or("none").to_string();
            let created_at = timestamp(str_field(i, "createdAt"), &now);
            out.push(Todo {
                id,
                title,
                description: take(str_field(i, "description").unwrap_or(""), DESCRIPTION),
                project: take(&flat(str_field(i, "project").unwrap_or("")), PROJECT),
                priority,
                due: due_date(str_field(i, "due").unwrap_or("")),
                done: i.get("done") == Some(&Value::Bool(true)),
                updated_at: timestamp(str_field(i, "updatedAt"), &created_at),
                created_at,
            });
            if out.len() >= COUNT {
                break;
            }
        }
        out
    }
}

pub mod dictations {
    use super::*;
    pub const COUNT: usize = 200;
    pub const TEXT: usize = 20_000;

    pub fn normalize(stored: &Value) -> Vec<Dictation> {
        let Some(items) = stored.as_array() else { return vec![] };
        items
            .iter()
            .filter(|i| i.is_object())
            .filter_map(|i| {
                let text = take(str_field(i, "text").unwrap_or(""), TEXT);
                if text.trim().is_empty() {
                    return None;
                }
                let id = str_field(i, "id").map(str::trim).filter(|s| !s.is_empty()).map(String::from).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                let created_at = str_field(i, "createdAt")
                    .filter(|s| !s.is_empty())
                    .map(String::from)
                    .unwrap_or_else(|| chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
                Some(Dictation { id, text, created_at })
            })
            .take(COUNT)
            .collect()
    }
}

/// Newest first, capped at [`dictations::COUNT`].
impl ListStore<Dictation> {
    pub fn add(&self, text: &str) -> Option<Dictation> {
        let clean = text.trim();
        if clean.is_empty() {
            return None;
        }
        let item = Dictation {
            id: uuid::Uuid::new_v4().to_string(),
            text: take(clean, dictations::TEXT),
            created_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        };
        let mut next = vec![item.clone()];
        next.extend(self.list());
        next.truncate(dictations::COUNT);
        self.replace(next);
        Some(item)
    }

    pub fn update(&self, id: &str, text: &str) -> Option<Vec<Dictation>> {
        if text.trim().is_empty() {
            return None;
        }
        let mut items = self.list();
        let item = items.iter_mut().find(|d| d.id == id)?;
        item.text = take(text, dictations::TEXT);
        Some(self.replace(items))
    }

    pub fn remove(&self, id: &str) -> Option<Vec<Dictation>> {
        let items = self.list();
        if !items.iter().any(|d| d.id == id) {
            return None;
        }
        Some(self.replace(items.into_iter().filter(|d| d.id != id).collect()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn snippets_drop_empty_bodies() {
        let s = snippets::normalize(&json!([{"label": " a ", "text": "  keep  "}, {"label": "b", "text": "   "}, 3, null]));
        assert_eq!(s, vec![Snippet { label: "a".into(), text: "  keep  ".into() }]);
    }

    #[test]
    fn todos_are_coerced() {
        let t = todos::normalize(&json!([
            {"id": "x", "title": " Write  docs ", "priority": "urgent", "due": "2026-02-30"},
            {"id": "x", "title": "dup", "due": "2026-02-28", "done": true},
            {"title": ""}
        ]));
        assert_eq!(t.len(), 2);
        assert_eq!(t[0].title, "Write docs");
        assert_eq!(t[0].priority, "none");
        assert_eq!(t[0].due, "");
        assert_ne!(t[1].id, "x");
        assert_eq!(t[1].due, "2026-02-28");
        assert!(t[1].done);
    }

    #[test]
    fn dictation_archive() {
        let dir = tempfile::tempdir().unwrap();
        let store = ListStore::open(dir.path().join("d.json"), dictations::normalize);
        let a = store.add(" first ").unwrap();
        store.add("second");
        assert_eq!(store.list()[0].text, "second");
        assert!(store.update(&a.id, "edited").is_some());
        assert!(store.update("nope", "x").is_none());
        assert_eq!(store.remove(&a.id).unwrap().len(), 1);
        let again = ListStore::open(dir.path().join("d.json"), dictations::normalize);
        assert_eq!(again.list().len(), 1);
    }
}
