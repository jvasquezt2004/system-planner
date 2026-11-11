//! Conversations, their messages and usage, and the Assistant's few settings
//! (`src/bun/assistant-store.ts`, without anything about provider connections: the harnesses own
//! their models and credentials).

use std::path::Path;
use std::sync::{Mutex, OnceLock};

use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use schema_domain::js::{self, SPACE_CLASS};
use serde_json::{json, Map, Value};

type Result<T> = std::result::Result<T, String>;

const SCHEMA: &str = "
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS assistant_conversations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        connection_id TEXT,
        provider TEXT,
        model TEXT,
        thinking TEXT
    );
    CREATE INDEX IF NOT EXISTS assistant_conversations_project_updated
        ON assistant_conversations(project_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS assistant_messages (
        conversation_id TEXT NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        id TEXT,
        role TEXT NOT NULL,
        kind TEXT,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, sequence)
    );
    CREATE TABLE IF NOT EXISTS assistant_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        connection_id TEXT,
        model TEXT,
        thinking TEXT,
        max_requests_per_turn INTEGER NOT NULL DEFAULT 40
    );
    CREATE TABLE IF NOT EXISTS assistant_project_observations (
        conversation_id TEXT PRIMARY KEY REFERENCES assistant_conversations(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        snapshot TEXT
    );
    CREATE TABLE IF NOT EXISTS assistant_turn_usage (
        conversation_id TEXT NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cost REAL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, turn_id)
    );
";

const CONVERSATION_COLUMNS: &str = "id, project_id, title, created_at, updated_at, connection_id, provider, model, thinking";

pub struct AssistantStore {
    conn: Mutex<Connection>,
    now: Box<dyn Fn() -> i64 + Send + Sync>,
}

fn db<T>(result: rusqlite::Result<T>) -> Result<T> {
    result.map_err(|error| error.to_string())
}

fn conversation(row: &rusqlite::Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, String>(0)?, "project_id": row.get::<_, String>(1)?, "title": row.get::<_, String>(2)?,
        "created_at": row.get::<_, i64>(3)?, "updated_at": row.get::<_, i64>(4)?,
        "connection_id": row.get::<_, Option<String>>(5)?, "provider": row.get::<_, Option<String>>(6)?,
        "model": row.get::<_, Option<String>>(7)?, "thinking": row.get::<_, Option<String>>(8)?,
    }))
}

/// The conversation's title: the first 80 characters of the opening message with its space collapsed.
fn title_from_message(message: &Value) -> String {
    static SPACES: OnceLock<Regex> = OnceLock::new();
    let payload = &message["payload"];
    let text = match payload {
        Value::String(text) => text.as_str(),
        Value::Object(map) => map.get("content").and_then(Value::as_str).unwrap_or_default(),
        _ => "",
    };
    let spaces = SPACES.get_or_init(|| Regex::new(&format!("{SPACE_CLASS}+")).expect("valid pattern"));
    let compact = spaces.replace_all(text, " ");
    let title: String = js::trim(&compact).chars().take(80).collect();
    if title.is_empty() { "New conversation".to_owned() } else { title }
}

impl AssistantStore {
    pub fn open(path: impl AsRef<Path>, now: impl Fn() -> i64 + Send + Sync + 'static) -> Result<Self> {
        let conn = db(Connection::open(path))?;
        db(conn.execute_batch(SCHEMA))?;
        Ok(Self { conn: Mutex::new(conn), now: Box::new(now) })
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().expect("assistant store")
    }

    pub fn list_conversations(&self, project_id: &str) -> Result<Vec<Value>> {
        let conn = self.conn();
        let mut statement = db(conn.prepare(&format!("SELECT {CONVERSATION_COLUMNS} FROM assistant_conversations WHERE project_id = ? ORDER BY updated_at DESC, created_at DESC, id DESC")))?;
        let rows = db(statement.query_map([project_id], conversation))?;
        db(rows.collect())
    }

    pub fn get_latest_conversation(&self, project_id: &str) -> Result<Option<Value>> {
        Ok(self.list_conversations(project_id)?.into_iter().next())
    }

    fn select_conversation(conn: &Connection, id: &str) -> Result<Option<Value>> {
        db(conn.query_row(&format!("SELECT {CONVERSATION_COLUMNS} FROM assistant_conversations WHERE id = ?"), [id], conversation).optional())
    }

