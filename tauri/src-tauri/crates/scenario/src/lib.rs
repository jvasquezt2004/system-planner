//! The PostgREST-shaped API a Scenario's code talks to (`src/bun/scenario-api.ts`).
//!
//! A Scenario runs against a private copy of the Design's sandbox database. Its requests arrive as
//! `{ method, path, query, headers, body }`; this module turns each into SQL, runs it as the caller's
//! role, and answers the way PostgREST would. What the emulation cannot do is refused with a
//! `PGRST_SANDBOX_UNSUPPORTED` error instead of guessed at.

use std::fmt;

use anyhow::Result;
use base64::Engine;
pub use pglite_oxide::Pglite;
use pglite_oxide::{extensions, PgliteError, Transaction};
use schema_domain::design::DesignFunction;
use serde::Deserialize;
use serde_json::{json, Map, Value};

use schema_sandbox::{SUPABASE_SANDBOX_BOOTSTRAP as BOOTSTRAP, SUPABASE_SANDBOX_GRANTS as GRANTS};

/// What the sandbox reports of a column, as far as the API needs.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub name: String,
    #[serde(default)]
    pub primary_key: bool,
    #[serde(default)]
    pub unique: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Table {
    pub name: String,
    pub columns: Vec<Column>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Relationship {
    pub name: String,
    pub referencing_table: String,
    pub referencing_column: String,
    pub referenced_table: String,
    pub referenced_column: String,
}

/// A fresh database holding the Design's SQL, for one Scenario run.
pub fn create_run_database(sql: &str) -> Result<Pglite> {
    let mut database = Pglite::builder().temporary().extension(extensions::VECTOR).open()?;
    database.exec(BOOTSTRAP, None)?;
    database.exec(sql, None)?;
    database.exec(GRANTS, None)?;
    Ok(database)
}

/// Every table's rows as the run left them, for the result grids.
pub fn capture_result_grids(database: &mut Pglite, tables: &[Table]) -> Result<Vec<Value>> {
    database.exec("BEGIN", None)?;
    let outcome = (|| -> Result<Vec<Value>> {
        database.exec("SET LOCAL ROLE postgres", None)?;
        let mut grids = Vec::new();
        for table in tables {
            let keys: Vec<String> = table.columns.iter().filter(|column| column.primary_key).map(|column| quote_identifier(&column.name)).collect();
            let order = if keys.is_empty() { String::new() } else { format!(" ORDER BY {}", keys.join(", ")) };
            let count = database.query(&format!("SELECT count(*) AS total FROM {}", quote_identifier(&table.name)), &[], None)?;
            let rows = database.query(&format!("SELECT * FROM {}{order} LIMIT 500", quote_identifier(&table.name)), &[], None)?;
            let total = count.rows.first().map(|row| &row["total"]).map_or(0, |total| match total {
                Value::Number(number) => number.as_i64().or_else(|| number.as_f64().map(|n| n as i64)).unwrap_or(0),
                Value::String(text) => text.parse().unwrap_or(0),
                _ => 0,
            });
            grids.push(json!({ "table": table.name, "columns": table.columns.iter().map(|column| column.name.clone()).collect::<Vec<_>>(), "rows": rows.rows, "total": total }));
        }
        Ok(grids)
    })();
    match outcome {
        Ok(grids) => {
            database.exec("COMMIT", None)?;
            Ok(grids)
        }
        Err(error) => {
            let _ = database.exec("ROLLBACK", None);
            Err(error)
        }
    }
}

/* ------------------------------------------------------------------ errors */

const UNSUPPORTED_CODE: &str = "PGRST_SANDBOX_UNSUPPORTED";

#[derive(Debug)]
enum ApiError {
    Unsupported(String),
    Postgrest { code: String, message: String, details: Value, hint: Option<String> },
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unsupported(message) | Self::Postgrest { message, .. } => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for ApiError {}

fn unsupported<T>(feature: impl AsRef<str>) -> Result<T> {
    Err(ApiError::Unsupported(format!("not supported by the sandbox: {}", feature.as_ref())).into())
}

fn postgrest<T>(code: &str, message: String, details: Value, hint: Option<String>) -> Result<T> {
    Err(ApiError::Postgrest { code: code.into(), message, details, hint }.into())
}

pub fn quote_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

fn edit_distance(left: &[char], right: &[char]) -> usize {
    let mut distances: Vec<usize> = (0..=right.len()).collect();
    for row in 1..=left.len() {
        let mut diagonal = distances[0];
        distances[0] = row;
        for column in 1..=right.len() {
            let above = distances[column];
            distances[column] = (distances[column] + 1).min(distances[column - 1] + 1).min(diagonal + usize::from(left[row - 1] != right[column - 1]));
            diagonal = above;
        }
    }
    distances[right.len()]
}

fn missing_table<T>(name: &str, tables: &[Table]) -> Result<T> {
    let wanted: Vec<char> = name.to_lowercase().chars().collect();
    let mut best: Option<(&str, f64)> = None;
    for table in tables {
        let candidate: Vec<char> = table.name.to_lowercase().chars().collect();
        let longest = wanted.len().max(candidate.len());
        let similarity = if longest == 0 { 1.0 } else { 1.0 - edit_distance(&wanted, &candidate) as f64 / longest as f64 };
        if similarity >= 0.75 && best.is_none_or(|(_, current)| similarity > current) {
            best = Some((&table.name, similarity));
        }
    }
    let hint = best.map(|(name, _)| format!("Perhaps you meant the table 'public.{name}'"));
    postgrest("PGRST205", format!("Could not find the table 'public.{name}' in the schema cache"), Value::Null, hint)
}

fn missing_relationship<T>(source: &str, target: &str) -> Result<T> {
    postgrest(
        "PGRST200",
        format!("Could not find a relationship between '{source}' and '{target}' in the schema cache"),
        Value::Null,
        Some(format!("Verify that '{source}' and '{target}' exist in the schema 'public' and that a foreign key relationship exists between them. If a new relationship was created, try reloading the schema cache.")),
    )
}

fn status_for_sql_state(code: &str, role: &str) -> u16 {
    if code.len() == 5 && code.starts_with("PT") && code[2..].chars().all(|c| c.is_ascii_digit()) {
        return code[2..].parse().unwrap_or(400);
    }
    if code.starts_with("08") {
        return 503;
    }
    match code {
        "42501" => {
            if role == "anon" { 401 } else { 403 }
        }
        "25006" => 405,
        "42P01" | "42883" => 404,
        "23505" | "23503" => 409,
        _ => 400,
    }
}

/* ------------------------------------------------------------------ identity */

const ROLE_NAMES: [&str; 3] = ["anon", "authenticated", "service_role"];

fn identity_from_headers(headers: &Map<String, Value>) -> Value {
    let anonymous = || json!({ "role": "anon", "claims": { "role": "anon" } });
    let authorization = headers.iter().find(|(name, _)| name.eq_ignore_ascii_case("authorization")).and_then(|(_, value)| value.as_str()).unwrap_or("");
    // /^Bearer\s+[^.]+\.([^.]+)\./i
    let Some(rest) = authorization.get(..6).filter(|prefix| prefix.eq_ignore_ascii_case("bearer")).map(|_| &authorization[6..]) else { return anonymous() };
    let rest_trimmed = rest.trim_start_matches(|c: char| c.is_whitespace());
    if rest_trimmed.len() == rest.len() {
        return anonymous();
    }
    let mut parts = rest_trimmed.splitn(3, '.');
    let (Some(head), Some(payload), Some(_)) = (parts.next(), parts.next(), parts.next()) else { return anonymous() };
    if head.is_empty() || payload.is_empty() {
        return anonymous();
    }
    let normalized: String = payload.replace('-', "+").replace('_', "/").trim_end_matches('=').to_owned();
    let Ok(bytes) = base64::engine::general_purpose::STANDARD_NO_PAD.decode(normalized) else { return anonymous() };
    let Ok(Value::Object(claims)) = serde_json::from_slice::<Value>(&bytes) else { return anonymous() };
    let role = claims.get("role").and_then(Value::as_str).filter(|role| ROLE_NAMES.contains(role)).unwrap_or("anon").to_owned();
    let user_id = claims.get("sub").and_then(Value::as_str).map(str::to_owned);
    let mut merged = claims;
    merged.insert("role".into(), json!(role));
    let mut identity = Map::new();
    identity.insert("role".into(), json!(role));
    if let Some(user_id) = user_id.filter(|id| !id.is_empty()) {
        identity.insert("userId".into(), json!(user_id));
    }
    identity.insert("claims".into(), Value::Object(merged));
    Value::Object(identity)
}

/* ------------------------------------------------------------------ query strings */

fn parse_pairs(url: &url::Url) -> Vec<(String, String)> {
    url.query_pairs().map(|(key, value)| (key.into_owned(), value.into_owned())).collect()
}

fn first<'a>(pairs: &'a [(String, String)], key: &str) -> Option<&'a str> {
    pairs.iter().find(|(name, _)| name == key).map(|(_, value)| value.as_str())
}

