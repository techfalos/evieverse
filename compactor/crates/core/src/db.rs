//! The database, on any of the three dialects the server runs on (SQLite, PostgreSQL, MySQL):
//! the same rows the API reads and writes through Kysely (src/db).
//!
//! A statement is written once, with `?` where a value goes, and with the few words that
//! differ between dialects chosen by `Dialect` (see its methods). What comes back is a `Row`
//! of this module's own, whatever the dialect: whole numbers as `i64`, text as `String`.
//!
//! The schema is the API's to bring up to date (src/db/migrator.ts), never this side's: a
//! process waits until the schema has had the migration it was built with (`SCHEMA`), and
//! then starts.

use std::path::Path;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions, MySqlRow};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgRow};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteRow, SqliteSynchronous};
use sqlx::{AssertSqlSafe, Column, MySql, Postgres, Row as _, Sqlite, ValueRef};

use crate::config::DbConfig;
pub use crate::config::Dialect;

/// The last migration of the schema this was built with: the name of the newest file in
/// src/db/migrations, as Kysely records it once it has run (see build.rs).
pub const SCHEMA: &str = env!("EVIEVERSE_SCHEMA");

/// How long a statement waits for a lock another connection holds on a SQLite file, as the
/// API's own connection does.
const SQLITE_BUSY_TIMEOUT: Duration = Duration::from_millis(5000);

/// How long a statement waits for a connection of the pool. A SQLite pool has one, which a
/// transaction holds for as long as it runs, so the wait is for the transactions before it.
const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(120);

/// A value a statement is given, or a row holds.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    /// No whole number, where one could be.
    NullInt,
    /// No text, where there could be some.
    NullText,
    Int(i64),
    Float(f64),
    Text(String),
    Bytes(Vec<u8>),
}

impl From<i64> for Value {
    fn from(n: i64) -> Self {
        Self::Int(n)
    }
}
impl From<i32> for Value {
    fn from(n: i32) -> Self {
        Self::Int(n.into())
    }
}
/// A flag is a column of 0 or 1.
impl From<bool> for Value {
    fn from(on: bool) -> Self {
        Self::Int(on.into())
    }
}
impl From<&str> for Value {
    fn from(text: &str) -> Self {
        Self::Text(text.to_owned())
    }
}
impl From<&String> for Value {
    fn from(text: &String) -> Self {
        Self::Text(text.clone())
    }
}
impl From<String> for Value {
    fn from(text: String) -> Self {
        Self::Text(text)
    }
}
impl From<Option<i64>> for Value {
    fn from(n: Option<i64>) -> Self {
        n.map_or(Self::NullInt, Self::Int)
    }
}
impl From<Option<&str>> for Value {
    fn from(text: Option<&str>) -> Self {
        text.map_or(Self::NullText, Self::from)
    }
}
impl From<Option<String>> for Value {
    fn from(text: Option<String>) -> Self {
        text.map_or(Self::NullText, Self::Text)
    }
}
impl From<Option<&String>> for Value {
    fn from(text: Option<&String>) -> Self {
        text.map_or(Self::NullText, Self::from)
    }
}

/// The values a statement is given, in the order of its `?`s: `params![id, now]`.
#[macro_export]
macro_rules! params {
    ($($value:expr),* $(,)?) => {
        &[$($crate::db::Value::from($value)),*][..]
    };
}

/// A row of a result: its columns by name, whatever the dialect they came from.
#[derive(Debug, Clone)]
pub struct Row {
    names: Arc<[String]>,
    values: Vec<Value>,
}

impl Row {
    fn value(&self, column: &str) -> Result<&Value> {
        let at = self
            .names
            .iter()
            .position(|name| name == column)
            .with_context(|| format!("the result has no column \"{column}\""))?;
        Ok(&self.values[at])
    }

    /// A whole number, or none where the column holds NULL. A count that the database gives as
    /// text or as a decimal (MySQL's SUM) is read as the number it is.
    pub fn opt_i64(&self, column: &str) -> Result<Option<i64>> {
        match self.value(column)? {
            Value::NullInt | Value::NullText => Ok(None),
            Value::Int(n) => Ok(Some(*n)),
            Value::Float(n) if n.fract() == 0.0 => Ok(Some(*n as i64)),
            Value::Text(text) => text
                .parse()
                .map(Some)
                .map_err(|_| anyhow!("column \"{column}\" holds \"{text}\", not a whole number")),
            other => bail!("column \"{column}\" holds {other:?}, not a whole number"),
        }
    }

