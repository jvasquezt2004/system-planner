//! Reading PostgreSQL DDL into a Design (`translateDdlText` in `src/bun/assistant-ddl.ts`).
//!
//! Statements the Design can model become tables, columns, indexes, enum types, Functions,
//! triggers and policies. Anything else is kept verbatim as raw SQL, and PostgreSQL itself is the
//! judge of whether that is valid. The parse is libpg_query's, so it matches the server's.
//!
//! Three things differ from the original on purpose, because the original reads them wrongly (a
//! JSON detail: PostgreSQL's parser leaves out zero and `false`): `DEFAULT 0` and `DEFAULT false`
//! are kept as `0` and `false` (the original stores the text `[object Object]`), `numeric(p, 0)`
//! is a `numeric` with scale 0 (the original keeps the whole table as raw SQL), and a Function's
//! parameters without an explicit mode are IN parameters (the original keeps any Function that
//! has parameters as raw SQL).

use std::collections::HashMap;

use pg_query::protobuf::{self, a_const::Val, ColumnDef, Constraint, Node, RangeVar, RawStmt, TypeName};
use pg_query::NodeEnum;
use schema_domain::column_defaults::ColumnDefault;
use schema_domain::column_types::is_supported_column_type;
use schema_domain::design::{
    ColumnTypeParameters, Design, DesignColumn, DesignEnumType, DesignFunction, DesignIndex, DesignManyToManyAssociation, DesignPolicy, DesignRawStatement,
    DesignRelationship, DesignTable, DesignTrigger, DesignUniqueConstraint, FunctionArgument, IndexKey, TriggerEvent,
};
use schema_domain::geometry::CanvasPoint;
use schema_domain::index_methods::{index_method_problem, IndexedType};
use schema_domain::js;
use schema_domain::relationships::{removal_plan, RemovalTarget};
use schema_domain::sql::plan_schema_object_names;
use serde_json::Value;

/// Why a statement did not translate.
enum DdlError {
    /// The Design cannot represent this statement, so it is kept as raw SQL instead.
    Unsupported,
    /// The script itself is wrong or unsafe to apply; translation stops.
    Fatal(String),
}

type R<T> = std::result::Result<T, DdlError>;

fn unsupported<T>() -> R<T> {
    Err(DdlError::Unsupported)
}

fn fatal<T>(message: String) -> R<T> {
    Err(DdlError::Fatal(message))
}

pub type CreateId<'a> = &'a mut dyn FnMut() -> String;

/// A script read onto a Design.
pub struct Translated {
    pub design: Design,
    /// The statements the Design could not model, kept as raw SQL.
    pub kept_as_sql: Vec<String>,
    pub statement_count: usize,
}

/* ------------------------------------------------------------------ nodes */

fn node_name(node: &Node) -> Option<String> {
    match &node.node {
        Some(NodeEnum::String(text)) if !text.sval.is_empty() => Some(text.sval.clone()),
        _ => None,
    }
}

fn names_of(list: &[Node]) -> Vec<String> {
    list.iter().filter_map(node_name).collect()
}

/// `public` is the default schema, so `public.t` is just `t`.
fn without_public(parts: &[Node]) -> &[Node] {
    if parts.len() > 1 && node_name(&parts[0]).as_deref() == Some("public") { &parts[1..] } else { parts }
}

fn items(node: Option<&Node>) -> &[Node] {
    match node.and_then(|node| node.node.as_ref()) {
        Some(NodeEnum::List(list)) => &list.items,
        _ => &[],
    }
}

/// Any schema other than `public` is not modelled.
fn is_qualified(relation: &Option<RangeVar>) -> bool {
    relation.as_ref().is_some_and(|relation| !relation.schemaname.is_empty() && relation.schemaname != "public")
}

fn name_of(relation: &Option<RangeVar>) -> Option<&str> {
    relation.as_ref().map(|relation| relation.relname.as_str()).filter(|name| !name.is_empty())
}

fn type_name_text(type_name: &Option<TypeName>) -> String {
    type_name.as_ref().map(|type_name| names_of(&type_name.names).join(".")).unwrap_or_default()
}

fn nonempty(text: &str) -> Option<String> {
    if text.is_empty() { None } else { Some(text.to_owned()) }
}

fn const_string(node: Option<&Node>) -> Option<String> {
    match node?.node.as_ref()? {
        NodeEnum::String(text) if !text.sval.is_empty() => Some(text.sval.clone()),
        NodeEnum::AConst(constant) => match &constant.val {
            Some(Val::Sval(text)) if !text.sval.is_empty() => Some(text.sval.clone()),
            _ => None,
        },
        _ => None,
    }
}

fn enum_name<E: TryFrom<i32>>(value: i32, name: fn(&E) -> &'static str) -> &'static str {
    E::try_from(value).map(|parsed| name(&parsed)).unwrap_or("")
}

fn contype(constraint: &Constraint) -> protobuf::ConstrType {
    protobuf::ConstrType::try_from(constraint.contype).unwrap_or(protobuf::ConstrType::Undefined)
}

/* ------------------------------------------------------------------ types and defaults */

struct ResolvedType {
    column_type: String,
    parameters: Option<ColumnTypeParameters>,
}

fn parameters(length: Option<f64>, precision: Option<f64>, scale: Option<f64>, dimensions: Option<f64>) -> ColumnTypeParameters {
    ColumnTypeParameters { length, precision, scale, dimensions, array: None }
}

fn get_type(type_name: &Option<TypeName>) -> R<ResolvedType> {
    let names = type_name.as_ref().map(|type_name| names_of(&type_name.names)).unwrap_or_default();
    let Some(raw) = names.last() else { return unsupported() };
    let lower = raw.to_lowercase();
    let column_type = match lower.as_str() {
        "bool" => "boolean",
        "int2" => "smallint",
        "int4" | "int" => "integer",
        "int8" => "bigint",
        "float4" => "real",
        "float8" => "double precision",
        "bpchar" => "char",
        "decimal" => "numeric",
        other => other,
    }
    .to_owned();
    if !is_supported_column_type(&column_type) {
        return unsupported();
    }
    let modifiers = type_name.as_ref().map(|type_name| type_name.typmods.as_slice()).unwrap_or_default();
    if modifiers.is_empty() {
        return Ok(ResolvedType { column_type, parameters: None });
    }
    let mut values = Vec::new();
    for modifier in modifiers {
        match modifier.node.as_ref() {
            Some(NodeEnum::AConst(constant)) => match &constant.val {
                Some(Val::Ival(integer)) => values.push(integer.ival as f64),
                _ => return unsupported(),
            },
            _ => return unsupported(),
        }
    }
    let parameters = match column_type.as_str() {
        "varchar" | "char" if values.len() == 1 && values[0] > 0.0 => parameters(Some(values[0]), None, None, None),
        "numeric" if (1..=2).contains(&values.len()) && values[0] > 0.0 && values.get(1).is_none_or(|scale| *scale >= 0.0) => {
            parameters(None, Some(values[0]), values.get(1).copied(), None)
        }
        "vector" | "halfvec" | "sparsevec" if values.len() == 1 && values[0] > 0.0 => parameters(None, None, None, Some(values[0])),
        _ => return unsupported(),
    };
    Ok(ResolvedType { column_type, parameters: Some(parameters) })
}

struct Literal {
    literal_type: &'static str,
    value: String,
}

fn expression_literal(node: &Node) -> R<Option<Literal>> {
    let Some(NodeEnum::AConst(constant)) = node.node.as_ref() else { return Ok(None) };
    if constant.isnull {
        return unsupported();
    }
    Ok(match &constant.val {
        Some(Val::Sval(text)) => Some(Literal { literal_type: "text", value: text.sval.clone() }),
        Some(Val::Ival(integer)) => Some(Literal { literal_type: "integer", value: integer.ival.to_string() }),
        Some(Val::Fval(number)) => Some(Literal { literal_type: "numeric", value: number.fval.clone() }),
        Some(Val::Boolval(flag)) => Some(Literal { literal_type: "boolean", value: flag.boolval.to_string() }),
        _ => None,
    })
}

fn literal(literal_type: &str, value: String) -> ColumnDefault {
    ColumnDefault::Literal { literal_type: literal_type.to_owned(), value }
}

fn default_value(expression: Option<&Node>, column_type: &str) -> R<ColumnDefault> {
    let Some(expression) = expression else { return Ok(ColumnDefault::None) };
    match expression.node.as_ref() {
        Some(NodeEnum::TypeCast(cast)) => {
            let cast_type = type_name_text(&cast.type_name);
            let Some(value) = cast.arg.as_deref().map(expression_literal).transpose()?.flatten() else { return unsupported() };
            let target = cast_type.rsplit('.').next().unwrap_or("").to_lowercase();
            let literal_type = match target.as_str() {
                "date" => "date",
                "time" | "timetz" => "time",
                "timestamp" | "timestamptz" => "timestamp",
                "json" | "jsonb" => "json",
                _ => value.literal_type,
            };
            return Ok(literal(literal_type, value.value));
        }
        _ => {}
    }
    if let Some(value) = expression_literal(expression)? {
        let literal_type = match column_type {
            "date" => "date",
            "time" | "timetz" => "time",
            "timestamp" | "timestamptz" => "timestamp",
            "json" | "jsonb" => "json",
            _ => value.literal_type,
        };
        return Ok(literal(literal_type, value.value));
    }
    match expression.node.as_ref() {
        Some(NodeEnum::SqlvalueFunction(function)) if function.op == protobuf::SqlValueFunctionOp::SvfopCurrentTimestamp as i32 => Ok(ColumnDefault::CurrentTimestamp),
        Some(NodeEnum::FuncCall(call)) => {
            let name = names_of(&call.funcname).join(".").to_lowercase();
            if name == "now" && call.args.is_empty() {
                return Ok(ColumnDefault::CurrentTimestamp);
            }
            if name == "gen_random_uuid" && call.args.is_empty() {
                return Ok(ColumnDefault::GenerateUuid);
            }
            unsupported()
        }
        _ => unsupported(),
    }
}

/* ------------------------------------------------------------------ columns */

fn column_constraints(definition: &ColumnDef) -> Vec<&Constraint> {
    definition
        .constraints
        .iter()
        .filter_map(|entry| match entry.node.as_ref() {
            Some(NodeEnum::Constraint(constraint)) => Some(constraint.as_ref()),
            _ => None,
        })
        .collect()
}

fn find_enum<'a>(enum_types: &'a [DesignEnumType], raw: &str) -> Option<&'a DesignEnumType> {
    let last = raw.rsplit('.').next().unwrap_or("");
    enum_types.iter().find(|entry| entry.name == raw || entry.name == last)
}