fn is_digits(value: &str) -> bool {
    !value.is_empty() && value.chars().all(|c| c.is_ascii_digit())
}

fn safe_integer(value: &str) -> Option<u64> {
    value.parse::<u64>().ok().filter(|number| *number <= 9_007_199_254_740_991)
}

/* ------------------------------------------------------------------ selecting */

#[derive(Debug, Default, Clone)]
struct Embed {
    resource: String,
    hint: Option<String>,
    inner: bool,
    columns: Vec<String>,
    embeds: Vec<Embed>,
    filters: Vec<(String, String)>,
    order_by: Option<String>,
    limit: Option<u64>,
}

#[derive(Debug, Default, Clone)]
struct Projection {
    columns: Vec<String>,
    embeds: Vec<Embed>,
}

fn split_selection(value: &str) -> Result<Vec<String>> {
    let chars: Vec<char> = value.chars().collect();
    let (mut parts, mut start, mut depth, mut quoted) = (Vec::new(), 0usize, 0i32, false);
    let mut index = 0;
    while index < chars.len() {
        if chars[index] == '"' && chars.get(index + 1) == Some(&'"') && quoted {
            index += 2;
            continue;
        }
        if chars[index] == '"' {
            quoted = !quoted;
        } else if !quoted && chars[index] == '(' {
            depth += 1;
        } else if !quoted && chars[index] == ')' {
            depth -= 1;
        } else if !quoted && chars[index] == ',' && depth == 0 {
            parts.push(chars[start..index].iter().collect());
            start = index + 1;
        }
        if depth < 0 {
            return unsupported("select syntax");
        }
        index += 1;
    }
    if depth != 0 || quoted {
        return unsupported("select syntax");
    }
    parts.push(chars[start..].iter().collect());
    Ok(parts)
}

struct Token {
    resource: String,
    hint: Option<String>,
    nested: Option<String>,
}

fn parse_projection_token(token: &str) -> Option<Token> {
    let chars: Vec<char> = token.chars().collect();
    let mut index = 0;
    let read_identifier = |index: &mut usize| -> Option<String> {
        if chars.get(*index) == Some(&'"') {
            *index += 1;
            let mut value = String::new();
            while *index < chars.len() {
                let character = chars[*index];
                *index += 1;
                if character != '"' {
                    value.push(character);
                } else if chars.get(*index) == Some(&'"') {
                    value.push('"');
                    *index += 1;
                } else {
                    return Some(value);
                }
            }
            return None;
        }
        let start = *index;
        while *index < chars.len() && !['!', '(', ')'].contains(&chars[*index]) {
            *index += 1;
        }
        if *index > start { Some(chars[start..*index].iter().collect()) } else { None }
    };
    let resource = read_identifier(&mut index).filter(|resource| !resource.is_empty())?;
    let mut hint: Option<String> = None;
    if chars.get(index) == Some(&'!') {
        index += 1;
        let mut text = read_identifier(&mut index).filter(|hint| !hint.is_empty())?;
        while chars.get(index) == Some(&'!') {
            index += 1;
            let modifier = read_identifier(&mut index).filter(|modifier| !modifier.is_empty())?;
            text.push('!');
            text.push_str(&modifier);
        }
        hint = Some(text);
    }
    let mut nested = None;
    if chars.get(index) == Some(&'(') {
        index += 1;
        let start = index;
        let (mut depth, mut quoted) = (1, false);
        while index < chars.len() && depth != 0 {
            let character = chars[index];
            if character == '"' && chars.get(index + 1) == Some(&'"') && quoted {
                index += 1;
            } else if character == '"' {
                quoted = !quoted;
            } else if !quoted && character == '(' {
                depth += 1;
            } else if !quoted && character == ')' {
                depth -= 1;
            }
            index += 1;
        }
        if depth != 0 {
            return None;
        }
        nested = Some(chars[start..index - 1].iter().collect());
    }
    if index == chars.len() { Some(Token { resource, hint, nested }) } else { None }
}

fn find_table<'a>(tables: &'a [Table], name: &str) -> Option<&'a Table> {
    tables.iter().find(|table| table.name == name)
}

fn parse_projection(selection: &str, columns: &[String], tables: &[Table], table_name: &str) -> Result<Projection> {
    let mut projection = Projection::default();
    for token in split_selection(selection)? {
        if token == "*" {
            projection.columns.extend(columns.iter().cloned());
            continue;
        }
        let Some(parsed) = parse_projection_token(&token) else {
            if token.contains(':') {
                return unsupported("aliased selects");
            }
            if token.contains("->") {
                return unsupported("JSON-path selects");
            }
            return unsupported("select projection");
        };
        let Some(nested) = parsed.nested else {
            if !columns.contains(&parsed.resource) {
                return unsupported("select projection");
            }
            projection.columns.push(parsed.resource);
            continue;
        };
        let hint = parsed.hint;
        let inner = hint.as_deref() == Some("inner") || hint.as_deref().is_some_and(|hint| hint.ends_with("!inner"));
        let foreign_key_hint = if inner && hint.as_deref() == Some("inner") { None } else { hint.map(|hint| hint.strip_suffix("!inner").map_or(hint.clone(), str::to_owned)) };
        let Some(target) = find_table(tables, &parsed.resource) else { return missing_relationship(table_name, &parsed.resource) };
        let target_columns: Vec<String> = target.columns.iter().map(|column| column.name.clone()).collect();
        let child = if nested == "*" { Projection { columns: target_columns, embeds: vec![] } } else { parse_projection(&nested, &target_columns, tables, &parsed.resource)? };
        projection.embeds.push(Embed {
            resource: parsed.resource,
            hint: foreign_key_hint.filter(|hint| !hint.is_empty()),
            inner,
            columns: child.columns,
            embeds: child.embeds,
            ..Default::default()
        });
    }
    Ok(projection)
}

/// Applies `resource.limit`, `resource.order` and `resource.column` options to the embeds they name.
fn apply_embedded_options(projection: &mut Projection, query: &[(String, String)], tables: &[Table]) -> Result<Vec<String>> {
    let mut handled = Vec::new();
    for embed in &mut projection.embeds {
        let Some(table) = find_table(tables, &embed.resource) else { continue };
        let columns: Vec<String> = table.columns.iter().map(|column| column.name.clone()).collect();
        for (key, value) in query {
            let prefix = format!("{}.", embed.resource);
            let Some(option) = key.strip_prefix(&prefix) else { continue };
            if option == "limit" {
                let Some(number) = safe_integer(value).filter(|_| is_digits(value)) else { return unsupported("embedded limit value") };
                embed.limit = Some(number);
            } else if option == "order" {
                if embed.order_by.is_some() {
                    return unsupported("multiple embedded order clauses");
                }
                embed.order_by = Some(parse_order(value, &columns)?);
            } else {
                if !columns.iter().any(|column| column == option) {
                    return unsupported(format!("embedded filter column {option}"));
                }
                embed.filters.push((option.to_owned(), value.clone()));
            }
            handled.push(key.clone());
        }
    }
    Ok(handled)
}

struct Candidate<'a> {
    relationship: &'a Relationship,
    side: Side,
    through: Option<&'a Relationship>,
}