    /// A whole number, of a column that always holds one.
    pub fn i64(&self, column: &str) -> Result<i64> {
        self.opt_i64(column)?.with_context(|| format!("column \"{column}\" holds no number"))
    }

    /// A flag: a column of 0 or 1.
    pub fn flag(&self, column: &str) -> Result<bool> {
        Ok(self.opt_i64(column)?.unwrap_or(0) != 0)
    }

    /// Text, or none where the column holds NULL.
    pub fn opt_str(&self, column: &str) -> Result<Option<&str>> {
        match self.value(column)? {
            Value::NullInt | Value::NullText => Ok(None),
            Value::Text(text) => Ok(Some(text)),
            // What a driver gives as bytes where the column is text (MySQL, of a binary collation).
            Value::Bytes(bytes) => std::str::from_utf8(bytes)
                .map(Some)
                .map_err(|_| anyhow!("column \"{column}\" holds bytes that are not text")),
            other => bail!("column \"{column}\" holds {other:?}, not text"),
        }
    }

    /// Text, of a column that always holds some.
    pub fn str(&self, column: &str) -> Result<&str> {
        self.opt_str(column)?.with_context(|| format!("column \"{column}\" holds no text"))
    }

    /// Text, as a `String` of its own.
    pub fn string(&self, column: &str) -> Result<String> {
        self.str(column).map(str::to_owned)
    }

    /// Text as a `String` of its own, or none where the column holds NULL.
    pub fn opt_string(&self, column: &str) -> Result<Option<String>> {
        Ok(self.opt_str(column)?.map(str::to_owned))
    }
}

/// Makes this module's `Row` of a driver's: each column as the first of the kinds of value
/// it reads as.
macro_rules! row_of {
    ($name:ident, $row:ty, $db:ty) => {
        fn $name(row: &$row, names: &mut Option<Arc<[String]>>) -> Result<Row> {
            let names = names
                .get_or_insert_with(|| row.columns().iter().map(|column| column.name().to_owned()).collect())
                .clone();
            let mut values = Vec::with_capacity(names.len());
            for at in 0..names.len() {
                let value = if row.try_get_raw(at)?.is_null() {
                    Value::NullText
                } else if let Ok(n) = row.try_get::<i64, _>(at) {
                    Value::Int(n)
                } else if let Ok(n) = row.try_get::<i32, _>(at) {
                    Value::Int(n.into())
                } else if let Ok(n) = row.try_get::<i16, _>(at) {
                    Value::Int(n.into())
                } else if let Ok(text) = row.try_get::<String, _>(at) {
                    Value::Text(text)
                } else if let Ok(on) = row.try_get::<bool, _>(at) {
                    Value::Int(on.into())
                } else if let Ok(n) = row.try_get::<f64, _>(at) {
                    Value::Float(n)
                } else if let Ok(bytes) = row.try_get::<Vec<u8>, _>(at) {
                    Value::Bytes(bytes)
                } else {
                    bail!(
                        "column \"{}\" of a result is of a type this reads none of: cast it in the statement",
                        names[at]
                    );
                };
                values.push(value);
            }
            Ok(Row { names, values })
        }
    };
}
row_of!(sqlite_row, SqliteRow, Sqlite);
row_of!(postgres_row, PgRow, Postgres);
row_of!(mysql_row, MySqlRow, MySql);

/// A statement of a dialect's own driver, with its values bound.
macro_rules! bound {
    ($db:ty, $sql:expr, $params:expr) => {{
        let mut query = sqlx::query::<$db>(AssertSqlSafe($sql));
        for param in $params {
            query = match param {
                Value::NullInt => query.bind(None::<i64>),
                Value::NullText => query.bind(None::<String>),
                Value::Int(n) => query.bind(*n),
                Value::Float(n) => query.bind(*n),
                Value::Text(text) => query.bind(text.clone()),
                Value::Bytes(bytes) => query.bind(bytes.clone()),
            };
        }
        query
    }};
}