/// A column and the foreign key written on it, if any.
fn column(definition: &ColumnDef, create_id: CreateId, enum_types: &[DesignEnumType]) -> R<(DesignColumn, Option<Constraint>)> {
    if !definition.generated.is_empty() || definition.coll_clause.is_some() || !definition.compression.is_empty() || definition.type_name.as_ref().is_some_and(|type_name| !type_name.array_bounds.is_empty()) {
        return unsupported();
    }
    let (mut primary_key, mut nullable, mut unique) = (false, !definition.is_not_null, false);
    let mut identity = !definition.identity.is_empty();
    let mut reference = None;
    for constraint in column_constraints(definition) {
        if constraint.deferrable || constraint.initdeferred || constraint.nulls_not_distinct || !constraint.fk_del_set_cols.is_empty() {
            return unsupported();
        }
        match contype(constraint) {
            protobuf::ConstrType::ConstrPrimary => {
                primary_key = true;
                nullable = false;
            }
            protobuf::ConstrType::ConstrNotnull => nullable = false,
            protobuf::ConstrType::ConstrNull => nullable = true,
            protobuf::ConstrType::ConstrUnique => unique = true,
            protobuf::ConstrType::ConstrForeign => reference = Some(constraint.clone()),
            protobuf::ConstrType::ConstrDefault => {}
            protobuf::ConstrType::ConstrIdentity => identity = true,
            _ => return unsupported(),
        }
    }
    let raw = type_name_text(&definition.type_name);
    let resolved = match find_enum(enum_types, &raw) {
        Some(found) => (ResolvedType { column_type: "enum".into(), parameters: None }, Some(found.id.clone())),
        None => (get_type(&definition.type_name)?, None),
    };
    let identity_mode = nonempty(&definition.identity).or_else(|| {
        column_constraints(definition).into_iter().find(|entry| contype(entry) == protobuf::ConstrType::ConstrIdentity).and_then(|entry| nonempty(&entry.generated_when))
    });
    if identity && identity_mode.as_deref().is_some_and(|mode| mode != "a") {
        return unsupported();
    }
    if identity && !["smallint", "integer", "bigint"].contains(&resolved.0.column_type.as_str()) {
        return unsupported();
    }
    let default_constraint = column_constraints(definition).into_iter().find(|entry| contype(entry) == protobuf::ConstrType::ConstrDefault);
    let id = create_id();
    let default_expression = default_constraint.and_then(|entry| entry.raw_expr.as_deref()).or(definition.raw_default.as_deref());
    let default = if identity { ColumnDefault::None } else { default_value(default_expression, &resolved.0.column_type)? };
    let column = DesignColumn {
        id,
        name: definition.colname.clone(),
        column_type: resolved.0.column_type,
        type_parameters: resolved.0.parameters,
        enum_type_id: resolved.1,
        nullable: if identity || primary_key { false } else { nullable },
        primary_key,
        unique,
        identity,
        default,
        notes: String::new(),
        extra: Default::default(),
    };
    Ok((column, reference))
}

/* ------------------------------------------------------------------ references */

fn action(value: &str) -> R<String> {
    let normalized = match value {
        "a" => "NO ACTION".to_owned(),
        "r" => "RESTRICT".to_owned(),
        "c" => "CASCADE".to_owned(),
        "n" => "SET NULL".to_owned(),
        "d" => "SET DEFAULT".to_owned(),
        other => other.to_uppercase().replace('_', " "),
    };
    if ["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"].contains(&normalized.as_str()) { Ok(normalized) } else { unsupported() }
}

fn column_is_unique_alone(table: &DesignTable, column_id: &str) -> bool {
    table.columns.iter().any(|column| column.id == column_id && column.unique)
        || table.unique_constraints.iter().flatten().any(|constraint| constraint.column_ids.len() == 1 && constraint.column_ids[0] == column_id)
        || table.indexes.iter().flatten().any(|index| index.unique == Some(true) && index.keys.len() == 1 && index.keys[0].column_id == column_id)
}

fn resolve_reference(design: &Design, source: usize, local: &str, constraint: &Constraint, create_id: CreateId) -> R<DesignRelationship> {
    let source_table = &design.tables[source];
    let local_column = source_table.columns.iter().find(|column| column.id == local).expect("the local column is on the table");
    let Some(reference_name) = name_of(&constraint.pktable) else { return unsupported() };
    let Some(target) = design.tables.iter().find(|table| table.name == reference_name) else { return unsupported() };
    if is_qualified(&constraint.pktable) {
        return unsupported();
    }
    let target_column_name = constraint.pk_attrs.first().and_then(node_name);
    let target_column = match &target_column_name {
        Some(name) => target.columns.iter().find(|column| &column.name == name),
        None => target.columns.iter().find(|column| column.primary_key),
    };
    let Some(target_column) = target_column else { return unsupported() };
    if target_column_name.is_some() && constraint.pk_attrs.len() != 1 {
        return unsupported();
    }
    if !target_column.primary_key {
        return unsupported();
    }
    if constraint.fk_attrs.len() > 1 {
        return unsupported();
    }
    let same_enum = local_column.enum_type_id.is_some() && local_column.enum_type_id == target_column.enum_type_id;
    if local_column.column_type != target_column.column_type && !same_enum {
        return unsupported();
    }
    let on_delete = if constraint.fk_del_action.is_empty() { None } else { Some(action(&constraint.fk_del_action)?) };
    let on_update = if constraint.fk_upd_action.is_empty() { None } else { Some(action(&constraint.fk_upd_action)?) };
    let unique_reference = local_column.unique || source_table.indexes.iter().flatten().any(|index| index.unique == Some(true) && index.keys.len() == 1 && index.keys[0].column_id == local_column.id);
    Ok(DesignRelationship {
        id: create_id(),
        cardinality: if unique_reference { "one-to-one" } else { "one-to-many" }.into(),
        referencing_table_id: source_table.id.clone(),
        referencing_column_id: local_column.id.clone(),
        referenced_table_id: target.id.clone(),
        on_delete,
        on_update,
    })
}