#[derive(PartialEq, Clone, Copy)]
enum Side {
    ToOne,
    ToMany,
    ManyToMany,
}

fn push_param(params: &mut Vec<Value>, value: Value) -> usize {
    params.push(value);
    params.len()
}

fn build_projection(table_name: &str, alias: &str, projection: &Projection, tables: &[Table], relationships: &[Relationship], params: &mut Vec<Value>) -> Result<String> {
    let mut expressions = Vec::new();
    for column in &projection.columns {
        let at = push_param(params, json!(column));
        expressions.push(format!("${at}::text, {alias}.{}", quote_identifier(column)));
    }
    for embed in &projection.embeds {
        let mut candidates: Vec<Candidate> = Vec::new();
        for relationship in relationships {
            if relationship.referencing_table == table_name && relationship.referenced_table == embed.resource {
                candidates.push(Candidate { relationship, side: Side::ToOne, through: None });
            } else if relationship.referenced_table == table_name && relationship.referencing_table == embed.resource {
                candidates.push(Candidate { relationship, side: Side::ToMany, through: None });
            }
        }
        if candidates.is_empty() {
            for from_parent in relationships.iter().filter(|relationship| relationship.referenced_table == table_name) {
                for to_target in relationships.iter().filter(|relationship| relationship.referencing_table == from_parent.referencing_table && relationship.referenced_table == embed.resource) {
                    candidates.push(Candidate { relationship: from_parent, side: Side::ManyToMany, through: Some(to_target) });
                }
            }
        }
        let matching: Vec<&Candidate> = candidates
            .iter()
            .filter(|candidate| {
                embed.hint.as_ref().is_none_or(|hint| {
                    candidate.relationship.name == *hint
                        || candidate.relationship.referencing_column == *hint
                        || candidate.through.is_some_and(|through| through.name == *hint || through.referencing_column == *hint)
                })
            })
            .collect();
        if matching.is_empty() {
            return missing_relationship(table_name, &embed.resource);
        }
        if matching.len() > 1 {
            let target = find_table(tables, &embed.resource);
            let details: Vec<Value> = matching
                .iter()
                .map(|candidate| {
                    let unique = candidate.side == Side::ToMany && target.is_some_and(|target| target.columns.iter().any(|column| column.name == candidate.relationship.referencing_column && column.unique));
                    let cardinality = match candidate.side {
                        Side::ToOne => "many-to-one",
                        Side::ManyToMany => "many-to-many",
                        Side::ToMany if unique => "one-to-one",
                        Side::ToMany => "one-to-many",
                    };
                    let reference = candidate.through.unwrap_or(candidate.relationship);
                    json!({
                        "cardinality": cardinality,
                        "embedding": format!("{table_name} with {}", embed.resource),
                        "relationship": format!("{} using {}({}) and {}({})", reference.name, reference.referencing_table, reference.referencing_column, reference.referenced_table, reference.referenced_column),
                    })
                })
                .collect();
            let names: Vec<String> = matching.iter().map(|candidate| format!("'{}!{}'", embed.resource, candidate.through.map_or(&candidate.relationship.name, |through| &through.name))).collect();
            let hint = format!("Try changing '{}' to one of the following: {}. Find the desired relationship in the 'details' key.", embed.resource, names.join(", "));
            return postgrest("PGRST201", format!("Could not embed because more than one relationship was found for '{table_name}' and '{}'", embed.resource), json!(details), Some(hint));
        }
        let Candidate { relationship, side, through } = matching[0];
        let Some(target) = find_table(tables, &embed.resource) else { return postgrest("PGRST200", format!("Could not find table '{}' in the schema cache", embed.resource), Value::Null, None) };
        let child_alias = format!("embed_{}", params.len());
        let junction_alias = format!("junction_{}", params.len());
        let selected = if embed.columns.is_empty() { target.columns.iter().map(|column| column.name.clone()).collect() } else { embed.columns.clone() };
        let child = Projection { columns: selected, embeds: embed.embeds.clone() };
        let child_projection = build_projection(&embed.resource, &child_alias, &child, tables, relationships, params)?;
        let label_at = push_param(params, json!(embed.resource));
        let label = format!("${label_at}::text");
        let unique = *side == Side::ToOne || (*side == Side::ToMany && target.columns.iter().any(|column| column.name == relationship.referencing_column && column.unique));
        let q = quote_identifier;
        let from = if *side == Side::ManyToMany {
            let through = through.expect("a many-to-many link has a second relationship");
            format!(
                "{} AS {child_alias} JOIN {} AS {junction_alias} ON {junction_alias}.{} = {child_alias}.{}",
                q(&embed.resource),
                q(&relationship.referencing_table),
                q(&through.referencing_column),
                q(&through.referenced_column)
            )
        } else {
            format!("{} AS {child_alias}", q(&embed.resource))
        };
        let link = match side {
            Side::ToOne => format!("{alias}.{} = {child_alias}.{}", q(&relationship.referencing_column), q(&relationship.referenced_column)),
            Side::ManyToMany => format!("{junction_alias}.{} = {alias}.{}", q(&relationship.referencing_column), q(&relationship.referenced_column)),
            Side::ToMany => format!("{child_alias}.{} = {alias}.{}", q(&relationship.referencing_column), q(&relationship.referenced_column)),
        };
        let mut conditions = vec![link];
        for (column, value) in &embed.filters {
            conditions.push(parse_filter(column, value, params)?);
        }
        let child_where = conditions.join(" AND ");
        let order = embed.order_by.as_ref().map(|order| format!(" ORDER BY {order}")).unwrap_or_default();
        let row_limit = embed.limit.map(|limit| format!(" LIMIT {limit}")).unwrap_or_default();
        let subquery = if unique {
            format!("(SELECT {child_projection} FROM {from} WHERE {child_where}{order}{row_limit})")
        } else {
            format!("(SELECT COALESCE(jsonb_agg(embed_rows.payload), '[]'::jsonb) FROM (SELECT {child_projection} AS payload FROM {from} WHERE {child_where}{order}{row_limit}) AS embed_rows)")
        };
        expressions.push(format!("{label}, {}", if unique { format!("COALESCE({subquery}, 'null'::jsonb)") } else { subquery }));
    }
    if expressions.is_empty() {
        return unsupported("empty select projection");
    }
    Ok(format!("jsonb_build_object({})", expressions.join(", ")))
}

fn build_inner_condition(table_name: &str, alias: &str, embed: &Embed, relationships: &[Relationship], params: &mut Vec<Value>) -> Result<String> {
    let q = quote_identifier;
    let hinted = |relationship: &&Relationship| embed.hint.as_ref().is_none_or(|hint| relationship.name == *hint || relationship.referencing_column == *hint);
    let direct: Vec<&Relationship> = relationships
        .iter()
        .filter(|relationship| (relationship.referencing_table == table_name && relationship.referenced_table == embed.resource) || (relationship.referenced_table == table_name && relationship.referencing_table == embed.resource))
        .filter(hinted)
        .collect();
    if direct.len() == 1 {
        let relationship = direct[0];
        let target_alias = "inner_embed";
        let link = if relationship.referencing_table == table_name {
            format!("{alias}.{} = {target_alias}.{}", q(&relationship.referencing_column), q(&relationship.referenced_column))
        } else {
            format!("{target_alias}.{} = {alias}.{}", q(&relationship.referencing_column), q(&relationship.referenced_column))
        };
        let mut conditions = vec![link];
        for (column, value) in &embed.filters {
            conditions.push(parse_filter(column, value, params)?);
        }
        return Ok(format!("EXISTS (SELECT 1 FROM {} AS {target_alias} WHERE {})", q(&embed.resource), conditions.join(" AND ")));
    }
    if direct.len() > 1 {
        let names: Vec<&str> = direct.iter().map(|relationship| relationship.name.as_str()).collect();
        return postgrest("PGRST201", format!("Could not embed because more than one relationship was found for '{table_name}' and '{}'", embed.resource), json!(names.join(", ")), None);
    }
    let mut junctions: Vec<(&Relationship, &Relationship)> = Vec::new();
    for from_parent in relationships {
        for to_target in relationships {
            if from_parent.referencing_table == to_target.referencing_table && from_parent.referenced_table == table_name && to_target.referenced_table == embed.resource {
                let matches = embed.hint.as_ref().is_none_or(|hint| {
                    from_parent.name == *hint || from_parent.referencing_column == *hint || to_target.name == *hint || to_target.referencing_column == *hint
                });
                if matches {
                    junctions.push((from_parent, to_target));
                }
            }
        }
    }
    if junctions.len() == 1 {
        let (from_parent, to_target) = junctions[0];
        let (junction_alias, target_alias) = ("inner_junction", "inner_target");
        let mut conditions = vec![format!("{junction_alias}.{} = {alias}.{}", q(&from_parent.referencing_column), q(&from_parent.referenced_column))];
        for (column, value) in &embed.filters {
            conditions.push(parse_filter(column, value, params)?);
        }
        return Ok(format!(
            "EXISTS (SELECT 1 FROM {} AS {junction_alias} JOIN {} AS {target_alias} ON {junction_alias}.{} = {target_alias}.{} WHERE {})",
            q(&from_parent.referencing_table),
            q(&embed.resource),
            q(&to_target.referencing_column),
            q(&to_target.referenced_column),
            conditions.join(" AND ")
        ));
    }
    if junctions.len() > 1 {
        let names: Vec<&str> = junctions.iter().map(|(from_parent, _)| from_parent.name.as_str()).collect();
        return postgrest("PGRST201", format!("Could not embed because more than one relationship was found for '{table_name}' and '{}'", embed.resource), json!(names.join(", ")), None);
    }
    missing_relationship(table_name, &embed.resource)
}