/// Runs a statement on a pool or on a transaction's connection (`$on`), for its rows or for
/// how many rows it changed.
macro_rules! run {
    (fetch, $kind:ident, $row_of:ident, $db:ty, $on:expr, $sql:expr, $params:expr) => {{
        let rows = bound!($db, $sql, $params).fetch_all($on).await?;
        let mut names = None;
        rows.iter().map(|row| $row_of(row, &mut names)).collect::<Result<Vec<Row>>>()
    }};
    (execute, $kind:ident, $row_of:ident, $db:ty, $on:expr, $sql:expr, $params:expr) => {{ Ok(bound!($db, $sql, $params).execute($on).await?.rows_affected()) }};
}

/// A statement as PostgreSQL takes it: `$1`, `$2`, ... where it was written with `?`s. A `?`
/// within a quoted string is left as it is.
fn numbered(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len() + 16);
    let (mut quoted, mut n) = (false, 0);
    for c in sql.chars() {
        match c {
            '\'' => quoted = !quoted,
            '?' if !quoted => {
                n += 1;
                out.push('$');
                out.push_str(&n.to_string());
                continue;
            }
            _ => {}
        }
        out.push(c);
    }
    out
}

/// `?, ?, ?`: the places of `n` values, for a list (`IN (...)`).
pub fn places(n: usize) -> String {
    vec!["?"; n].join(", ")
}

impl Dialect {
    /// The start of an insert that leaves the rows that are already there as they are; end it
    /// with `ignore_end`.
    pub fn insert_ignore(self) -> &'static str {
        if self == Self::Mysql { "INSERT IGNORE INTO" } else { "INSERT INTO" }
    }

    /// The end of an insert that began with `insert_ignore`.
    pub fn ignore_end(self) -> &'static str {
        if self == Self::Mysql { "" } else { " ON CONFLICT DO NOTHING" }
    }

    /// The end of an insert that sets `columns` on the row whose `key` is already there, to
    /// what the insert would have put in them.
    pub fn upsert_end(self, key: &[&str], columns: &[&str]) -> String {
        if self == Self::Mysql {
            let set: Vec<String> = columns.iter().map(|column| format!("{column} = VALUES({column})")).collect();
            format!(" ON DUPLICATE KEY UPDATE {}", set.join(", "))
        } else {
            let set: Vec<String> = columns.iter().map(|column| format!("{column} = excluded.{column}")).collect();
            format!(" ON CONFLICT ({}) DO UPDATE SET {}", key.join(", "), set.join(", "))
        }
    }

    /// What ends a select that locks the rows it reads until the transaction ends. SQLite has
    /// no row locks and needs none: a transaction of it has the whole file.
    pub fn for_update(self) -> &'static str {
        match self {
            Self::Sqlite => "",
            // The lock an UPDATE of the row takes, which inserts of rows that reference it don't wait for.
            Self::Postgres => " FOR NO KEY UPDATE",
            Self::Mysql => " FOR UPDATE",
        }
    }

    /// A column of JSON as the text it holds. PostgreSQL and MySQL give such a column in a
    /// form of their own, and SQLite as the string it was given.
    pub fn json_text(self, column: &str) -> String {
        match self {
            Self::Sqlite => column.to_owned(),
            Self::Postgres => format!("CAST({column} AS text)"),
            Self::Mysql => format!("CAST({column} AS CHAR)"),
        }
    }

    /// The place of a value that is JSON, given as text, for a column of JSON.
    pub fn json_place(self) -> &'static str {
        match self {
            Self::Postgres => "CAST(? AS json)",
            Self::Sqlite | Self::Mysql => "?",
        }
    }

    /// A sum as a whole number: PostgreSQL and MySQL give the sum of whole numbers as a
    /// decimal, which no column of the schema is.
    pub fn sum(self, of: &str) -> String {
        match self {
            Self::Sqlite => format!("SUM({of})"),
            Self::Postgres => format!("CAST(SUM({of}) AS bigint)"),
            Self::Mysql => format!("CAST(SUM({of}) AS SIGNED)"),
        }
    }
}

