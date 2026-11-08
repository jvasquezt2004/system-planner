use pglite_oxide::{extensions, Pglite};
use serde_json::json;
use std::time::Instant;

const BOOTSTRAP: &str = r#"
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO anon, authenticated, service_role;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon, authenticated, service_role;
"#;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let t = Instant::now();
    let mut db = Pglite::builder().temporary().extension(extensions::VECTOR).open()?;
    println!("first open (with vector): {:?}", t.elapsed());

    let t = Instant::now();
    db.exec(BOOTSTRAP, None)?;
    println!("bootstrap: {:?}", t.elapsed());

    let t = Instant::now();
    db.exec("CREATE EXTENSION IF NOT EXISTS vector", None)?;
    db.exec("CREATE TABLE items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), embedding vector(3), tag text UNIQUE)", None)?;
    db.exec("CREATE INDEX items_hnsw ON items USING hnsw (embedding vector_l2_ops)", None)?;
    db.exec("GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role", None)?;
    println!("schema + pgvector + hnsw: {:?}", t.elapsed());

    // role switching + request claims, as scenario-api does per request
    db.exec("BEGIN", None)?;
    db.exec("SET LOCAL ROLE authenticated", None)?;
    db.query("SELECT set_config('request.jwt.claim.sub', $1, true)", &[json!("11111111-1111-1111-1111-111111111111")], None)?;
    let who = db.query("SELECT auth.uid()::text AS uid, current_user AS u", &[], None)?;
    println!("auth.uid/current_user: {:?}", who.rows);
    db.query("INSERT INTO items (embedding, tag) VALUES ($1::vector, $2)", &[json!("[1,2,3]"), json!("a")], None)?;
    db.exec("COMMIT", None)?;

    let nn = db.query("SELECT tag, embedding <-> '[1,2,4]' AS d FROM items ORDER BY d LIMIT 1", &[], None)?;
    println!("nearest: {:?}", nn.rows);

    // catalog query with information_schema, like sandbox.ts
    let t = Instant::now();
    let cols = db.query("SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name, ordinal_position", &[], None)?;
    println!("catalog ({} rows) in {:?}: {:?}", cols.rows.len(), t.elapsed(), cols.rows);

    // error carries SQLSTATE?
    match db.exec("INSERT INTO items (tag) VALUES ('a')", None) {
        Ok(_) => println!("ERROR: expected unique violation"),
        Err(e) => println!("unique violation error: {e:?} / {e}"),
    }
    db.close()?;

    // second sandbox in same process, fresh DB (design check after scenario)
    let t = Instant::now();
    let mut db2 = Pglite::builder().temporary().extension(extensions::VECTOR).open()?;
    println!("second open: {:?}", t.elapsed());
    let mut db3 = Pglite::builder().temporary().open()?;
    println!("two alive at once OK");
    db2.close()?; db3.close()?;
    Ok(())
}