/* ------------------------------------------------------------------ filters and ordering */

fn parse_order(value: &str, columns: &[String]) -> Result<String> {
    let mut terms = Vec::new();
    for term in value.split(',') {
        let parts: Vec<&str> = term.split('.').collect();
        let column = parts[0];
        let direction = parts.get(1).copied().unwrap_or("asc");
        let nulls = parts.get(2).copied().filter(|nulls| !nulls.is_empty());
        if parts.len() > 3 || column.is_empty() {
            return unsupported("order syntax");
        }
        if !columns.iter().any(|candidate| candidate == column) {
            return unsupported(format!("order column {column}"));
        }
        if direction != "asc" && direction != "desc" {
            return unsupported("order direction");
        }
        if nulls.is_some_and(|nulls| nulls != "nullsfirst" && nulls != "nullslast") {
            return unsupported("order null placement");
        }
        let placement = match nulls {
            Some("nullsfirst") => " NULLS FIRST",
            Some(_) => " NULLS LAST",
            None => "",
        };
        terms.push(format!("{} {}{placement}", quote_identifier(column), direction.to_uppercase()));
    }
    Ok(terms.join(", "))
}

fn unquote_in_value(value: &str) -> String {
    if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        return value[1..value.len() - 1].replace("\\\"", "\"").replace("\\\\", "\\");
    }
    value.to_owned()
}

fn split_in_values(value: &str) -> Vec<String> {
    let chars: Vec<char> = value.chars().collect();
    let (mut values, mut current, mut quoted) = (Vec::new(), String::new(), false);
    for (index, &character) in chars.iter().enumerate() {
        if character == '"' && (index == 0 || chars[index - 1] != '\\') {
            quoted = !quoted;
            current.push(character);
        } else if character == ',' && !quoted {
            values.push(unquote_in_value(&current));
            current.clear();
        } else {
            current.push(character);
        }
    }
    if !current.is_empty() || !value.is_empty() {
        values.push(unquote_in_value(&current));
    }
    values
}

fn parse_filter(column: &str, expression: &str, params: &mut Vec<Value>) -> Result<String> {
    let negated = expression.starts_with("not.");
    let body = if negated { &expression[4..] } else { expression };
    let Some(separator) = body.find('.').filter(|separator| *separator >= 1) else { return unsupported("filter operator") };
    let (operator, value) = (&body[..separator], &body[separator + 1..]);
    let identifier = quote_identifier(column);
    if operator == "is" {
        let not = if negated { "NOT " } else { "" };
        return match value {
            "null" => Ok(format!("{identifier} IS {not}NULL")),
            "true" | "false" => Ok(format!("{identifier} IS {not}{}", value.to_uppercase())),
            _ => unsupported("is filter value"),
        };
    }
    if operator == "in" {
        if !value.starts_with('(') || !value.ends_with(')') {
            return unsupported("in filter syntax");
        }
        let values = split_in_values(&value[1..value.len() - 1]);
        if values.is_empty() {
            return unsupported("empty in filter");
        }
        let first = params.len();
        let list: Vec<String> = (0..values.len()).map(|index| format!("${}", first + index + 1)).collect();
        params.extend(values.into_iter().map(Value::String));
        return Ok(format!("{identifier} {}IN ({})", if negated { "NOT " } else { "" }, list.join(", ")));
    }
    let sql = match operator {
        "eq" => "=",
        "neq" => "<>",
        "gt" => ">",
        "gte" => ">=",
        "lt" => "<",
        "lte" => "<=",
        "like" => "LIKE",
        "ilike" => "ILIKE",
        _ => return unsupported(format!("filter operator {operator}")),
    };
    let at = push_param(params, Value::String(if operator == "like" || operator == "ilike" { value.replace('*', "%") } else { value.to_owned() }));
    let comparison = format!("{identifier} {sql} ${at}");
    Ok(if negated { format!("NOT ({comparison})") } else { comparison })
}

fn parse_or(value: &str, columns: &[String], params: &mut Vec<Value>) -> Result<String> {
    if !value.starts_with('(') || !value.ends_with(')') {
        return unsupported("or filter syntax");
    }
    let inner = &value[1..value.len() - 1];
    let alternatives: Vec<&str> = inner.split(',').collect();
    if alternatives.iter().any(|part| part.is_empty()) {
        return unsupported("or filter syntax");
    }
    let mut parts = Vec::new();
    for part in alternatives {
        let Some(first) = part.find('.').filter(|first| *first >= 1) else { return unsupported("or filter expression") };
        let Some(second) = part[first + 1..].find('.').map(|second| second + first + 1) else { return unsupported("or filter expression") };
        let column = &part[..first];
        if !columns.iter().any(|candidate| candidate == column) {
            return unsupported(format!("filter column {column}"));
        }
        parts.push(parse_filter(column, &format!("{}.{}", &part[first + 1..second], &part[second + 1..]), params)?);
    }
    Ok(format!("({})", parts.join(" OR ")))
}

/// Shifts `$n` placeholders by `by`, for filters built before the values they follow.
fn shift_placeholders(sql: &str, by: usize) -> String {
    let chars: Vec<char> = sql.chars().collect();
    let mut out = String::new();
    let mut index = 0;
    while index < chars.len() {
        if chars[index] == '$' && chars.get(index + 1).is_some_and(char::is_ascii_digit) {
            let mut end = index + 1;
            while chars.get(end).is_some_and(char::is_ascii_digit) {
                end += 1;
            }
            let number: usize = chars[index + 1..end].iter().collect::<String>().parse().unwrap_or(0);
            out.push_str(&format!("${}", number + by));
            index = end;
        } else {
            out.push(chars[index]);
            index += 1;
        }
    }
    out
}

/* ------------------------------------------------------------------ talking to the database */

fn result_rows(rows: Vec<Value>) -> Vec<Value> {
    rows.into_iter().map(|mut row| row.get_mut("result").map(Value::take).unwrap_or(Value::Null)).collect()
}

fn query_write_representation(tx: &mut Transaction<'_>, statement: &str, projection: &Projection, table_name: &str, tables: &[Table], relationships: &[Relationship], params: &[Value]) -> Result<Vec<Value>> {
    let mut query_params = params.to_vec();
    let json_projection = build_projection(table_name, "written", projection, tables, relationships, &mut query_params)?;
    let result = tx.query(&format!("WITH written AS ({statement} RETURNING *) SELECT {json_projection} AS result FROM written AS written"), &query_params, None)?;
    Ok(result_rows(result.rows))
}