/// What a PostgreSQL URL says of the connection, read as the API reads it. `sslmode=no-verify`
/// is a word of the API's driver (node-postgres), which PostgreSQL itself doesn't have: the
/// connection is encrypted, and the server's certificate isn't checked. Here that is what
/// `require` means, so it is read as that. Both sides are given the one URL, and a deployment
/// whose database has a certificate nobody's trust store knows says `no-verify` in it.
fn postgres_options(url: &str) -> Result<PgConnectOptions> {
    let ssl_mode = |key: &str| key == "sslmode" || key == "ssl-mode";
    if let Ok(mut parsed) = url::Url::parse(url) {
        let pairs: Vec<(String, String)> = parsed.query_pairs().into_owned().collect();
        if pairs.iter().any(|(key, value)| ssl_mode(key) && value == "no-verify") {
            parsed.query_pairs_mut().clear().extend_pairs(
                pairs
                    .iter()
                    .map(|(key, value)| (key.as_str(), if ssl_mode(key) && value == "no-verify" { "require" } else { value.as_str() })),
            );
            return Ok(PgConnectOptions::from_str(parsed.as_str())?);
        }
    }
    // Anything else is the driver's to read, and to refuse in its own words.
    Ok(PgConnectOptions::from_str(url)?)
}

#[derive(Clone)]
enum Pool {
    Sqlite(sqlx::SqlitePool),
    Postgres(sqlx::PgPool),
    Mysql(sqlx::MySqlPool),
}

/// The database: a pool of connections to it. A copy shares the pool.
#[derive(Clone)]
pub struct Db {
    pool: Pool,
}