fn validate_and_infer_junction(design: &mut Design, table: usize, create_id: CreateId) {
    let table = &design.tables[table];
    if design.many_to_many_relationships.iter().any(|association| association.junction_table_id == table.id) {
        return;
    }
    let references: Vec<&DesignRelationship> = design.relationships.iter().filter(|relationship| relationship.referencing_table_id == table.id).collect();
    if references.len() != 2 || references.iter().any(|relationship| table.columns.iter().find(|column| column.id == relationship.referencing_column_id).is_some_and(|column| column.nullable)) {
        return;
    }
    let primary_keys: Vec<&DesignColumn> = table.columns.iter().filter(|column| column.primary_key).collect();
    if primary_keys.len() != 1 || references.iter().any(|relationship| relationship.referencing_column_id == primary_keys[0].id) {
        return;
    }
    let pair: Vec<&String> = references.iter().map(|relationship| &relationship.referencing_column_id).collect();
    let unique = table.unique_constraints.iter().flatten().any(|entry| entry.column_ids.len() == 2 && pair.iter().all(|column_id| entry.column_ids.contains(column_id)))
        || table.indexes.iter().flatten().any(|index| index.unique == Some(true) && index.keys.len() == 2 && pair.iter().all(|column_id| index.keys.iter().any(|key| &key.column_id == *column_id)));
    if !unique {
        return;
    }
    let (left, right) = (references[0], references[1]);
    if left.referenced_table_id == right.referenced_table_id {
        return;
    }
    let association = DesignManyToManyAssociation {
        id: create_id(),
        left_table_id: left.referenced_table_id.clone(),
        right_table_id: right.referenced_table_id.clone(),
        junction_table_id: table.id.clone(),
        left_relationship_id: left.id.clone(),
        right_relationship_id: right.id.clone(),
    };
    design.many_to_many_relationships.push(association);
}

/* ------------------------------------------------------------------ expressions in policies and triggers */

/// The parenthesised expression after a `USING`, `WITH CHECK` or `WHEN`, as written.
fn policy_expression(sql: &str, clause: &str) -> R<String> {
    let pattern = regex::Regex::new(&format!(r"(?i)\b{}\s*\(", clause.replace(' ', r"\s+"))).expect("clause pattern is valid");
    let Some(found) = pattern.find(sql) else { return Ok(String::new()) };
    let bytes = sql.as_bytes();
    let (mut depth, mut quote, mut end) = (1, 0u8, found.end());
    while end < bytes.len() {
        let ch = bytes[end];
        if quote != 0 {
            if ch == quote && bytes.get(end + 1) == Some(&quote) {
                end += 2;
                continue;
            }
            if ch == quote {
                quote = 0;
            }
            end += 1;
            continue;
        }
        if ch == b'\'' || ch == b'"' {
            quote = ch;
        } else if ch == b'(' {
            depth += 1;
        } else if ch == b')' {
            depth -= 1;
            if depth == 0 {
                return Ok(js::trim(&sql[found.end()..end]).to_owned());
            }
        }
        end += 1;
    }
    unsupported()
}

/* ------------------------------------------------------------------ raw SQL */

/// Data statements are not part of a Design: the sandbox is rebuilt from the Design alone, so they would be lost or re-run on every rebuild.
const DATA_STATEMENTS: &[&str] = &["InsertStmt", "UpdateStmt", "DeleteStmt", "SelectStmt", "MergeStmt", "CopyStmt", "CallStmt"];
/// Statements that only make sense inside one script run.
const IGNORED_STATEMENTS: &[&str] = &["TransactionStmt"];
const BEFORE_TABLES: &[&str] = &["CreateExtensionStmt", "CreateSchemaStmt", "CreateDomainStmt", "CompositeTypeStmt", "CreateRangeStmt"];

/// The statement as `{ kind, body }`, shaped like the JSON AST the original reads.
fn kind_and_body(node: &NodeEnum) -> (String, Value) {
    match serde_json::to_value(node) {
        Ok(Value::Object(map)) => map.into_iter().next().unwrap_or_default(),
        _ => Default::default(),
    }
}

fn json_text(value: &Value) -> Option<String> {
    value.as_str().filter(|text| !text.is_empty()).map(str::to_owned)
}

/// The last name in a list of String nodes, as the serialized AST shows it.
fn json_last_name(list: &Value) -> Option<String> {
    list.as_array()?.last().and_then(|item| json_text(&item["node"]["String"]["sval"]))
}

fn node_last_name(list: &[Node]) -> Option<String> {
    list.last().and_then(node_name)
}

/// What a kept statement creates and what it alters, so DROP can take it out again.
fn classify_raw_statement(kind: &str, body: &Value) -> (&'static str, Option<String>, Option<String>) {
    let mut attached_to = json_text(&body["relation"]["relname"]).or_else(|| json_text(&body["table"]["relname"]));
    let mut creates: Option<String> = None;
    let make = |label: &str, name: Option<String>| name.map(|name| format!("{label}:{name}"));
    match kind {
        "ViewStmt" => {
            creates = make("view", json_text(&body["view"]["relname"]));
            attached_to = None;
        }
        "CreateSeqStmt" => {
            creates = make("sequence", json_text(&body["sequence"]["relname"]));
            attached_to = None;
        }
        "CreateExtensionStmt" => creates = make("extension", json_text(&body["extname"])),
        "CreateSchemaStmt" => creates = make("schema", json_text(&body["schemaname"])),
        "CreateDomainStmt" => creates = make("domain", json_last_name(&body["domainname"])),
        "CompositeTypeStmt" => creates = make("type", json_text(&body["typevar"]["relname"])),
        "CreateRangeStmt" => creates = make("type", json_last_name(&body["type_name"])),
        "CreateStmt" => {
            creates = make("table", json_text(&body["relation"]["relname"]));
            attached_to = None;
        }
        "CreateTableAsStmt" => {
            let matview = body["objtype"].as_i64() == Some(protobuf::ObjectType::ObjectMatview as i64);
            creates = make(if matview { "matview" } else { "table" }, json_text(&body["into"]["rel"]["relname"]));
            attached_to = None;
        }
        "IndexStmt" => creates = make("index", json_text(&body["idxname"])),
        _ => {}
    }
    (if BEFORE_TABLES.contains(&kind) { "before" } else { "after" }, creates, attached_to)
}

/// Keeps a statement the structured Design cannot represent, to run verbatim with the generated schema.
fn keep_raw_statement(design: &mut Design, statement: Option<&NodeEnum>, sql: &str, create_id: CreateId) -> R<()> {
    let (kind, body) = statement.map(kind_and_body).unwrap_or_default();
    if IGNORED_STATEMENTS.contains(&kind.as_str()) {
        return Ok(());
    }
    if DATA_STATEMENTS.contains(&kind.as_str()) {
        let label = kind.strip_suffix("Stmt").unwrap_or(&kind).to_uppercase();
        return fatal(format!("{label} statements change data, not the schema, so they are not part of a Design. Use a Scenario to run data statements."));
    }
    let (phase, creates, attached_to) = classify_raw_statement(&kind, &body);
    design.raw_statements.get_or_insert_with(Vec::new).push(DesignRawStatement { id: create_id(), sql: sql.to_owned(), phase: phase.into(), creates, attached_to });
    Ok(())
}

const DROP_KINDS: &[(&str, &str)] = &[
    ("OBJECT_TABLE", "table"),
    ("OBJECT_VIEW", "view"),
    ("OBJECT_MATVIEW", "matview"),
    ("OBJECT_SEQUENCE", "sequence"),
    ("OBJECT_INDEX", "index"),
    ("OBJECT_EXTENSION", "extension"),
    ("OBJECT_SCHEMA", "schema"),
    ("OBJECT_DOMAIN", "domain"),
    ("OBJECT_TYPE", "type"),
];

/// The `creates` key a DROP of this object refers to, or `None` for kinds that are never kept as raw SQL.
fn drop_key(remove_type: &str, object: &Node) -> Option<String> {
    let kind = DROP_KINDS.iter().find(|(name, _)| *name == remove_type)?.1;
    let name = match object.node.as_ref()? {
        NodeEnum::TypeName(type_name) => node_last_name(&type_name.names),
        NodeEnum::List(list) => node_last_name(&list.items),
        NodeEnum::String(text) => nonempty(&text.sval),
        _ => None,
    }?;
    Some(format!("{kind}:{name}"))
}