fn query_write_count(tx: &mut Transaction<'_>, statement: &str, params: &[Value]) -> Result<i64> {
    let result = tx.query(&format!("WITH written AS ({statement} RETURNING *) SELECT count(*)::int AS total FROM written"), params, None)?;
    Ok(result.rows.first().and_then(|row| row["total"].as_i64()).unwrap_or(0))
}

fn write_response(status: u16, rows: Option<&Vec<Value>>, representation: bool, count: Option<i64>, accept: &str) -> Result<Value> {
    let singular = accept.contains("vnd.pgrst.object");
    if representation && singular && rows.map_or(0, Vec::len) != 1 {
        return postgrest("PGRST116", "JSON object requested, multiple (or no) rows returned".into(), Value::Null, None).map_err(|error| match error.downcast::<ApiError>() {
            Ok(ApiError::Postgrest { code, message, hint, .. }) => ApiError::Postgrest { code, message, details: json!(format!("The result contains {} rows", rows.map_or(0, Vec::len))), hint }.into(),
            Ok(other) => other.into(),
            Err(other) => other,
        });
    }
    let mut headers = Map::new();
    if representation {
        headers.insert("content-type".into(), json!(if singular { "application/vnd.pgrst.object+json" } else { "application/json" }));
    }
    if let Some(count) = count {
        let range = match rows {
            Some(rows) if !rows.is_empty() => format!("0-{}/{count}", rows.len() - 1),
            _ => format!("*/{count}"),
        };
        headers.insert("content-range".into(), json!(range));
    }
    let body = if !representation {
        Value::Null
    } else if singular {
        rows.and_then(|rows| rows.first().cloned()).unwrap_or(Value::Null)
    } else {
        json!(rows.cloned().unwrap_or_default())
    };
    Ok(json!({ "status": status, "headers": headers, "body": body }))
}

fn json_headers(status: u16, body: Value) -> Value {
    json!({ "status": status, "headers": { "content-type": "application/json" }, "body": body })
}

/* ------------------------------------------------------------------ rpc */

const BUILTIN_FUNCTION_TYPES: &[&str] = &[
    "smallint", "integer", "int", "bigint", "numeric", "decimal", "real", "double precision", "smallserial", "serial", "bigserial", "text", "varchar", "character varying", "char", "character", "boolean", "bool", "uuid", "date",
    "time", "time without time zone", "time with time zone", "timestamp", "timestamp without time zone", "timestamp with time zone", "interval", "json", "jsonb", "bytea", "inet", "cidr", "macaddr", "void",
];

fn render_rpc_argument_type(value: &str, tables: &[Table]) -> String {
    let normalized = value.trim();
    let without_array = normalized.strip_suffix("[]").unwrap_or(normalized).trim();
    let base = without_array.to_lowercase();
    if tables.iter().any(|table| table.name == normalized) {
        return quote_identifier(normalized);
    }
    let identifier_like = !base.is_empty() && base.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && base.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !BUILTIN_FUNCTION_TYPES.contains(&base.as_str()) && identifier_like {
        let name = normalized.strip_suffix("[]").unwrap_or(normalized);
        return format!("{}{}", quote_identifier(name), if normalized.ends_with("[]") { "[]" } else { "" });
    }
    normalized.to_owned()
}

/// The columns of a `TABLE(a integer, b text)` return type.
fn function_table_return_columns(return_type: &str) -> Result<Option<Vec<String>>> {
    let trimmed = return_type.trim();
    let Some(head) = trimmed.get(..5).filter(|head| head.eq_ignore_ascii_case("table")) else { return Ok(None) };
    let _ = head;
    let rest = trimmed[5..].trim_start();
    if !rest.starts_with('(') || !rest.ends_with(')') {
        return Ok(None);
    }
    let mut columns = Vec::new();
    for definition in split_selection(&rest[1..rest.len() - 1])? {
        let text = definition.trim_start();
        let name = if let Some(quoted) = text.strip_prefix('"') {
            let chars: Vec<char> = quoted.chars().collect();
            let (mut name, mut index) = (String::new(), 0);
            let mut closed = false;
            while index < chars.len() {
                if chars[index] == '"' {
                    if chars.get(index + 1) == Some(&'"') {
                        name.push('"');
                        index += 2;
                        continue;
                    }
                    closed = true;
                    index += 1;
                    break;
                }
                name.push(chars[index]);
                index += 1;
            }
            if !closed || !chars.get(index).is_some_and(|c| c.is_whitespace()) {
                return unsupported("function TABLE return columns");
            }
            name
        } else {
            let mut end = 0;
            let bytes = text.as_bytes();
            if bytes.first().is_none_or(|b| !(b.is_ascii_alphabetic() || *b == b'_')) {
                return unsupported("function TABLE return columns");
            }
            while end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_' || bytes[end] == b'$') {
                end += 1;
            }
            if !text[end..].starts_with(char::is_whitespace) {
                return unsupported("function TABLE return columns");
            }
            text[..end].to_owned()
        };
        columns.push(name);
    }
    Ok(Some(columns))
}

fn execute_function_rpc(tx: &mut Transaction<'_>, url: &url::Url, request: &Value, name: &str, functions: &[DesignFunction], tables: &[Table], relationships: &[Relationship]) -> Result<Value> {
    let Some(function) = functions.iter().find(|candidate| candidate.name == name) else {
        return postgrest("PGRST202", format!("Could not find the function public.{name} without parameters in the schema cache"), Value::Null, None);
    };
    let method = request["method"].as_str().unwrap_or("");
    if method != "POST" && method != "GET" {
        return unsupported("function HTTP method");
    }
    if method == "GET" && function.volatility == "volatile" {
        return unsupported("GET for volatile functions");
    }
    let pairs = parse_pairs(url);
    let argument_names: Vec<&str> = function.arguments.iter().map(|argument| argument.name.as_str()).collect();
    let result_table = find_table(tables, &function.return_type);
    let table_columns: Option<Vec<String>> = match result_table {
        Some(table) => Some(table.columns.iter().map(|column| column.name.clone()).collect()),
        None => function_table_return_columns(&function.return_type)?,
    };
    let is_result_option = |key: &str| key == "select" || key.contains('.');
    if pairs.iter().any(|(key, _)| !argument_names.contains(&key.as_str()) && !is_result_option(key) && ["order", "limit", "offset", "or", "and"].contains(&key.as_str())) {
        return unsupported("filters or query options on function results");
    }
    let wrong_names = || postgrest::<()>("PGRST202", format!("Could not find the function public.{name} with the supplied parameter names"), Value::Null, None);
    let mut supplied: Vec<(String, Value)> = Vec::new();
    if method == "GET" {
        for (key, value) in &pairs {
            if argument_names.contains(&key.as_str()) {
                supplied.retain(|(name, _)| name != key);
                supplied.push((key.clone(), json!(value)));
            } else if !is_result_option(key) {
                if table_columns.as_ref().is_some_and(|columns| columns.contains(key)) {
                    return unsupported("filters on function results");
                }
                wrong_names()?;
            }
        }
    } else {
        if pairs.iter().any(|(key, _)| !is_result_option(key)) {
            return unsupported("query options on POST function calls");
        }
        let body: Value = match request["body"].as_str().filter(|body| !body.is_empty()) {
            Some(body) => serde_json::from_str(body)?,
            None => json!({}),
        };
        let Value::Object(map) = body else { return unsupported("function arguments must be a JSON object") };
        supplied.extend(map);
    }
    if supplied.iter().any(|(key, _)| !argument_names.contains(&key.as_str())) || function.arguments.iter().any(|argument| !supplied.iter().any(|(key, _)| *key == argument.name)) {
        wrong_names()?;
    }
    let params: Vec<Value> = function.arguments.iter().map(|argument| supplied.iter().rev().find(|(key, _)| *key == argument.name).map(|(_, value)| value.clone()).unwrap_or(Value::Null)).collect();
    let calls: Vec<String> = function
        .arguments
        .iter()
        .enumerate()
        .map(|(index, argument)| format!("{} => ${}::{}", quote_identifier(&argument.name), index + 1, render_rpc_argument_type(&argument.argument_type, tables)))
        .collect();
    let invocation = format!("public.{}({})", quote_identifier(name), calls.join(", "));
    let select = first(&pairs, "select");
    let result_option_keys: Vec<&(String, String)> = pairs.iter().filter(|(key, _)| !argument_names.contains(&key.as_str()) && is_result_option(key)).collect();
    if table_columns.is_none() && !result_option_keys.is_empty() {
        return unsupported("function result projection");
    }
    if function.return_type.trim().eq_ignore_ascii_case("void") && !function.returns_set {
        tx.query(&format!("SELECT {invocation}"), &params, None)?;
        return Ok(json_headers(200, Value::Null));
    }
    if let Some(columns) = table_columns {
        let source_name = result_table.map_or(function.return_type.as_str(), |table| table.name.as_str()).to_owned();
        let mut projection = match select {
            None => Projection { columns: columns.clone(), embeds: vec![] },
            Some(select) => parse_projection(select, &columns, tables, &source_name)?,
        };
        let handled = apply_embedded_options(&mut projection, &pairs, tables)?;
        if result_option_keys.iter().any(|(key, _)| key != "select" && !handled.contains(key)) {
            return unsupported("function result query options");
        }
        let mut query_params = params;
        let projection_sql = build_projection(&source_name, "_rpc_result", &projection, tables, relationships, &mut query_params)?;
        let result = tx.query(&format!("SELECT {projection_sql} AS result FROM {invocation} AS _rpc_result"), &query_params, None)?;
        let mut rows = result_rows(result.rows);
        let body = if function.returns_set { json!(rows) } else if rows.is_empty() { Value::Null } else { rows.swap_remove(0) };
        return Ok(json_headers(200, body));
    }
    let result = if function.returns_set {
        tx.query(&format!("SELECT to_jsonb(_rpc_result) AS result FROM {invocation} AS _rpc_result"), &params, None)?
    } else {
        tx.query(&format!("SELECT to_jsonb({invocation}) AS result"), &params, None)?
    };
    let mut rows = result_rows(result.rows);
    let body = if function.returns_set { json!(rows) } else if rows.is_empty() { Value::Null } else { rows.swap_remove(0) };
    Ok(json_headers(200, body))
}