enum TxInner {
    Sqlite(sqlx::Transaction<'static, Sqlite>),
    Postgres(sqlx::Transaction<'static, Postgres>),
    Mysql(sqlx::Transaction<'static, MySql>),
}

/// A transaction: what it wrote holds once it is committed, and is undone if it is dropped
/// before.
pub struct Tx {
    inner: TxInner,
}

/// What runs statements: the database itself, each statement on its own, or a transaction.
#[allow(async_fn_in_trait)]
pub trait Queries {
    /// The dialect of the database, for the words of a statement that differ.
    fn dialect(&self) -> Dialect;
    /// The rows a statement gives.
    async fn fetch(&mut self, sql: &str, params: &[Value]) -> Result<Vec<Row>>;
    /// Runs a statement, and returns how many rows it changed.
    async fn execute(&mut self, sql: &str, params: &[Value]) -> Result<u64>;

    /// The first row a statement gives, if it gives any.
    async fn fetch_optional(&mut self, sql: &str, params: &[Value]) -> Result<Option<Row>> {
        Ok(self.fetch(sql, params).await?.into_iter().next())
    }
}

impl Db {
    /// Connects to the database the settings name. Nothing is migrated (see `wait_for_schema`).
    /// A SQLite file's folder is made if it isn't there.
    pub async fn connect(cfg: &DbConfig) -> Result<Self> {
        let idle = cfg.idle_timeout_ms.map(|ms| Duration::from_millis(ms.unsigned_abs()));
        let size = u32::try_from(cfg.pool_size).unwrap_or(u32::MAX).max(1);
        let pool = match cfg.dialect {
            Dialect::Sqlite => {
                if cfg.url == ":memory:" {
                    bail!(
                        "DATABASE_URL is :memory:, a database only the process that made it reaches: the compactor is a process of its own, and needs the file the API writes"
                    );
                }
                if let Some(dir) = Path::new(&cfg.url).parent().filter(|dir| !dir.as_os_str().is_empty()) {
                    std::fs::create_dir_all(dir).with_context(|| format!("could not make {}", dir.display()))?;
                }
                let options = SqliteConnectOptions::new()
                    .filename(&cfg.url)
                    .create_if_missing(true)
                    .journal_mode(SqliteJournalMode::Wal)
                    // As the API's connection has it (better-sqlite3 builds SQLite so): the log is synced when it is
                    // checkpointed, not at every commit. The file is whole after a crash either way, and what the API
                    // committed is no safer for this side syncing its own.
                    .synchronous(SqliteSynchronous::Normal)
                    .foreign_keys(true)
                    .busy_timeout(SQLITE_BUSY_TIMEOUT);
                // One connection, as the API has: its statements and transactions take turns, and none waits for a lock of another's.
                Pool::Sqlite(
                    SqlitePoolOptions::new()
                        .max_connections(1)
                        .acquire_timeout(ACQUIRE_TIMEOUT)
                        .connect_with(options)
                        .await?,
                )
            }
            Dialect::Postgres => {
                let options = postgres_options(&cfg.url).context("DATABASE_URL is not the URL of a PostgreSQL database")?;
                Pool::Postgres(
                    PgPoolOptions::new()
                        .max_connections(size)
                        .idle_timeout(idle)
                        .acquire_timeout(ACQUIRE_TIMEOUT)
                        .connect_with(options)
                        .await?,
                )
            }
            Dialect::Mysql => {
                let options = MySqlConnectOptions::from_str(&cfg.url).context("DATABASE_URL is not the URL of a MySQL database")?;
                Pool::Mysql(
                    MySqlPoolOptions::new()
                        .max_connections(size)
                        .idle_timeout(idle)
                        .acquire_timeout(ACQUIRE_TIMEOUT)
                        .connect_with(options)
                        .await?,
                )
            }
        };
        Ok(Self { pool })
    }

    /// The dialect of the database.
    pub fn dialect(&self) -> Dialect {
        match self.pool {
            Pool::Sqlite(_) => Dialect::Sqlite,
            Pool::Postgres(_) => Dialect::Postgres,
            Pool::Mysql(_) => Dialect::Mysql,
        }
    }

    /// The rows a statement gives.
    pub async fn fetch(&self, sql: &str, params: &[Value]) -> Result<Vec<Row>> {
        match &self.pool {
            Pool::Sqlite(pool) => run!(fetch, Sqlite, sqlite_row, Sqlite, pool, sql, params),
            Pool::Postgres(pool) => run!(fetch, Postgres, postgres_row, Postgres, pool, numbered(sql).as_str(), params),
            Pool::Mysql(pool) => run!(fetch, Mysql, mysql_row, MySql, pool, sql, params),
        }
    }

    /// The first row a statement gives, if it gives any.
    pub async fn fetch_optional(&self, sql: &str, params: &[Value]) -> Result<Option<Row>> {
        Ok(self.fetch(sql, params).await?.into_iter().next())
    }

    /// Runs a statement, and returns how many rows it changed.
    pub async fn execute(&self, sql: &str, params: &[Value]) -> Result<u64> {
        match &self.pool {
            Pool::Sqlite(pool) => run!(execute, Sqlite, sqlite_row, Sqlite, pool, sql, params),
            Pool::Postgres(pool) => run!(execute, Postgres, postgres_row, Postgres, pool, numbered(sql).as_str(), params),
            Pool::Mysql(pool) => run!(execute, Mysql, mysql_row, MySql, pool, sql, params),
        }
    }

    /// Begins a transaction. One of SQLite takes the file's write lock as it begins, and
    /// waits for it: one that took it at its first write would fail there, rather than wait,
    /// if another process had written since the transaction's first read.
    pub async fn begin(&self) -> Result<Tx> {
        let inner = match &self.pool {
            Pool::Sqlite(pool) => TxInner::Sqlite(pool.begin_with("BEGIN IMMEDIATE").await?),
            Pool::Postgres(pool) => TxInner::Postgres(pool.begin().await?),
            Pool::Mysql(pool) => TxInner::Mysql(pool.begin().await?),
        };
        Ok(Tx { inner })
    }

    /// Whether the schema has had the migration this was built with: what `SCHEMA` names is
    /// among those Kysely recorded. A database that has no record of any has had none.
    pub async fn schema_ready(&self) -> bool {
        self.fetch("SELECT name FROM kysely_migration WHERE name = ?", params![SCHEMA])
            .await
            .is_ok_and(|rows| !rows.is_empty())
    }

    /// Waits until the schema has had the migration this was built with, which a process of
    /// the API runs as it starts, or `npm run migrate`. `waiting` is called once, if it has to
    /// wait at all.
    pub async fn wait_for_schema(&self, waiting: impl FnOnce()) {
        if self.schema_ready().await {
            return;
        }
        waiting();
        while !self.schema_ready().await {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }

    /// Closes the pool's connections, once the statements under way are done.
    pub async fn close(&self) {
        match &self.pool {
            Pool::Sqlite(pool) => pool.close().await,
            Pool::Postgres(pool) => pool.close().await,
            Pool::Mysql(pool) => pool.close().await,
        }
    }
}

impl Queries for &Db {
    fn dialect(&self) -> Dialect {
        Db::dialect(self)
    }
    async fn fetch(&mut self, sql: &str, params: &[Value]) -> Result<Vec<Row>> {
        Db::fetch(self, sql, params).await
    }
    async fn execute(&mut self, sql: &str, params: &[Value]) -> Result<u64> {
        Db::execute(self, sql, params).await
    }
}

impl Tx {
    /// Makes what the transaction wrote hold.
    pub async fn commit(self) -> Result<()> {
        match self.inner {
            TxInner::Sqlite(tx) => tx.commit().await?,
            TxInner::Postgres(tx) => tx.commit().await?,
            TxInner::Mysql(tx) => tx.commit().await?,
        }
        Ok(())
    }

    /// Undoes what the transaction wrote.
    pub async fn rollback(self) -> Result<()> {
        match self.inner {
            TxInner::Sqlite(tx) => tx.rollback().await?,
            TxInner::Postgres(tx) => tx.rollback().await?,
            TxInner::Mysql(tx) => tx.rollback().await?,
        }
        Ok(())
    }
}

impl Queries for Tx {
    fn dialect(&self) -> Dialect {
        match self.inner {
            TxInner::Sqlite(_) => Dialect::Sqlite,
            TxInner::Postgres(_) => Dialect::Postgres,
            TxInner::Mysql(_) => Dialect::Mysql,
        }
    }

    async fn fetch(&mut self, sql: &str, params: &[Value]) -> Result<Vec<Row>> {
        match &mut self.inner {
            TxInner::Sqlite(tx) => run!(fetch, Sqlite, sqlite_row, Sqlite, &mut **tx, sql, params),
            TxInner::Postgres(tx) => run!(fetch, Postgres, postgres_row, Postgres, &mut **tx, numbered(sql).as_str(), params),
            TxInner::Mysql(tx) => run!(fetch, Mysql, mysql_row, MySql, &mut **tx, sql, params),
        }
    }

    async fn execute(&mut self, sql: &str, params: &[Value]) -> Result<u64> {
        match &mut self.inner {
            TxInner::Sqlite(tx) => run!(execute, Sqlite, sqlite_row, Sqlite, &mut **tx, sql, params),
            TxInner::Postgres(tx) => run!(execute, Postgres, postgres_row, Postgres, &mut **tx, numbered(sql).as_str(), params),
            TxInner::Mysql(tx) => run!(execute, Mysql, mysql_row, MySql, &mut **tx, sql, params),
        }
    }
}

/// The database's own error within an error of this crate's, if it is one.
fn database_error(err: &anyhow::Error) -> Option<&(dyn sqlx::error::DatabaseError + 'static)> {
    err.chain()
        .find_map(|cause| cause.downcast_ref::<sqlx::Error>())
        .and_then(sqlx::Error::as_database_error)
}

/// Whether an error is a unique or primary-key constraint's: the row is already there.
pub fn is_unique_violation(err: &anyhow::Error) -> bool {
    database_error(err).is_some_and(|err| err.is_unique_violation())
}

/// Whether an error is a foreign key's: a row was written for a row that isn't there.
pub fn is_foreign_key_violation(err: &anyhow::Error) -> bool {
    database_error(err).is_some_and(|err| err.is_foreign_key_violation())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn open() -> (tempfile::TempDir, Db) {
        let dir = tempfile::tempdir().unwrap();
        let cfg = DbConfig {
            dialect: Dialect::Sqlite,
            url: dir.path().join("nested/test.sqlite").to_string_lossy().into_owned(),
            pool_size: 10,
            idle_timeout_ms: None,
            migrate_on_start: true,
        };
        let db = Db::connect(&cfg).await.unwrap();
        (dir, db)
    }

    #[test]
    fn numbers_the_places_of_a_statement_for_postgres() {
        assert_eq!(
            numbered("SELECT a FROM t WHERE b = ? AND c IN (?, ?)"),
            "SELECT a FROM t WHERE b = $1 AND c IN ($2, $3)"
        );
        assert_eq!(numbered("SELECT '?' , ?"), "SELECT '?' , $1");
        assert_eq!(places(3), "?, ?, ?");
    }

    #[test]
    fn reads_a_postgres_url_as_the_api_does() {
        use sqlx::postgres::PgSslMode;

        // The API's driver's word for "encrypted, the certificate unchecked", which is `require` here.
        let options = postgres_options("postgres://app:p%40ss@db.internal:6543/evieverse?sslmode=no-verify&application_name=compactor").unwrap();
        assert!(matches!(options.get_ssl_mode(), PgSslMode::Require));
        assert_eq!(options.get_host(), "db.internal");
        assert_eq!(options.get_port(), 6543);
        assert_eq!(options.get_username(), "app");
        assert_eq!(options.get_database(), Some("evieverse"));
        assert_eq!(options.get_application_name(), Some("compactor"));

        // Every other word is the driver's own, and means what it says.
        let options = postgres_options("postgres://app:secret@db.internal/evieverse?sslmode=verify-full").unwrap();
        assert!(matches!(options.get_ssl_mode(), PgSslMode::VerifyFull));
        let options = postgres_options("postgres://app:secret@db.internal/evieverse?sslmode=disable").unwrap();
        assert!(matches!(options.get_ssl_mode(), PgSslMode::Disable));

        // One it doesn't have is still refused, and the refusal doesn't hold the URL, which has the password in it.
        let refused = postgres_options("postgres://app:secret@db.internal/evieverse?sslmode=sometimes").unwrap_err();
        assert!(!format!("{refused:#}").contains("secret"));
    }

    #[tokio::test]
    async fn reads_back_what_it_wrote_and_undoes_a_transaction_that_is_dropped() {
        let (_dir, db) = open().await;
        db.execute("CREATE TABLE t (id varchar(36) PRIMARY KEY, n bigint NOT NULL, note text, payload json)", &[])
            .await
            .unwrap();
        let none: Option<&str> = None;
        assert_eq!(
            db.execute("INSERT INTO t (id, n, note, payload) VALUES (?, ?, ?, ?)", params!["a", 5, none, r#"{"x":1}"#])
                .await
                .unwrap(),
            1
        );
        let row = db
            .fetch_optional(
                &format!("SELECT id, n, note, {} AS payload, COUNT(*) AS c FROM t", db.dialect().json_text("payload")),
                &[],
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            (
                row.str("id").unwrap(),
                row.i64("n").unwrap(),
                row.opt_str("note").unwrap(),
                row.str("payload").unwrap(),
                row.i64("c").unwrap()
            ),
            ("a", 5, None, r#"{"x":1}"#, 1)
        );
        assert!(row.i64("missing").is_err());

        let again = db.execute("INSERT INTO t (id, n) VALUES (?, ?)", params!["a", 6]).await.unwrap_err();
        assert!(is_unique_violation(&again) && !is_foreign_key_violation(&again));
        let ignored = format!("{} t (id, n) VALUES (?, ?){}", db.dialect().insert_ignore(), db.dialect().ignore_end());
        assert_eq!(db.execute(&ignored, params!["a", 6]).await.unwrap(), 0);
        let upsert = format!("INSERT INTO t (id, n) VALUES (?, ?){}", db.dialect().upsert_end(&["id"], &["n"]));
        db.execute(&upsert, params!["a", 7]).await.unwrap();

        let mut tx = db.begin().await.unwrap();
        tx.execute("UPDATE t SET n = ? WHERE id = ?", params![9, "a"]).await.unwrap();
        assert_eq!(tx.fetch("SELECT n FROM t", &[]).await.unwrap()[0].i64("n").unwrap(), 9);
        drop(tx);
        assert_eq!(db.fetch("SELECT n FROM t", &[]).await.unwrap()[0].i64("n").unwrap(), 7);

        let mut tx = db.begin().await.unwrap();
        tx.execute("UPDATE t SET n = ? WHERE id = ?", params![9, "a"]).await.unwrap();
        tx.commit().await.unwrap();
        assert_eq!(db.fetch("SELECT n FROM t", &[]).await.unwrap()[0].i64("n").unwrap(), 9);
    }

    #[tokio::test]
    async fn waits_for_a_schema_that_has_had_its_migration() {
        let (_dir, db) = open().await;
        assert!(!db.schema_ready().await);
        db.execute(
            "CREATE TABLE kysely_migration (name varchar(255) PRIMARY KEY, timestamp varchar(255) NOT NULL)",
            &[],
        )
        .await
        .unwrap();
        db.execute("INSERT INTO kysely_migration (name, timestamp) VALUES (?, ?)", params!["0001_initial", "t"])
            .await
            .unwrap();
        assert_eq!(db.schema_ready().await, SCHEMA == "0001_initial");
        db.execute("INSERT INTO kysely_migration (name, timestamp) VALUES (?, ?)", params![SCHEMA, "t"])
            .await
            .ok();
        assert!(db.schema_ready().await);
        db.wait_for_schema(|| panic!("the schema is there")).await;
    }
}