/// Removes kept raw SQL for a dropped object. Returns false when no kept statement created it.
fn drop_raw_object(design: &mut Design, key: Option<String>) -> bool {
    let Some(key) = key else { return false };
    let Some(statements) = design.raw_statements.as_mut() else { return false };
    if !statements.iter().any(|raw| raw.creates.as_deref() == Some(key.as_str())) {
        return false;
    }
    let colon = key.find(':').unwrap_or(0);
    let (kind, name) = (&key[..colon], &key[colon + 1..]);
    let relation_like = ["table", "view", "matview"].contains(&kind);
    statements.retain(|raw| raw.creates.as_deref() != Some(key.as_str()) && !(relation_like && raw.attached_to.as_deref() == Some(name)));
    true
}

/* ------------------------------------------------------------------ statements */

struct Context<'a> {
    create_id: CreateId<'a>,
    sql: &'a [u8],
}

fn table_index(design: &Design, name: Option<&str>) -> Option<usize> {
    let name = name?;
    design.tables.iter().position(|table| table.name == name)
}

fn column_position(table: &DesignTable, name: &str) -> Option<usize> {
    table.columns.iter().position(|column| column.name == name)
}

/// Where a new table goes: beside the table it references, else after the last one.
fn place_table(design: &Design, references: &[&RangeVar]) -> CanvasPoint {
    let referenced = references.iter().filter_map(|reference| design.tables.iter().find(|table| table.name == reference.relname)).next();
    if let Some(referenced) = referenced {
        return CanvasPoint { x: referenced.position.x + 300.0, y: referenced.position.y };
    }
    if design.tables.is_empty() {
        return CanvasPoint { x: 40.0, y: 40.0 };
    }
    CanvasPoint {
        x: design.tables.iter().map(|table| table.position.x + 300.0).fold(f64::NEG_INFINITY, f64::max),
        y: design.tables.iter().map(|table| table.position.y).fold(f64::INFINITY, f64::min),
    }
}

/// Every relationship that references a column with one-to-one uniqueness becomes one-to-one.
fn refresh_cardinality(design: &mut Design, table: usize) {
    let table_id = design.tables[table].id.clone();
    let unique: Vec<(String, bool)> = design
        .relationships
        .iter()
        .filter(|relationship| relationship.referencing_table_id == table_id)
        .map(|relationship| (relationship.id.clone(), column_is_unique_alone(&design.tables[table], &relationship.referencing_column_id)))
        .collect();
    for relationship in design.relationships.iter_mut().filter(|relationship| relationship.referencing_table_id == table_id) {
        let is_unique = unique.iter().any(|(id, unique)| *id == relationship.id && *unique);
        if relationship.cardinality == "one-to-one" || is_unique {
            relationship.cardinality = "one-to-one".into();
        }
    }
}

fn remove_with_plan(design: &mut Design, table: usize, column: Option<usize>) {
    let table_id = design.tables[table].id.clone();
    let target = match column {
        Some(column) => RemovalTarget::Column { table_id: table_id.clone(), column_id: design.tables[table].columns[column].id.clone() },
        None => RemovalTarget::Table { table_id: table_id.clone() },
    };
    let removal = removal_plan(design, &target);
    let mut relationship_ids = std::collections::HashSet::new();
    for affected in &removal.relationships {
        match design.many_to_many_relationships.iter().find(|association| association.id == affected.relationship_id) {
            Some(association) => {
                relationship_ids.insert(association.left_relationship_id.clone());
                relationship_ids.insert(association.right_relationship_id.clone());
            }
            None => {
                relationship_ids.insert(affected.relationship_id.clone());
            }
        }
    }
    if let Some(column) = column {
        let column_id = design.tables[table].columns[column].id.clone();
        let index_ids: Vec<&String> = removal.indexes.iter().map(|entry| &entry.index_id).collect();
        let unique_ids: Vec<&String> = removal.unique_constraints.iter().map(|entry| &entry.constraint_id).collect();
        let trigger_ids: Vec<&String> = removal.triggers.iter().map(|entry| &entry.trigger_id).collect();
        design.relationships.retain(|relationship| !relationship_ids.contains(&relationship.id));
        design.many_to_many_relationships.retain(|association| !relationship_ids.contains(&association.left_relationship_id) && !relationship_ids.contains(&association.right_relationship_id));
        let table = &mut design.tables[table];
        table.indexes = Some(table.indexes.take().unwrap_or_default().into_iter().filter(|index| !index_ids.contains(&&index.id)).collect());
        table.unique_constraints = Some(table.unique_constraints.take().unwrap_or_default().into_iter().filter(|entry| !unique_ids.contains(&&entry.id)).collect());
        table.columns.retain(|candidate| candidate.id != column_id);
        design.triggers = Some(design.triggers.take().unwrap_or_default().into_iter().filter(|trigger| !trigger_ids.contains(&&trigger.id)).collect());
        return;
    }
    let table_relationship_ids: std::collections::HashSet<String> = design
        .relationships
        .iter()
        .filter(|relationship| relationship.referencing_table_id == table_id || relationship.referenced_table_id == table_id)
        .map(|relationship| relationship.id.clone())
        .collect();
    design.tables.remove(table);
    design.relationships.retain(|relationship| !relationship_ids.contains(&relationship.id) && !table_relationship_ids.contains(&relationship.id));
    design.triggers = Some(design.triggers.take().unwrap_or_default().into_iter().filter(|trigger| trigger.table_id != table_id).collect());
    design.many_to_many_relationships.retain(|association| {
        !relationship_ids.contains(&association.left_relationship_id) && !relationship_ids.contains(&association.right_relationship_id) && association.junction_table_id != table_id
    });
}

fn create_table(design: &mut Design, ctx: &mut Context, create: &protobuf::CreateStmt) -> R<()> {
    let table_name = name_of(&create.relation).map(str::to_owned);
    if is_qualified(&create.relation) {
        return unsupported();
    }
    if create.if_not_exists && table_name.as_ref().is_some_and(|name| design.tables.iter().any(|table| &table.name == name)) {
        return Ok(());
    }
    let Some(table_name) = table_name.filter(|name| !design.tables.iter().any(|table| &table.name == name)) else { return unsupported() };
    if !create.inh_relations.is_empty() || create.partspec.is_some() || create.partbound.is_some() || !create.constraints.is_empty() || !create.options.is_empty() {
        return unsupported();
    }
    let mut references: Vec<&RangeVar> = Vec::new();
    for element in &create.table_elts {
        match element.node.as_ref() {
            Some(NodeEnum::ColumnDef(definition)) => {
                for constraint in column_constraints(definition) {
                    if let Some(target) = &constraint.pktable {
                        references.push(target);
                    }
                }
            }
            Some(NodeEnum::Constraint(constraint)) => {
                if let Some(target) = &constraint.pktable {
                    references.push(target);
                }
            }
            _ => {}
        }
    }
    let position = place_table(design, &references);
    let mut table = DesignTable {
        id: (ctx.create_id)(),
        name: table_name,
        position,
        columns: vec![],
        indexes: None,
        unique_constraints: None,
        row_level_security: false,
        policies: vec![],
        extra: Default::default(),
    };
    let mut pending: Vec<(String, Constraint)> = Vec::new();
    for element in &create.table_elts {
        match element.node.as_ref() {
            Some(NodeEnum::ColumnDef(definition)) => {
                let (built, reference) = column(definition, ctx.create_id, design.enum_types.as_deref().unwrap_or_default())?;
                let id = built.id.clone();
                table.columns.push(built);
                if let Some(reference) = reference {
                    pending.push((id, reference));
                }
            }
            Some(NodeEnum::Constraint(constraint)) => match contype(constraint) {
                protobuf::ConstrType::ConstrUnique | protobuf::ConstrType::ConstrPrimary => {
                    if constraint.deferrable || constraint.initdeferred || constraint.nulls_not_distinct {
                        return unsupported();
                    }
                    let names = names_of(&constraint.keys);
                    let primary = contype(constraint) == protobuf::ConstrType::ConstrPrimary;
                    if primary && names.len() == 1 {
                        let Some(target) = column_position(&table, &names[0]) else { return unsupported() };
                        table.columns[target].primary_key = true;
                        table.columns[target].nullable = false;
                    } else if !primary && names.len() == 1 {
                        let Some(target) = column_position(&table, &names[0]) else { return unsupported() };
                        table.columns[target].unique = true;
                    } else if !primary && names.len() > 1 {
                        let Some(columns) = names.iter().map(|name| column_position(&table, name).map(|position| table.columns[position].id.clone())).collect::<Option<Vec<_>>>() else {
                            return unsupported();
                        };
                        table.unique_constraints.get_or_insert_with(Vec::new).push(DesignUniqueConstraint { id: (ctx.create_id)(), name: nonempty(&constraint.conname), column_ids: columns, nulls_not_distinct: None });
                    } else {
                        return unsupported();
                    }
                }
                protobuf::ConstrType::ConstrForeign => {
                    if constraint.deferrable || constraint.initdeferred || (!constraint.fk_matchtype.is_empty() && constraint.fk_matchtype != "s") || !constraint.fk_del_set_cols.is_empty() {
                        return unsupported();
                    }
                    if constraint.fk_attrs.len() != 1 {
                        return unsupported();
                    }
                    let local_name = node_name(&constraint.fk_attrs[0]);
                    let Some(local) = local_name.and_then(|name| column_position(&table, &name)) else { return unsupported() };
                    pending.push((table.columns[local].id.clone(), (**constraint).clone()));
                }
                _ => return unsupported(),
            },
            _ => return unsupported(),
        }
    }
    design.tables.push(table);
    let index = design.tables.len() - 1;
    let mut relationships = Vec::new();
    for (column_id, constraint) in &pending {
        relationships.push(resolve_reference(design, index, column_id, constraint, ctx.create_id)?);
    }
    design.relationships.extend(relationships);
    validate_and_infer_junction(design, index, ctx.create_id);
    Ok(())
}