/* ------------------------------------------------------------------ requests */

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}

/// Answers one request against the run's database, returning the response and the request-log entry.
pub fn handle_request(database: &mut Pglite, tables: &[Table], request: &Value, relationships: &[Relationship], functions: &[DesignFunction]) -> (Value, Value) {
    let empty = Map::new();
    let headers = request["headers"].as_object().unwrap_or(&empty);
    if let Some(invocation) = request.get("invocation").filter(|invocation| !invocation.is_null()) {
        let status = invocation["status"].as_u64().unwrap_or(200) as u16;
        let response = json_headers(status, invocation["response"].clone());
        let entry = json!({
            "method": "INVOKE",
            "table": format!("functions/{}", text(invocation, "functionName")),
            "filters": {},
            "identity": identity_from_headers(headers),
            "status": status,
            "result": response["body"],
            "invocation": invocation,
        });
        return (response, entry);
    }
    let target = format!("http://sandbox.local{}{}", text(request, "path"), if text(request, "query").is_empty() { String::new() } else { format!("?{}", text(request, "query")) });
    let identity = identity_from_headers(headers);
    let role = identity["role"].as_str().unwrap_or("anon").to_owned();
    let (url, pairs, segments) = match url::Url::parse(&target) {
        Ok(url) => {
            let segments: Vec<String> = url.path().split('/').filter(|segment| !segment.is_empty()).map(str::to_owned).collect();
            let pairs = parse_pairs(&url);
            (Some(url), pairs, segments)
        }
        Err(_) => (None, vec![], vec![]),
    };
    let decode = |segment: &str| percent_decode(segment);
    let table_name = if segments.len() == 3 && segments[0] == "rest" && segments[1] == "v1" { decode(&segments[2]) } else { String::new() };
    let mut filters = Map::new();
    for (key, value) in &pairs {
        if key != "select" && key != "columns" {
            filters.insert(key.clone(), json!(value));
        }
    }
    let mut table = table_name.clone();
    let outcome: Result<Value> = (|| {
        let Some(url) = url.as_ref() else { return unsupported("endpoint") };
        let claims = identity["claims"].to_string();
        let user_id = identity["userId"].as_str().unwrap_or("").to_owned();
        let segments = &segments;
        let table = &mut table;
        database.transaction(|tx| {
            tx.query("SELECT set_config('request.jwt.claims', $1, true)", &[json!(claims)], None)?;
            tx.query("SELECT set_config('request.jwt.claim.role', $1, true)", &[json!(role)], None)?;
            tx.query("SELECT set_config('request.jwt.claim.sub', $1, true)", &[json!(user_id)], None)?;
            tx.exec(&format!("SET LOCAL ROLE {role}"), None)?;
            if segments.len() == 4 && segments[0] == "rest" && segments[1] == "v1" && segments[2] == "rpc" {
                let function_name = percent_decode(&segments[3]);
                *table = format!("rpc/{function_name}");
                return execute_function_rpc(tx, url, request, &function_name, functions, tables, relationships);
            }
            if segments.len() != 3 || segments[0] != "rest" || segments[1] != "v1" {
                return unsupported("endpoint");
            }
            let Some(schema_table) = find_table(tables, &table_name) else { return missing_table(&table_name, tables) };
            table_request(tx, url, &pairs, request, headers, &table_name, schema_table, tables, relationships)
        })
    })();
    let response = match outcome {
        Ok(response) => response,
        Err(error) => error_response(error, &role),
    };
    let mut entry = Map::new();
    entry.insert("method".into(), json!(text(request, "method")));
    entry.insert("table".into(), json!(table));
    entry.insert("filters".into(), Value::Object(filters));
    entry.insert("identity".into(), identity);
    entry.insert("status".into(), response["status"].clone());
    entry.insert("result".into(), response["body"].clone());
    if let Some(reference) = request.get("invocationRef").filter(|reference| !reference.is_null() && reference.as_str() != Some("")) {
        entry.insert("invocationRef".into(), reference.clone());
    }
    (response, Value::Object(entry))
}