    fn insert_message(conn: &Connection, conversation_id: &str, sequence: i64, message: &Value, now: i64) -> Result<i64> {
        let payload = serde_json::to_string(&message["payload"]).map_err(|error| error.to_string())?;
        db(conn.execute(
            "INSERT INTO assistant_messages (conversation_id, sequence, id, role, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            params![
                conversation_id,
                sequence,
                message["id"].as_str(),
                message["role"].as_str().unwrap_or_default(),
                message["kind"].as_str(),
                payload,
                message["created_at"].as_i64().unwrap_or(now)
            ],
        ))?;
        Ok(conn.last_insert_rowid())
    }

    /// Starts a conversation with its first message. `options` may carry `id`, `title`, `connectionId`,
    /// `provider`, `model` and `thinking`.
    pub fn create_conversation(&self, project_id: &str, first_message: &Value, options: &Value) -> Result<Value> {
        let now = (self.now)();
        let id = options["id"].as_str().map_or_else(|| uuid::Uuid::new_v4().to_string(), str::to_owned);
        let title = options["title"].as_str().map_or_else(|| title_from_message(first_message), str::to_owned);
        let mut conn = self.conn();
        let tx = db(conn.transaction())?;
        db(tx.execute(
            "INSERT INTO assistant_conversations (id, project_id, title, created_at, updated_at, connection_id, provider, model, thinking) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![id, project_id, title, now, now, options["connectionId"].as_str(), options["provider"].as_str(), options["model"].as_str(), options["thinking"].as_str()],
        ))?;
        Self::insert_message(&tx, &id, 1, first_message, now)?;
        let created = Self::select_conversation(&tx, &id)?.ok_or("The conversation was not created.")?;
        db(tx.commit())?;
        Ok(created)
    }

    pub fn rename_conversation(&self, id: &str, title: &str) -> Result<bool> {
        let now = (self.now)();
        Ok(db(self.conn().execute("UPDATE assistant_conversations SET title = ?, updated_at = ? WHERE id = ?", params![title, now, id]))? > 0)
    }

    pub fn delete_conversation(&self, id: &str) -> Result<bool> {
        Ok(db(self.conn().execute("DELETE FROM assistant_conversations WHERE id = ?", [id]))? > 0)
    }

    pub fn update_conversation_selection(&self, id: &str, connection_id: Option<&str>, model: &str, thinking: &str) -> Result<bool> {
        let now = (self.now)();
        let changes = db(self.conn().execute(
            "UPDATE assistant_conversations SET connection_id = ?, model = ?, thinking = ?, updated_at = ? WHERE id = ?",
            params![connection_id, model, thinking, now, id],
        ))?;
        Ok(changes > 0)
    }

    /// The model and effort new conversations start with.
    pub fn get_default_selection(&self) -> Result<Value> {
        let row = db(self
            .conn()
            .query_row("SELECT connection_id, model, thinking FROM assistant_settings WHERE id = 1", [], |row| {
                Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, Option<String>>(2)?))
            })
            .optional())?;
        let (connection_id, model, thinking) = row.unwrap_or_default();
        Ok(json!({ "connectionId": connection_id, "model": model, "thinking": thinking }))
    }

    pub fn update_default_selection(&self, connection_id: Option<&str>, model: &str, thinking: &str) -> Result<()> {
        db(self.conn().execute(
            "INSERT INTO assistant_settings (id, connection_id, model, thinking) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET connection_id = excluded.connection_id, model = excluded.model, thinking = excluded.thinking",
            params![connection_id, model, thinking],
        ))?;
        Ok(())
    }

    pub fn get_max_requests_per_turn(&self) -> Result<i64> {
        let found = db(self.conn().query_row("SELECT max_requests_per_turn FROM assistant_settings WHERE id = 1", [], |row| row.get::<_, i64>(0)).optional())?;
        Ok(found.unwrap_or(40))
    }

    pub fn set_max_requests_per_turn(&self, limit: f64) -> Result<()> {
        if limit.fract() != 0.0 || !(1.0..=500.0).contains(&limit) {
            return Err("Request cap must be an integer between 1 and 500.".into());
        }
        db(self.conn().execute(
            "INSERT INTO assistant_settings (id, max_requests_per_turn) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET max_requests_per_turn = excluded.max_requests_per_turn",
            [limit as i64],
        ))?;
        Ok(())
    }

    /// Records the Project revision a conversation last read and returns the one before.
    pub fn observe_project_revision(&self, conversation_id: &str, revision: i64) -> Result<Option<i64>> {
        let mut conn = self.conn();
        let tx = db(conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate))?;
        let previous = db(tx.query_row("SELECT revision FROM assistant_project_observations WHERE conversation_id = ?", [conversation_id], |row| row.get::<_, i64>(0)).optional())?;
        db(tx.execute(
            "INSERT INTO assistant_project_observations (conversation_id, revision) VALUES (?, ?) ON CONFLICT(conversation_id) DO UPDATE SET revision = excluded.revision",
            params![conversation_id, revision],
        ))?;
        db(tx.commit())?;
        Ok(previous)
    }

    /// Records what a conversation last read of the Project and returns what it read before, if anything.
    pub fn observe_project_snapshot(&self, conversation_id: &str, snapshot: &str, revision: i64) -> Result<Option<Value>> {
        let mut conn = self.conn();
        let tx = db(conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate))?;
        let previous = db(tx
            .query_row("SELECT snapshot, revision FROM assistant_project_observations WHERE conversation_id = ?", [conversation_id], |row| {
                Ok((row.get::<_, Option<String>>(0)?, row.get::<_, i64>(1)?))
            })
            .optional())?;
        db(tx.execute(
            "INSERT INTO assistant_project_observations (conversation_id, revision, snapshot) VALUES (?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET revision = excluded.revision, snapshot = excluded.snapshot",
            params![conversation_id, revision, snapshot],
        ))?;
        db(tx.commit())?;
        Ok(previous.and_then(|(snapshot, revision)| snapshot.map(|snapshot| json!({ "snapshot": snapshot, "revision": revision }))))
    }

    /// Adds a message to a conversation and returns its id.
    pub fn append_message(&self, conversation_id: &str, message: &Value) -> Result<String> {
        let now = (self.now)();
        let mut conn = self.conn();
        let tx = db(conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate))?;
        let sequence: i64 = db(tx.query_row("SELECT COALESCE(MAX(sequence), 0) + 1 FROM assistant_messages WHERE conversation_id = ?", [conversation_id], |row| row.get(0)))?;
        let id = Self::insert_message(&tx, conversation_id, sequence, message, now)?;
        db(tx.execute("UPDATE assistant_conversations SET updated_at = ? WHERE id = ?", params![now, conversation_id]))?;
        db(tx.commit())?;
        Ok(id.to_string())
    }

    pub fn save_turn_usage(&self, conversation_id: &str, turn_id: &str, usage: &Value) -> Result<()> {
        let now = (self.now)();
        db(self.conn().execute(
            "INSERT INTO assistant_turn_usage (conversation_id, turn_id, input_tokens, output_tokens, cache_read_tokens, cost, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(conversation_id, turn_id) DO UPDATE SET input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, cache_read_tokens = excluded.cache_read_tokens, cost = excluded.cost",
            params![conversation_id, turn_id, usage["inputTokens"].as_i64().unwrap_or(0), usage["outputTokens"].as_i64().unwrap_or(0), usage["cacheReadTokens"].as_i64().unwrap_or(0), usage["cost"].as_f64(), now],
        ))?;
        Ok(())
    }

    pub fn get_turn_usages(&self, conversation_id: &str) -> Result<Vec<Value>> {
        let conn = self.conn();
        let mut statement = db(conn.prepare("SELECT turn_id, input_tokens, output_tokens, cache_read_tokens, cost, created_at FROM assistant_turn_usage WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC"))?;
        let rows = db(statement.query_map([conversation_id], |row| {
            Ok(json!({
                "turnId": row.get::<_, String>(0)?, "inputTokens": row.get::<_, i64>(1)?, "outputTokens": row.get::<_, i64>(2)?,
                "cacheReadTokens": row.get::<_, i64>(3)?, "cost": row.get::<_, Option<f64>>(4)?, "createdAt": row.get::<_, i64>(5)?,
            }))
        }))?;
        db(rows.collect())
    }

    pub fn get_conversation_total_usage(&self, conversation_id: &str) -> Result<Value> {
        let totals = db(self.conn().query_row(
            "SELECT SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), SUM(cost) FROM assistant_turn_usage WHERE conversation_id = ?",
            [conversation_id],
            |row| Ok((row.get::<_, Option<i64>>(0)?, row.get::<_, Option<i64>>(1)?, row.get::<_, Option<i64>>(2)?, row.get::<_, Option<f64>>(3)?)),
        ))?;
        Ok(json!({ "inputTokens": totals.0.unwrap_or(0), "outputTokens": totals.1.unwrap_or(0), "cacheReadTokens": totals.2.unwrap_or(0), "cost": totals.3 }))
    }

    /// A conversation with its messages, in order, and its usage.
    pub fn load_conversation(&self, id: &str) -> Result<Option<Value>> {
        let conn = self.conn();
        let Some(Value::Object(mut record)) = Self::select_conversation(&conn, id)? else { return Ok(None) };
        let mut statement = db(conn.prepare("SELECT rowid, role, kind, payload, created_at FROM assistant_messages WHERE conversation_id = ? ORDER BY sequence ASC"))?;
        let rows = db(statement.query_map([id], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, String>(3)?, row.get::<_, i64>(4)?))))?;
        let mut messages = Vec::new();
        for row in rows {
            let (rowid, role, kind, payload, created_at) = db(row)?;
            let mut payload: Value = serde_json::from_str(&payload).map_err(|error| error.to_string())?;
            let row_id = rowid.to_string();
            if let Value::Object(map) = &mut payload {
                map.insert("id".into(), json!(row_id));
            }
            let mut message = Map::new();
            message.insert("id".into(), json!(row_id));
            message.insert("role".into(), json!(role));
            if let Some(kind) = kind {
                message.insert("kind".into(), json!(kind));
            }
            message.insert("payload".into(), payload);
            message.insert("created_at".into(), json!(created_at));
            messages.push(Value::Object(message));
        }
        drop(statement);
        drop(conn);
        record.insert("messages".into(), Value::Array(messages));
        record.insert("usages".into(), Value::Array(self.get_turn_usages(id)?));
        record.insert("totalUsage".into(), self.get_conversation_total_usage(id)?);
        Ok(Some(Value::Object(record)))
    }
}