fn rename_statement(design: &mut Design, rename: &protobuf::RenameStmt) -> R<()> {
    let rename_type = enum_name::<protobuf::ObjectType>(rename.rename_type, protobuf::ObjectType::as_str_name);
    if rename_type == "OBJECT_TYPE" {
        let names = names_of(without_public(items(rename.object.as_deref())));
        if names.len() != 1 {
            return unsupported();
        }
        let enum_types = design.enum_types.get_or_insert_with(Vec::new);
        let Some(position) = enum_types.iter().position(|entry| entry.name == names[0]) else { return unsupported() };
        if enum_types.iter().any(|entry| entry.name == rename.newname) {
            return unsupported();
        }
        enum_types[position].name = rename.newname.clone();
        return Ok(());
    }
    if is_qualified(&rename.relation) {
        return unsupported();
    }
    let Some(table) = table_index(design, name_of(&rename.relation)) else { return unsupported() };
    match rename_type {
        "OBJECT_TABLE" => design.tables[table].name = rename.newname.clone(),
        "OBJECT_COLUMN" => {
            let Some(target) = column_position(&design.tables[table], &rename.subname) else { return unsupported() };
            design.tables[table].columns[target].name = rename.newname.clone();
        }
        _ => return unsupported(),
    }
    Ok(())
}

fn alter_table(design: &mut Design, ctx: &mut Context, alter: &protobuf::AlterTableStmt) -> R<()> {
    if is_qualified(&alter.relation) {
        return unsupported();
    }
    let Some(table) = table_index(design, name_of(&alter.relation)) else { return unsupported() };
    for wrapped in &alter.cmds {
        let Some(NodeEnum::AlterTableCmd(cmd)) = wrapped.node.as_ref() else { return unsupported() };
        let subtype = enum_name::<protobuf::AlterTableType>(cmd.subtype, protobuf::AlterTableType::as_str_name);
        match subtype {
            "AT_AddConstraint" => {
                let Some(NodeEnum::Constraint(constraint)) = cmd.def.as_deref().and_then(|def| def.node.as_ref()) else { return unsupported() };
                if constraint.deferrable || constraint.initdeferred || constraint.nulls_not_distinct {
                    return unsupported();
                }
                match contype(constraint) {
                    protobuf::ConstrType::ConstrPrimary | protobuf::ConstrType::ConstrUnique => {
                        let names = names_of(&constraint.keys);
                        let primary = contype(constraint) == protobuf::ConstrType::ConstrPrimary;
                        if primary && names.len() != 1 {
                            return unsupported();
                        }
                        let mut columns = Vec::new();
                        for name in &names {
                            let Some(found) = column_position(&design.tables[table], name) else { return unsupported() };
                            columns.push(found);
                        }
                        if names.is_empty() {
                            return unsupported();
                        }
                        if primary {
                            design.tables[table].columns[columns[0]].primary_key = true;
                            design.tables[table].columns[columns[0]].nullable = false;
                        } else if columns.len() == 1 {
                            design.tables[table].columns[columns[0]].unique = true;
                        } else {
                            let column_ids = columns.iter().map(|position| design.tables[table].columns[*position].id.clone()).collect();
                            let id = (ctx.create_id)();
                            design.tables[table].unique_constraints.get_or_insert_with(Vec::new).push(DesignUniqueConstraint { id, name: nonempty(&constraint.conname), column_ids, nulls_not_distinct: None });
                        }
                    }
                    protobuf::ConstrType::ConstrForeign => {
                        if constraint.fk_attrs.len() != 1 || (!constraint.fk_matchtype.is_empty() && constraint.fk_matchtype != "s") || !constraint.fk_del_set_cols.is_empty() {
                            return unsupported();
                        }
                        let local_name = node_name(&constraint.fk_attrs[0]);
                        let Some(local) = local_name.and_then(|name| column_position(&design.tables[table], &name)) else { return unsupported() };
                        let local_id = design.tables[table].columns[local].id.clone();
                        let relationship = resolve_reference(design, table, &local_id, constraint, ctx.create_id)?;
                        design.relationships.push(relationship);
                    }
                    _ => return unsupported(),
                }
            }
            "AT_AddColumn" => {
                let Some(NodeEnum::ColumnDef(definition)) = cmd.def.as_deref().and_then(|def| def.node.as_ref()) else { return unsupported() };
                let (built, reference) = column(definition, ctx.create_id, design.enum_types.as_deref().unwrap_or_default())?;
                let id = built.id.clone();
                design.tables[table].columns.push(built);
                if let Some(reference) = reference {
                    let relationship = resolve_reference(design, table, &id, &reference, ctx.create_id)?;
                    design.relationships.push(relationship);
                }
            }
            "AT_DropColumn" => {
                let Some(target) = column_position(&design.tables[table], &cmd.name) else { return unsupported() };
                remove_with_plan(design, table, Some(target));
            }
            "AT_ColumnDefault" => {
                let Some(target) = column_position(&design.tables[table], &cmd.name) else { return unsupported() };
                let column_type = design.tables[table].columns[target].column_type.clone();
                design.tables[table].columns[target].default = match cmd.def.as_deref() {
                    Some(expression) => default_value(Some(expression), &column_type)?,
                    None => ColumnDefault::None,
                };
            }
            "AT_SetNotNull" | "AT_DropNotNull" => {
                let Some(target) = column_position(&design.tables[table], &cmd.name) else { return unsupported() };
                design.tables[table].columns[target].nullable = subtype == "AT_DropNotNull";
            }
            "AT_AlterColumnType" => {
                let Some(target) = column_position(&design.tables[table], &cmd.name) else { return unsupported() };
                let Some(NodeEnum::ColumnDef(definition)) = cmd.def.as_deref().and_then(|def| def.node.as_ref()) else { return unsupported() };
                let raw = type_name_text(&definition.type_name);
                let found = find_enum(design.enum_types.as_deref().unwrap_or_default(), &raw).map(|entry| entry.id.clone());
                let column = &mut design.tables[table].columns[target];
                match found {
                    Some(id) => {
                        column.column_type = "enum".into();
                        column.enum_type_id = Some(id);
                        column.type_parameters = None;
                    }
                    None => {
                        let resolved = get_type(&definition.type_name)?;
                        column.column_type = resolved.column_type;
                        column.type_parameters = resolved.parameters;
                    }
                }
            }
            "AT_EnableRowSecurity" => design.tables[table].row_level_security = true,
            _ => return unsupported(),
        }
    }
    refresh_cardinality(design, table);
    validate_and_infer_junction(design, table, ctx.create_id);
    Ok(())
}

fn index_name(existing: &DesignIndex, planned: &HashMap<String, String>) -> Option<String> {
    existing.name.clone().or_else(|| planned.get(&existing.id).cloned())
}