fn error_response(error: anyhow::Error, role: &str) -> Value {
    if let Some(api) = error.downcast_ref::<ApiError>() {
        return match api {
            ApiError::Unsupported(message) => json_headers(501, json!({ "code": UNSUPPORTED_CODE, "message": message, "details": null, "hint": null })),
            ApiError::Postgrest { code, message, details, hint } => {
                let status = match code.as_str() {
                    "PGRST202" | "PGRST205" => 404,
                    "PGRST201" => 300,
                    "PGRST200" => 400,
                    _ => 406,
                };
                json_headers(status, json!({ "code": code, "message": message, "details": details, "hint": hint }))
            }
        };
    }
    if let Some(database) = error.downcast_ref::<PgliteError>() {
        let source = database.database_error();
        let code = source.code.clone().unwrap_or_else(|| "XX000".into());
        return json_headers(status_for_sql_state(&code, role), json!({ "code": code, "message": source.message, "details": source.detail, "hint": source.hint }));
    }
    if error.downcast_ref::<serde_json::Error>().is_some() {
        // A body that is not JSON surfaces the way a thrown SyntaxError does: no SQL state, status 400.
        return json_headers(400, json!({ "code": "XX000", "message": error.to_string(), "details": null, "hint": null }));
    }
    json_headers(400, json!({ "code": "XX000", "message": error.to_string(), "details": null, "hint": null }))
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' &&  bytes.get(index + 1).is_some_and(u8::is_ascii_hexdigit) && bytes.get(index + 2).is_some_and(u8::is_ascii_hexdigit) {
            let value = u8::from_str_radix(&input[index + 1..index + 3], 16).unwrap_or(b'%');
            out.push(value);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[allow(clippy::too_many_arguments)]
fn table_request(tx: &mut Transaction<'_>, _url: &url::Url, pairs: &[(String, String)], request: &Value, headers: &Map<String, Value>, table_name: &str, schema_table: &Table, tables: &[Table], relationships: &[Relationship]) -> Result<Value> {
    let columns: Vec<String> = schema_table.columns.iter().map(|column| column.name.clone()).collect();
    let select = first(pairs, "select");
    let preference_text = headers.get("prefer").and_then(Value::as_str).unwrap_or("");
    let preferences: Vec<&str> = preference_text.split(',').map(str::trim).filter(|value| !value.is_empty()).collect();
    let method = text(request, "method");
    let accept_header = headers.get("accept").and_then(Value::as_str).unwrap_or("application/json");
    let q = quote_identifier;
    match method {
        "GET" | "HEAD" => {
            let accept = accept_header;
            let count_preferences: Vec<&str> = preferences.iter().copied().filter(|preference| preference.starts_with("count=")).collect();
            if count_preferences.iter().any(|preference| *preference != "count=exact") {
                return unsupported("planned and estimated row counts");
            }
            if preferences.iter().any(|preference| !preference.starts_with("count=")) {
                return unsupported("Prefer options on reads");
            }
            if !accept.contains("application/json") && !accept.contains("vnd.pgrst.object") {
                return unsupported(if accept.contains("csv") { "CSV responses" } else if accept.contains("plan") { "explain responses" } else { "response media type" });
            }
            let exact_count = !count_preferences.is_empty();
            let mut projection = match select {
                None => Projection { columns: columns.clone(), embeds: vec![] },
                Some(select) => parse_projection(select, &columns, tables, table_name)?,
            };
            let embedded = apply_embedded_options(&mut projection, pairs, tables)?;
            let mut params: Vec<Value> = Vec::new();
            let projection_sql = build_projection(table_name, "sandbox_table", &projection, tables, relationships, &mut params)?;
            let mut count_params: Vec<Value> = Vec::new();
            let mut where_parts: Vec<String> = Vec::new();
            let mut count_where: Vec<String> = Vec::new();
            for embed in projection.embeds.iter().filter(|embed| embed.inner) {
                where_parts.push(build_inner_condition(table_name, "sandbox_table", embed, relationships, &mut params)?);
            }
            for embed in projection.embeds.iter().filter(|embed| embed.inner) {
                count_where.push(build_inner_condition(table_name, "sandbox_table", embed, relationships, &mut count_params)?);
            }
            let (mut order_by, mut offset, mut limit) = (String::new(), 0u64, None::<u64>);
            for (key, value) in pairs {
                if key == "select" || embedded.contains(key) {
                    continue;
                }
                if key == "order" {
                    if !order_by.is_empty() {
                        return unsupported("multiple order clauses");
                    }
                    order_by = parse_order(value, &columns)?;
                } else if key == "limit" || key == "offset" {
                    let Some(number) = safe_integer(value).filter(|_| is_digits(value)) else { return unsupported(format!("{key} value")) };
                    if key == "limit" {
                        limit = Some(number);
                    } else {
                        offset = number;
                    }
                } else if key == "or" {
                    where_parts.push(parse_or(value, &columns, &mut params)?);
                    count_where.push(parse_or(value, &columns, &mut count_params)?);
                } else if key == "and" {
                    return unsupported("and filters");
                } else {
                    if !columns.contains(key) {
                        return unsupported(format!("filter column {key}"));
                    }
                    where_parts.push(parse_filter(key, value, &mut params)?);
                    count_where.push(parse_filter(key, value, &mut count_params)?);
                }
            }
            if let Some(range) = headers.get("range").and_then(Value::as_str).filter(|range| !range.is_empty()) {
                if headers.get("range-unit").and_then(Value::as_str).is_some_and(|unit| !unit.is_empty() && unit != "items") {
                    return unsupported("range unit");
                }
                let Some((start, end)) = range.split_once('-').filter(|(start, end)| is_digits(start) && (end.is_empty() || is_digits(end))) else { return unsupported("range header") };
                let (Some(start), end) = (safe_integer(start), if end.is_empty() { None } else { safe_integer(end) }) else { return unsupported("range header") };
                if (!range.ends_with('-') && end.is_none()) || end.is_some_and(|end| end < start) {
                    return unsupported("range header");
                }
                offset = start;
                limit = end.map(|end| end - start + 1);
            }
            let sql = [
                format!("SELECT {projection_sql} AS result FROM {} AS sandbox_table", q(table_name)),
                if where_parts.is_empty() { String::new() } else { format!("WHERE {}", where_parts.join(" AND ")) },
                if order_by.is_empty() { String::new() } else { format!("ORDER BY {order_by}") },
                limit.map(|limit| format!("LIMIT {limit}")).unwrap_or_default(),
                if offset > 0 { format!("OFFSET {offset}") } else { String::new() },
            ]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
            let total = if exact_count {
                let counted = tx.query(&format!("SELECT count(*)::int AS total FROM {} AS sandbox_table{}", q(table_name), if count_where.is_empty() { String::new() } else { format!(" WHERE {}", count_where.join(" AND ")) }), &count_params, None)?;
                Some(counted.rows.first().and_then(|row| row["total"].as_i64()).unwrap_or(0))
            } else {
                None
            };
            let records = result_rows(tx.query(&sql, &params, None)?.rows);
            let start = offset as i64;
            let end = if records.is_empty() { start } else { start + records.len() as i64 - 1 };
            let content_range = match total {
                None if !records.is_empty() => format!("{start}-{end}/*"),
                None => "*/*".to_owned(),
                Some(total) if !records.is_empty() => format!("{start}-{end}/{total}"),
                Some(total) => format!("*/{total}"),
            };
            let partial = total.is_some_and(|total| start > 0 || total > records.len() as i64);
            let singular = accept.contains("vnd.pgrst.object");
            let response_headers = json!({ "content-type": if singular { "application/vnd.pgrst.object+json" } else { "application/json" }, "content-range": content_range });
            let status = if partial { 206 } else { 200 };
            if singular {
                if records.len() != 1 {
                    return postgrest("PGRST116", "JSON object requested, multiple (or no) rows returned".into(), json!(format!("The result contains {} rows", records.len())), None);
                }
                return Ok(json!({ "status": status, "headers": response_headers, "body": records[0] }));
            }
            Ok(json!({ "status": status, "headers": response_headers, "body": if method == "HEAD" { Value::Null } else { json!(records) } }))
        }
        "POST" | "PATCH" | "DELETE" => {
            if pairs.iter().any(|(key, _)| !["select", "on_conflict", "columns", "or", "and"].contains(&key.as_str()) && !columns.contains(key)) {
                return unsupported("write query options");
            }
            let count_preferences: Vec<&str> = preferences.iter().copied().filter(|preference| preference.starts_with("count=")).collect();
            if count_preferences.iter().any(|preference| *preference != "count=exact") {
                return unsupported("planned and estimated row counts");
            }
            let exact_count = !count_preferences.is_empty();
            let selected = match select {
                None => Projection { columns: columns.clone(), embeds: vec![] },
                Some(select) => parse_projection(select, &columns, tables, table_name)?,
            };
            let return_preference = preferences.iter().find(|value| value.starts_with("return=")).map_or("minimal", |value| &value[7..]);
            if preferences.iter().any(|value| value.starts_with("return=") && *value != "return=minimal" && *value != "return=representation") {
                return unsupported("write return preference");
            }
            let representation = return_preference == "representation";
            let resolution = preferences.iter().find(|value| value.starts_with("resolution=")).copied();
            if resolution.is_some_and(|resolution| resolution != "resolution=merge-duplicates" && resolution != "resolution=ignore-duplicates") {
                return unsupported("upsert resolution preference");
            }
            if method != "POST" && (resolution.is_some() || pairs.iter().any(|(key, _)| key == "on_conflict")) {
                return unsupported("upsert options on non-POST write");
            }
            let missing_default = preferences.contains(&"missing=default");
            let mut where_parts: Vec<String> = Vec::new();
            let mut filter_params: Vec<Value> = Vec::new();
            for (key, value) in pairs {
                if key == "select" || key == "on_conflict" || key == "columns" {
                    continue;
                }
                if key == "or" {
                    where_parts.push(parse_or(value, &columns, &mut filter_params)?);
                } else {
                    if !columns.contains(key) {
                        return unsupported(format!("filter column {key}"));
                    }
                    where_parts.push(parse_filter(key, value, &mut filter_params)?);
                }
            }
            let accept = headers.get("accept").and_then(Value::as_str).unwrap_or("application/json");
            let parse_body = || -> Result<Value> {
                match request["body"].as_str().filter(|body| !body.is_empty()) {
                    Some(body) => Ok(serde_json::from_str(body)?),
                    None => Ok(Value::Null),
                }
            };
            let finish = |tx: &mut Transaction<'_>, statement: &str, params: &[Value], status: u16| -> Result<Value> {
                let (mut result, mut count): (Option<Vec<Value>>, Option<i64>) = (None, None);
                if representation {
                    let rows = query_write_representation(tx, statement, &selected, table_name, tables, relationships, params)?;
                    if exact_count {
                        count = Some(rows.len() as i64);
                    }
                    result = Some(rows);
                } else if exact_count {
                    count = Some(query_write_count(tx, statement, params)?);
                } else {
                    tx.query(statement, params, None)?;
                }
                write_response(status, result.as_ref(), representation, count, accept)
            };
            if method == "POST" {
                let body = parse_body()?;
                let records: Vec<Value> = match body {
                    Value::Array(items) => items,
                    other => vec![other],
                };
                if records.is_empty() || records.iter().any(|record| !record.is_object()) {
                    return unsupported("insert requires one or more JSON records");
                }
                let mut fields: Vec<String> = Vec::new();
                for record in &records {
                    for key in record.as_object().expect("records are objects").keys() {
                        if !fields.contains(key) {
                            fields.push(key.clone());
                        }
                    }
                }
                if fields.iter().any(|field| !columns.contains(field)) {
                    return unsupported("insert columns outside the applied table");
                }
                let names = fields.iter().map(|field| q(field)).collect::<Vec<_>>().join(", ");
                let mut params: Vec<Value> = Vec::new();
                let mut rows = Vec::new();
                for record in &records {
                    if fields.is_empty() {
                        rows.push("(DEFAULT)".to_owned());
                        continue;
                    }
                    let item = record.as_object().expect("records are objects");
                    let mut cells = Vec::new();
                    for field in &fields {
                        if !item.contains_key(field) && missing_default {
                            cells.push("DEFAULT".to_owned());
                        } else {
                            let value = item.get(field).filter(|value| !value.is_null()).cloned().unwrap_or(Value::Null);
                            let at = push_param(&mut params, value);
                            cells.push(format!("${at}"));
                        }
                    }
                    rows.push(format!("({})", cells.join(", ")));
                }
                let values = rows.join(", ");
                let mut conflict = String::new();
                if resolution.is_some() || pairs.iter().any(|(key, _)| key == "on_conflict") {
                    let target_text = first(pairs, "on_conflict").map(str::to_owned).unwrap_or_else(|| schema_table.columns.iter().filter(|column| column.primary_key).map(|column| column.name.clone()).collect::<Vec<_>>().join(","));
                    let target: Vec<&str> = target_text.split(',').filter(|part| !part.is_empty()).collect();
                    if target.is_empty() || target.iter().any(|column| !columns.iter().any(|candidate| candidate == column)) {
                        return unsupported("upsert on_conflict columns");
                    }
                    let target_sql = target.iter().map(|column| q(column)).collect::<Vec<_>>().join(", ");
                    conflict = if resolution == Some("resolution=ignore-duplicates") {
                        format!(" ON CONFLICT ({target_sql}) DO NOTHING")
                    } else {
                        let updates: Vec<String> = fields.iter().filter(|field| !target.contains(&field.as_str())).map(|field| format!("{} = EXCLUDED.{}", q(field), q(field))).collect();
                        let updates = if updates.is_empty() { format!("{} = EXCLUDED.{}", q(target[0]), q(target[0])) } else { updates.join(", ") };
                        format!(" ON CONFLICT ({target_sql}) DO UPDATE SET {updates}")
                    };
                }
                let statement = if fields.is_empty() {
                    if records.len() == 1 { format!("INSERT INTO {} DEFAULT VALUES{conflict}", q(table_name)) } else { format!("INSERT INTO {} VALUES {values}{conflict}", q(table_name)) }
                } else {
                    format!("INSERT INTO {} ({names}) VALUES {values}{conflict}", q(table_name))
                };
                return finish(tx, &statement, &params, 201);
            }
            if where_parts.is_empty() {
                return unsupported("update or delete without filters");
            }
            if method == "PATCH" {
                let body = parse_body()?;
                let Value::Object(map) = body else { return unsupported("update requires a JSON object") };
                if map.is_empty() || map.keys().any(|field| !columns.contains(field)) {
                    return unsupported("update columns outside the applied table");
                }
                let params: Vec<Value> = map.values().cloned().collect();
                let assignments = map.keys().enumerate().map(|(index, field)| format!("{} = ${}", q(field), index + 1)).collect::<Vec<_>>().join(", ");
                let filters: Vec<String> = where_parts.iter().map(|part| shift_placeholders(part, params.len())).collect();
                let statement = format!("UPDATE {} SET {assignments} WHERE {}", q(table_name), filters.join(" AND "));
                let write_params: Vec<Value> = params.into_iter().chain(filter_params).collect();
                return finish(tx, &statement, &write_params, if representation { 200 } else { 204 });
            }
            let statement = format!("DELETE FROM {} WHERE {}", q(table_name), where_parts.join(" AND "));
            finish(tx, &statement, &filter_params, if representation { 200 } else { 204 })
        }
        other => unsupported(format!("HTTP {other}")),
    }
}

