//! What tests of this side start from: a database with the API's schema, and a configuration.
//! Built only with the `testing` feature, which no build that serves has.

use std::path::Path;

use serde_json::{Value, json};

use crate::config::{self, Config, DbConfig, Dialect};
use crate::db::Db;

/// The statements of a migration file, as the API's migrator splits one (src/db/migrator.ts).
fn statements(script: &str) -> Vec<String> {
    let kept: Vec<&str> = script.lines().filter(|line| !line.trim().starts_with("--")).collect();
    let mut found = vec![];
    let mut statement = String::new();
    for line in kept {
        statement.push_str(line);
        statement.push('\n');
        if line.trim_end().ends_with(';') {
            let text = statement.trim().trim_end_matches(';').trim().to_owned();
            if !text.is_empty() {
                found.push(text);
            }
            statement.clear();
        }
    }
    if !statement.trim().is_empty() {
        found.push(statement.trim().to_owned());
    }
    found
}

/// Brings a database's schema up to date as the API does: every migration of
/// src/db/migrations, in the order of their names, each recorded as Kysely records it.
pub async fn migrate(db: &Db) {
    let dir = Path::new(env!("EVIEVERSE_MIGRATIONS"));
    let mut files: Vec<_> = std::fs::read_dir(dir)
        .unwrap_or_else(|err| panic!("the migrations are not at {}: {err}", dir.display()))
        .filter_map(|entry| Some(entry.ok()?.path()))
        .filter(|path| path.extension().is_some_and(|ext| ext == "sql"))
        .collect();
    files.sort();
    db.execute(
        "CREATE TABLE IF NOT EXISTS kysely_migration (name varchar(255) PRIMARY KEY, timestamp varchar(255) NOT NULL)",
        &[],
    )
    .await
    .unwrap();
    for file in files {
        let name = file.file_stem().unwrap().to_string_lossy().into_owned();
        let script = std::fs::read_to_string(&file).unwrap();
        for statement in statements(&script) {
            db.execute(&statement, &[])
                .await
                .unwrap_or_else(|err| panic!("{name} failed at:\n{statement}\n{err:#}"));
        }
        db.execute("INSERT INTO kysely_migration (name, timestamp) VALUES (?, ?)", crate::params![name, "test"])
            .await
            .unwrap();
    }
}

/// A SQLite database of its own in `dir`, with the API's schema.
pub async fn database(dir: &Path) -> Db {
    let db = Db::connect(&DbConfig {
        dialect: Dialect::Sqlite,
        url: dir.join("test.sqlite").to_string_lossy().into_owned(),
        pool_size: 1,
        idle_timeout_ms: None,
        migrate_on_start: false,
    })
    .await
    .unwrap();
    migrate(&db).await;
    db
}

/// The configuration of a server that keeps everything under `dir` and sets `settings` (as
/// a configuration file has them) and nothing else.
pub fn config(dir: &Path, settings: Value) -> Config {
    let at = |name: &str| dir.join(name).to_string_lossy().into_owned();
    let mut all = json!({
        "redis": { "url": "redis://127.0.0.1:6379" },
        "db": { "dialect": "sqlite", "url": at("test.sqlite") },
        "storage": { "content": { "scheme": "fs", "options": { "root": at("content") } } },
    });
    merge(&mut all, &settings);
    config::load_with(&all, &|_| None, dir).unwrap_or_else(|err| panic!("{err:#}"))
}

fn merge(into: &mut Value, from: &Value) {
    match (into, from) {
        (Value::Object(into), Value::Object(from)) => {
            for (name, value) in from {
                merge(into.entry(name.clone()).or_insert(Value::Null), value);
            }
        }
        (into, from) => *into = from.clone(),
    }
}

/// A user, as a row of `users`: enough of one for what reads their id, name and roles.
pub async fn user(db: &Db, id: &str, username: &str, admin: bool) {
    db.execute(
        "INSERT INTO users (id, username, admin, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        crate::params![id, username, admin, 1_i64, 1_i64],
    )
    .await
    .unwrap_or_else(|err| panic!("{err:#}"));
}