fn drop_index(design: &mut Design, drop: &protobuf::DropStmt, remove_type: &str) -> R<()> {
    for object in &drop.objects {
        let parts = without_public(items(Some(object)));
        if parts.len() > 1 {
            return unsupported();
        }
        let name = parts.first().and_then(node_name);
        // Indexes made in the editor have no stored name; they are known by the name the generated SQL gives them.
        let planned = plan_schema_object_names(design);
        let owner = design.tables.iter().position(|candidate| candidate.indexes.iter().flatten().any(|existing| index_name(existing, &planned.indexes) == name));
        let Some(owner) = owner else {
            // PostgreSQL refuses to drop an index that backs a unique constraint; the Design lets it go, so the Assistant need not know the difference.
            let constraint_owner = design
                .tables
                .iter()
                .position(|candidate| candidate.unique_constraints.iter().flatten().any(|constraint| constraint.name.clone().or_else(|| planned.unique_constraints.get(&constraint.id).cloned()) == name));
            if let Some(found) = constraint_owner {
                let kept: Vec<DesignUniqueConstraint> = design.tables[found]
                    .unique_constraints
                    .take()
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|constraint| constraint.name.clone().or_else(|| planned.unique_constraints.get(&constraint.id).cloned()) != name)
                    .collect();
                design.tables[found].unique_constraints = Some(kept);
                continue;
            }
            let key_name = |table: &DesignTable, column: &DesignColumn| Some(format!("{}_{}_key", table.name, column.name));
            let column_owner = design.tables.iter().position(|candidate| candidate.columns.iter().any(|column| column.unique && key_name(candidate, column) == name));
            if let Some(found) = column_owner {
                let table_name = design.tables[found].name.clone();
                for column in design.tables[found].columns.iter_mut() {
                    if column.unique && Some(format!("{table_name}_{}_key", column.name)) == name {
                        column.unique = false;
                    }
                }
                continue;
            }
            if drop_raw_object(design, drop_key(remove_type, object)) || drop.missing_ok {
                continue;
            }
            return unsupported();
        };
        let position = design.tables[owner].indexes.as_ref().and_then(|indexes| indexes.iter().position(|existing| index_name(existing, &planned.indexes) == name)).expect("the owner has the index");
        let removed = design.tables[owner].indexes.as_mut().expect("the owner has indexes").remove(position);
        // Dropping the only unique index on a referencing column ends the one-to-one guarantee it created.
        if removed.unique == Some(true) && removed.keys.len() == 1 {
            let column_id = removed.keys[0].column_id.clone();
            let table = &design.tables[owner];
            if table.columns.iter().any(|column| column.id == column_id) && !column_is_unique_alone(table, &column_id) {
                let table_id = table.id.clone();
                for relationship in design.relationships.iter_mut() {
                    if relationship.referencing_table_id == table_id && relationship.referencing_column_id == column_id && relationship.cardinality == "one-to-one" {
                        relationship.cardinality = "one-to-many".into();
                    }
                }
            }
        }
    }
    Ok(())
}

fn drop_statement(design: &mut Design, drop: &protobuf::DropStmt) -> R<()> {
    let remove_type = enum_name::<protobuf::ObjectType>(drop.remove_type, protobuf::ObjectType::as_str_name);
    match remove_type {
        "OBJECT_INDEX" => return drop_index(design, drop, remove_type),
        "OBJECT_TYPE" => {
            for object in &drop.objects {
                let names = match object.node.as_ref() {
                    Some(NodeEnum::TypeName(type_name)) => names_of(without_public(&type_name.names)),
                    _ => vec![],
                };
                if names.len() != 1 {
                    return unsupported();
                }
                let Some(position) = design.enum_types.iter().flatten().position(|entry| entry.name == names[0]) else {
                    if drop_raw_object(design, drop_key(remove_type, object)) || drop.missing_ok {
                        continue;
                    }
                    return unsupported();
                };
                let enum_type = design.enum_types.as_ref().expect("the enum exists")[position].clone();
                let users: Vec<String> = design
                    .tables
                    .iter()
                    .flat_map(|table| table.columns.iter().filter(|column| column.enum_type_id.as_deref() == Some(enum_type.id.as_str())).map(move |column| format!("{}.{}", table.name, column.name)))
                    .collect();
                if !users.is_empty() {
                    return fatal(format!("Enum type {} is still used by {}; drop or change those columns first.", enum_type.name, users.join(", ")));
                }
                design.enum_types.as_mut().expect("the enum exists").remove(position);
            }
            return Ok(());
        }
        "OBJECT_TABLE" => {}
        _ => {
            // Anything else was either kept as raw SQL (and is removed with it) or is dropped by a raw statement of its own.
            if drop.objects.is_empty() || !drop.objects.iter().all(|object| drop_raw_object(design, drop_key(remove_type, object))) {
                return unsupported();
            }
            return Ok(());
        }
    }
    // CASCADE adds nothing here: dependents are always listed for the designer's confirmation.
    for object in &drop.objects {
        let parts = without_public(items(Some(object)));
        if parts.len() > 1 {
            return unsupported();
        }
        let name = parts.last().and_then(node_name);
        let Some(table) = table_index(design, name.as_deref()) else {
            if drop_raw_object(design, drop_key(remove_type, object)) || drop.missing_ok {
                continue;
            }
            return unsupported();
        };
        remove_with_plan(design, table, None);
    }
    Ok(())
}

fn create_index(design: &mut Design, ctx: &mut Context, index: &protobuf::IndexStmt) -> R<()> {
    if is_qualified(&index.relation) {
        return unsupported();
    }
    let Some(table) = table_index(design, name_of(&index.relation)) else { return unsupported() };
    if index.where_clause.is_some() || !index.index_including_params.is_empty() {
        return unsupported();
    }
    // Index names are unique in a schema. Repeating an identical index is harmless; a different one under the same name is a mistake.
    if !index.idxname.is_empty() {
        let planned = plan_schema_object_names(design);
        let same_name = design.tables.iter().enumerate().find_map(|(position, candidate)| {
            candidate.indexes.iter().flatten().find(|existing| index_name(existing, &planned.indexes).as_deref() == Some(index.idxname.as_str())).map(|existing| (position, existing))
        });
        if let Some((owner, existing)) = same_name {
            let wanted: Vec<String> = index
                .index_params
                .iter()
                .map(|entry| match entry.node.as_ref() {
                    Some(NodeEnum::IndexElem(elem)) => elem.name.clone(),
                    _ => String::new(),
                })
                .collect();
            let have: Vec<String> = existing
                .keys
                .iter()
                .map(|key| design.tables[owner].columns.iter().find(|column| column.id == key.column_id).map(|column| column.name.clone()).unwrap_or_default())
                .collect();
            if index.if_not_exists || (Some(design.tables[owner].name.as_str()) == name_of(&index.relation) && wanted.join(",") == have.join(",") && index.unique == (existing.unique == Some(true))) {
                return Ok(());
            }
            return fatal(format!("Index {} already exists on {}; choose another name or drop it first.", index.idxname, design.tables[owner].name));
        }
    }
    let mut keys = Vec::new();
    for entry in &index.index_params {
        let Some(NodeEnum::IndexElem(elem)) = entry.node.as_ref() else { return unsupported() };
        if elem.name.is_empty() {
            return unsupported();
        }
        let ordering = enum_name::<protobuf::SortByDir>(elem.ordering, protobuf::SortByDir::as_str_name);
        let nulls_ordering = enum_name::<protobuf::SortByNulls>(elem.nulls_ordering, protobuf::SortByNulls::as_str_name);
        if !["", "SORTBY_DEFAULT", "SORTBY_ASC", "SORTBY_DESC"].contains(&ordering) || !["", "SORTBY_NULLS_DEFAULT", "SORTBY_NULLS_FIRST", "SORTBY_NULLS_LAST"].contains(&nulls_ordering) {
            return unsupported();
        }
        let operator_class = elem.opclass.iter().filter_map(node_name).next_back();
        let Some(found) = column_position(&design.tables[table], &elem.name) else { return unsupported() };
        keys.push(IndexKey {
            column_id: design.tables[table].columns[found].id.clone(),
            order: match ordering {
                "SORTBY_ASC" => Some("asc".into()),
                "SORTBY_DESC" => Some("desc".into()),
                _ => None,
            },
            nulls: match nulls_ordering {
                "SORTBY_NULLS_FIRST" => Some("first".into()),
                "SORTBY_NULLS_LAST" => Some("last".into()),
                _ => None,
            },
            operator_class,
        });
    }
    if keys.is_empty() {
        return unsupported();
    }
    let data = DesignIndex {
        id: (ctx.create_id)(),
        name: nonempty(&index.idxname),
        method: if index.access_method.is_empty() { "btree".into() } else { index.access_method.clone() },
        keys,
        unique: Some(index.unique),
        nulls_not_distinct: None,
        include_column_ids: None,
        options: None,
    };
    let types: Vec<IndexedType> = data
        .keys
        .iter()
        .filter_map(|key| design.tables[table].columns.iter().find(|candidate| candidate.id == key.column_id))
        .map(|column| IndexedType {
            column_type: column.column_type.as_str(),
            array: column.type_parameters.as_ref().and_then(|parameters| parameters.array) == Some(true),
            dimensions: column.type_parameters.as_ref().and_then(|parameters| parameters.dimensions),
        })
        .collect();
    if index_method_problem(&data, &types).is_some() {
        return unsupported();
    }
    drop(types);
    let (unique, first_column) = (data.unique == Some(true), data.keys[0].column_id.clone());
    let single = data.keys.len() == 1;
    design.tables[table].indexes.get_or_insert_with(Vec::new).push(data);
    if unique && single {
        let table_id = design.tables[table].id.clone();
        for relationship in design.relationships.iter_mut() {
            if relationship.referencing_table_id == table_id && relationship.referencing_column_id == first_column {
                relationship.cardinality = "one-to-one".into();
            }
        }
    }
    validate_and_infer_junction(design, table, ctx.create_id);
    Ok(())
}