/* ------------------------------------------------------------------ a run's database on its own thread */

/// What a run needs to know of the schema it runs against.
#[derive(Clone)]
pub struct RunSchema {
    pub tables: Vec<Table>,
    pub relationships: Vec<Relationship>,
    pub functions: Vec<DesignFunction>,
}

enum Job {
    Request(Value, std::sync::mpsc::Sender<(Value, Value)>),
    Grids(std::sync::mpsc::Sender<Result<Vec<Value>, String>>),
}

/// A run's private database. PGlite cannot move between threads, so it lives on a thread of its own
/// and is spoken to through this handle; dropping the handle drops the database.
pub struct RunDatabase {
    jobs: std::sync::Mutex<std::sync::mpsc::Sender<Job>>,
}

impl RunDatabase {
    pub fn open(sql: &str, schema: RunSchema) -> std::result::Result<Self, String> {
        let (jobs, inbox) = std::sync::mpsc::channel::<Job>();
        let (ready, started) = std::sync::mpsc::channel::<std::result::Result<(), String>>();
        let sql = sql.to_owned();
        std::thread::spawn(move || {
            let mut database = match create_run_database(&sql) {
                Ok(database) => {
                    let _ = ready.send(Ok(()));
                    database
                }
                Err(error) => {
                    let _ = ready.send(Err(error.to_string()));
                    return;
                }
            };
            for job in inbox {
                match job {
                    Job::Request(request, reply) => {
                        let _ = reply.send(handle_request(&mut database, &schema.tables, &request, &schema.relationships, &schema.functions));
                    }
                    Job::Grids(reply) => {
                        let _ = reply.send(capture_result_grids(&mut database, &schema.tables).map_err(|error| error.to_string()));
                    }
                }
            }
        });
        started.recv().map_err(|_| "The Scenario database stopped before it was ready.".to_owned())??;
        Ok(Self { jobs: std::sync::Mutex::new(jobs) })
    }

    /// Answers one request, returning the response and the request-log entry.
    pub fn handle(&self, request: Value) -> Option<(Value, Value)> {
        let (reply, answer) = std::sync::mpsc::channel();
        self.jobs.lock().ok()?.send(Job::Request(request, reply)).ok()?;
        answer.recv().ok()
    }

    /// Every table's rows as the run left them.
    pub fn grids(&self) -> std::result::Result<Vec<Value>, String> {
        let (reply, answer) = std::sync::mpsc::channel();
        self.jobs.lock().map_err(|_| "The Scenario database is unavailable.".to_owned())?.send(Job::Grids(reply)).map_err(|_| "The Scenario database stopped.".to_owned())?;
        answer.recv().map_err(|_| "The Scenario database stopped.".to_owned())?
    }
}