fn alter_enum(design: &mut Design, alter: &protobuf::AlterEnumStmt) -> R<()> {
    let names = names_of(without_public(&alter.type_name));
    if names.len() != 1 {
        return unsupported();
    }
    let Some(position) = design.enum_types.iter().flatten().position(|entry| entry.name == names[0]) else { return unsupported() };
    let enum_id = design.enum_types.as_ref().expect("the enum exists")[position].id.clone();
    let labels = &mut design.enum_types.as_mut().expect("the enum exists")[position].labels;
    if !alter.old_val.is_empty() {
        let Some(at) = labels.iter().position(|label| *label == alter.old_val) else { return unsupported() };
        if labels.contains(&alter.new_val) {
            return unsupported();
        }
        labels[at] = alter.new_val.clone();
        // Defaults written with the old label would otherwise point at a value that no longer exists.
        for table in design.tables.iter_mut() {
            for column in table.columns.iter_mut() {
                if column.enum_type_id.as_deref() == Some(enum_id.as_str()) {
                    if let ColumnDefault::Literal { value, .. } = &mut column.default {
                        if *value == alter.old_val {
                            *value = alter.new_val.clone();
                        }
                    }
                }
            }
        }
        return Ok(());
    }
    if labels.contains(&alter.new_val) {
        if alter.skip_if_new_val_exists {
            return Ok(());
        }
        return unsupported();
    }
    if !alter.new_val_neighbor.is_empty() {
        let Some(neighbor) = labels.iter().position(|label| *label == alter.new_val_neighbor) else { return unsupported() };
        labels.insert(if alter.new_val_is_after { neighbor + 1 } else { neighbor }, alter.new_val.clone());
    } else {
        labels.push(alter.new_val.clone());
    }
    Ok(())
}

fn create_function(design: &mut Design, ctx: &mut Context, create: &protobuf::CreateFunctionStmt) -> R<()> {
    if create.is_procedure {
        return unsupported();
    }
    let signature = names_of(&create.funcname);
    let Some(name) = signature.last().cloned() else { return unsupported() };
    if signature.len() > 1 {
        return unsupported();
    }
    let mut options: HashMap<&str, Option<&Node>> = HashMap::new();
    for item in &create.options {
        if let Some(NodeEnum::DefElem(option)) = item.node.as_ref() {
            if !option.defname.is_empty() {
                options.insert(option.defname.as_str(), option.arg.as_deref());
            }
        }
    }
    if options.keys().any(|option| !["language", "as", "volatility", "security"].contains(option)) {
        return unsupported();
    }
    let option = |key: &str| options.get(key).copied().flatten();
    let language = const_string(option("language"));
    let return_type = type_name_text(&create.return_type);
    let body = const_string(option("as")).or_else(|| match option("as").and_then(|node| node.node.as_ref()) {
        Some(NodeEnum::List(list)) => Some(list.items.iter().map(|item| const_string(Some(item)).unwrap_or_default()).collect::<Vec<_>>().join("\n")),
        _ => None,
    });
    let (Some(body), Some(language)) = (body.filter(|body| !body.is_empty()), language) else { return unsupported() };
    if return_type.is_empty() || (language != "sql" && language != "plpgsql") {
        return unsupported();
    }
    let mut arguments = Vec::new();
    for parameter in &create.parameters {
        let Some(NodeEnum::FunctionParameter(parameter)) = parameter.node.as_ref() else { return unsupported() };
        let mode = enum_name::<protobuf::FunctionParameterMode>(parameter.mode, protobuf::FunctionParameterMode::as_str_name);
        if !["", "FUNC_PARAM_IN", "FUNC_PARAM_DEFAULT"].contains(&mode) || parameter.defexpr.is_some() {
            return unsupported();
        }
        let argument_name = if parameter.name.is_empty() { format!("arg{}", (ctx.create_id)().chars().take(8).collect::<String>()) } else { parameter.name.clone() };
        arguments.push(FunctionArgument { name: argument_name, argument_type: type_name_text(&parameter.arg_type) });
    }
    let volatility = const_string(option("volatility")).map(|text| text.to_lowercase());
    let security = match option("security").and_then(|node| node.node.as_ref()) {
        Some(NodeEnum::Boolean(flag)) => Some(if flag.boolval { "definer" } else { "invoker" }.to_owned()),
        other => other.and_then(|_| const_string(option("security"))).map(|text| text.to_lowercase()),
    };
    if security.as_deref().is_some_and(|security| security != "definer" && security != "invoker") {
        return unsupported();
    }
    let id = design.functions.iter().flatten().find(|function| function.name == name).map(|function| function.id.clone()).unwrap_or_else(|| (ctx.create_id)());
    let function = DesignFunction {
        id,
        name: name.clone(),
        arguments,
        return_type,
        returns_set: create.return_type.as_ref().is_some_and(|type_name| type_name.setof),
        language,
        volatility: match volatility.as_deref() {
            Some("immutable") => "immutable",
            Some("stable") => "stable",
            _ => "volatile",
        }
        .into(),
        security: if security.as_deref() == Some("definer") { "definer" } else { "invoker" }.into(),
        body,
        table_dependencies: None,
    };
    let functions = design.functions.get_or_insert_with(Vec::new);
    functions.retain(|existing| existing.name != name);
    functions.push(function);
    Ok(())
}

fn create_trigger(design: &mut Design, ctx: &mut Context, create: &protobuf::CreateTrigStmt, statement_sql: &str) -> R<()> {
    let Some(table) = table_index(design, name_of(&create.relation)) else { return unsupported() };
    let function_name = names_of(&create.funcname).pop();
    let Some(function) = design.functions.iter().flatten().find(|entry| Some(&entry.name) == function_name.as_ref()).map(|entry| entry.id.clone()) else { return unsupported() };
    if create.isconstraint || !create.args.is_empty() || !create.transition_rels.is_empty() {
        return unsupported();
    }
    let mut events = Vec::new();
    for (flag, event) in [(4, "INSERT"), (8, "DELETE"), (16, "UPDATE"), (32, "TRUNCATE")] {
        if create.events & flag == 0 {
            continue;
        }
        let mut column_ids = Vec::new();
        if event == "UPDATE" {
            for column in &create.columns {
                let name = node_name(column);
                let Some(found) = name.and_then(|name| design.tables[table].columns.iter().find(|entry| entry.name == name)) else { return unsupported() };
                column_ids.push(found.id.clone());
            }
        }
        events.push(TriggerEvent { event: event.into(), column_ids: if column_ids.is_empty() { None } else { Some(column_ids) } });
    }
    let timing = match create.timing {
        64 => "INSTEAD OF",
        2 => "BEFORE",
        _ => "AFTER",
    };
    let mut when = String::new();
    if create.when_clause.is_some() {
        when = policy_expression(statement_sql, "WHEN")?;
        if when.is_empty() {
            return unsupported();
        }
    }
    design.triggers.get_or_insert_with(Vec::new).push(DesignTrigger {
        id: (ctx.create_id)(),
        name: create.trigname.clone(),
        table_id: design.tables[table].id.clone(),
        timing: timing.into(),
        events,
        level: if create.row { "ROW" } else { "STATEMENT" }.into(),
        function_id: function,
        when,
    });
    Ok(())
}

fn create_policy(design: &mut Design, ctx: &mut Context, create: &protobuf::CreatePolicyStmt, statement_sql: &str) -> R<()> {
    let Some(table) = table_index(design, name_of(&create.table)) else { return unsupported() };
    let command = match create.cmd_name.to_uppercase().as_str() {
        "ALL" => "ALL",
        "SELECT" => "SELECT",
        "INSERT" => "INSERT",
        "UPDATE" => "UPDATE",
        "DELETE" => "DELETE",
        _ => return unsupported(),
    };
    let roles: Vec<String> = create
        .roles
        .iter()
        .map(|role| match role.node.as_ref() {
            Some(NodeEnum::RoleSpec(spec)) if !spec.rolename.is_empty() => spec.rolename.clone(),
            _ => "public".into(),
        })
        .collect();
    let using = if create.qual.is_some() { policy_expression(statement_sql, "USING")? } else { String::new() };
    let with_check = if create.with_check.is_some() { policy_expression(statement_sql, "WITH CHECK")? } else { String::new() };
    if (create.qual.is_some() && using.is_empty()) || (create.with_check.is_some() && with_check.is_empty()) {
        return unsupported();
    }
    design.tables[table].policies.push(DesignPolicy {
        id: (ctx.create_id)(),
        name: create.policy_name.clone(),
        command: command.into(),
        roles,
        mode: if create.permissive { "permissive" } else { "restrictive" }.into(),
        using,
        with_check,
    });
    Ok(())
}

fn comment_statement(design: &mut Design, comment: &protobuf::CommentStmt) -> R<()> {
    if comment.objtype != protobuf::ObjectType::ObjectColumn as i32 {
        return unsupported();
    }
    let names = names_of(items(comment.object.as_deref()));
    if names.len() != 2 {
        return unsupported();
    }
    let Some(table) = table_index(design, Some(&names[0])) else { return unsupported() };
    let Some(target) = column_position(&design.tables[table], &names[1]) else { return unsupported() };
    design.tables[table].columns[target].notes = comment.comment.clone();
    Ok(())
}

fn translate_one(design: &mut Design, ctx: &mut Context, statement: &NodeEnum, statement_sql: &str) -> R<()> {
    match statement {
        NodeEnum::CreateStmt(create) => create_table(design, ctx, create),
        NodeEnum::RenameStmt(rename) => rename_statement(design, rename),
        NodeEnum::AlterTableStmt(alter) => alter_table(design, ctx, alter),
        NodeEnum::DropStmt(drop) => drop_statement(design, drop),
        NodeEnum::IndexStmt(index) => create_index(design, ctx, index),
        NodeEnum::AlterEnumStmt(alter) => alter_enum(design, alter),
        NodeEnum::CreateEnumStmt(create) => {
            let Some(name) = node_last_name(&create.type_name) else { return unsupported() };
            if design.enum_types.iter().flatten().any(|entry| entry.name == name) {
                return unsupported();
            }
            let labels = create.vals.iter().filter_map(|value| const_string(Some(value))).collect();
            design.enum_types.get_or_insert_with(Vec::new).push(DesignEnumType { id: (ctx.create_id)(), name, labels });
            Ok(())
        }
        NodeEnum::CreateFunctionStmt(create) => create_function(design, ctx, create),
        NodeEnum::CreateTrigStmt(create) => create_trigger(design, ctx, create, statement_sql),
        NodeEnum::CreatePolicyStmt(create) => create_policy(design, ctx, create, statement_sql),
        NodeEnum::CommentStmt(comment) => comment_statement(design, comment),
        _ => unsupported(),
    }
}

/// The position of the `;` that comes next, looking past whitespace and comments only.
fn next_semicolon(sql: &[u8], from: usize) -> Option<usize> {
    let mut at = from;
    while at < sql.len() {
        match sql[at] {
            b';' => return Some(at),
            byte if byte.is_ascii_whitespace() => at += 1,
            b'-' if sql.get(at + 1) == Some(&b'-') => {
                while at < sql.len() && sql[at] != b'\n' {
                    at += 1;
                }
            }
            b'/' if sql.get(at + 1) == Some(&b'*') => {
                let mut depth = 0;
                while at < sql.len() {
                    if sql[at] == b'/' && sql.get(at + 1) == Some(&b'*') {
                        depth += 1;
                        at += 2;
                    } else if sql[at] == b'*' && sql.get(at + 1) == Some(&b'/') {
                        depth -= 1;
                        at += 2;
                        if depth == 0 {
                            break;
                        }
                    } else {
                        at += 1;
                    }
                }
            }
            _ => return None,
        }
    }
    None
}

/// Where each statement's text runs, the way the original's parser reports it: from just after the
/// `;` that ended the previous statement (so a comment above a statement belongs to it) up to the
/// `;` that ends it, or the end of the text.
fn statement_ranges(sql: &[u8], statements: &[RawStmt]) -> Vec<(usize, usize)> {
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for (index, item) in statements.iter().enumerate() {
        let location = (item.stmt_location.max(0) as usize).min(sql.len());
        let end = if item.stmt_len > 0 { (location + item.stmt_len as usize).min(sql.len()) } else { sql.len() };
        let start = match ranges.last() {
            None => 0,
            Some(&(_, previous_stop)) => {
                let (mut last, mut at) = (None, previous_stop);
                while let Some(position) = next_semicolon(sql, at) {
                    last = Some(position);
                    at = position + 1;
                }
                last.map_or(location, |position| position + 1)
            }
        };
        let _ = index;
        let stop = next_semicolon(sql, end).unwrap_or(sql.len());
        ranges.push((start, stop));
    }
    ranges
}

fn translate_statements(design: &mut Design, ctx: &mut Context, statements: &[RawStmt]) -> std::result::Result<(), String> {
    let ranges = statement_ranges(ctx.sql, statements);
    for (item, (start, stop)) in statements.iter().zip(ranges) {
        let statement = item.stmt.as_deref().and_then(|node| node.node.as_ref());
        let statement_sql = js::trim(&String::from_utf8_lossy(&ctx.sql[start..stop.max(start)])).to_owned();
        let snapshot = design.clone();
        let outcome = match statement {
            Some(statement) => translate_one(design, ctx, statement, &statement_sql),
            None => unsupported(),
        };
        match outcome {
            Ok(()) => {}
            Err(DdlError::Fatal(message)) => return Err(message),
            // SQL the Design cannot represent is kept verbatim; PostgreSQL itself is the judge of whether it is valid.
            Err(DdlError::Unsupported) => {
                *design = snapshot;
                match keep_raw_statement(design, statement, &statement_sql, ctx.create_id) {
                    Ok(()) => {}
                    Err(DdlError::Fatal(message)) => return Err(message),
                    Err(DdlError::Unsupported) => unreachable!("keeping a statement does not fail as unsupported"),
                }
            }
        }
    }
    Ok(())
}

/// Translates a whole script onto a copy of `base`, without a workspace. Used to read a schema file.
pub fn translate_ddl_text(base: &Design, sql: &str, create_id: CreateId) -> std::result::Result<Translated, String> {
    if js::trim(sql).is_empty() {
        return Err("Query cannot be empty".into());
    }
    if sql.contains('\0') {
        return Err("Query must not contain a NUL (U+0000) character".into());
    }
    let parsed = pg_query::parse(sql, pg_query::ParserOptions::default()).map_err(|error| match error {
        pg_query::Error::Parse(message) => message,
        other => other.to_string(),
    })?;
    let mut design = base.clone();
    let statements = &parsed.protobuf.stmts;
    let mut context = Context { create_id, sql: sql.as_bytes() };
    translate_statements(&mut design, &mut context, statements)?;
    let known: std::collections::HashSet<&str> = base.raw_statements.iter().flatten().map(|raw| raw.id.as_str()).collect();
    let kept_as_sql = design.raw_statements.iter().flatten().filter(|raw| !known.contains(raw.id.as_str())).map(|raw| raw.sql.clone()).collect();
    Ok(Translated { design, kept_as_sql, statement_count: statements.len() })
}
