//! Pure Design edits behind the workspace actions, ported from the helpers in
//! `src/bun/workspace.ts`.

use schema_domain::column_defaults::{is_column_default, normalize_column_default, ColumnDefault};
use schema_domain::column_types::{find_column_type, is_supported_column_type};
use schema_domain::design::{ColumnTypeParameters, Design, DesignColumn, DesignTable};
use schema_domain::geometry::CanvasPoint;
use schema_domain::js;
use schema_domain::relationships::many_to_many_association_for_relationship;
use serde_json::{Map, Value};

type Result<T> = std::result::Result<T, String>;

pub fn require_number(value: f64, label: &str) -> Result<f64> {
    if value.is_finite() { Ok(value) } else { Err(format!("{label} must be a finite number.")) }
}

pub fn require_point(point: CanvasPoint, label: &str) -> Result<CanvasPoint> {
    Ok(CanvasPoint { x: js::round2(require_number(point.x, label)?), y: js::round2(require_number(point.y, label)?) })
}

/// Where the next table card goes: a grid of three columns.
pub fn default_table_position(design: &Design) -> CanvasPoint {
    let index = design.tables.len();
    CanvasPoint { x: 40.0 + (index % 3) as f64 * 300.0, y: 40.0 + (index / 3) as f64 * 240.0 }
}

pub fn require_table<'a>(design: &'a Design, table_id: &str) -> Result<&'a DesignTable> {
    design.tables.iter().find(|table| table.id == table_id).ok_or_else(|| "That table could not be found.".to_owned())
}

fn require_column<'a>(table: &'a DesignTable, column_id: &str) -> Result<&'a DesignColumn> {
    table.columns.iter().find(|column| column.id == column_id).ok_or_else(|| "That column could not be found.".to_owned())
}

pub fn replace_table(design: &Design, table: DesignTable) -> Design {
    Design { tables: design.tables.iter().map(|candidate| if candidate.id == table.id { table.clone() } else { candidate.clone() }).collect(), ..design.clone() }
}

pub fn next_column_name(table: &DesignTable) -> String {
    let names: std::collections::HashSet<&str> = table.columns.iter().map(|column| column.name.as_str()).collect();
    if !names.contains("column") {
        return "column".into();
    }
    let mut index = 2;
    while names.contains(format!("column_{index}").as_str()) {
        index += 1;
    }
    format!("column_{index}")
}

pub fn require_name(value: &str, label: &str) -> Result<String> {
    let name = js::trim(value);
    if name.is_empty() { Err(format!("{label} is required.")) } else { Ok(name.to_owned()) }
}

pub fn require_column_type(value: &str) -> Result<String> {
    if is_supported_column_type(value) { Ok(value.to_owned()) } else { Err("That column type is not supported.".into()) }
}

pub fn new_column(id: String, name: String, column_type: String) -> DesignColumn {
    DesignColumn {
        id,
        name,
        column_type,
        type_parameters: None,
        enum_type_id: None,
        nullable: true,
        primary_key: false,
        unique: false,
        identity: false,
        default: ColumnDefault::None,
        notes: String::new(),
        extra: Map::new(),
    }
}

/// A new table starts with an identity `id` primary key.
pub fn create_default_table(name: &str, position: CanvasPoint, create_id: &mut dyn FnMut() -> String) -> DesignTable {
    let table_id = create_id();
    let mut id_column = new_column(create_id(), "id".into(), "bigint".into());
    id_column.nullable = false;
    id_column.primary_key = true;
    id_column.identity = true;
    DesignTable {
        id: table_id,
        name: name.to_owned(),
        position,
        columns: vec![id_column],
        indexes: None,
        unique_constraints: None,
        row_level_security: false,
        policies: vec![],
        extra: Map::new(),
    }
}

/// Editable column properties after validation. Absent means "leave as it is".
#[derive(Default)]
struct ColumnChanges {
    keys: Vec<String>,
    name: Option<String>,
    column_type: Option<String>,
    enum_type_id: Option<String>,
    type_parameters: Option<ColumnTypeParameters>,
    nullable: Option<bool>,
    primary_key: Option<bool>,
    unique: Option<bool>,
    notes: Option<String>,
    identity: Option<bool>,
    default: Option<ColumnDefault>,
}

fn boolean(changes: &Map<String, Value>, key: &str) -> Result<Option<bool>> {
    match changes.get(key) {
        None => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(format!("Column {key} must be true or false.")),
    }
}

/// `normalizeColumnChanges`: each present field is validated, in the original's order.
fn normalize_column_changes(changes: &Value) -> Result<ColumnChanges> {
    let Some(changes) = changes.as_object() else { return Err("Column changes are required.".into()) };
    let mut normalized = ColumnChanges { keys: changes.keys().cloned().collect(), ..Default::default() };
    if let Some(value) = changes.get("name") {
        normalized.name = Some(match value.as_str() {
            Some(text) => require_name(text, "Column name")?,
            None => return Err("Column name must be text.".into()),
        });
    }
    if let Some(value) = changes.get("type") {
        normalized.column_type = Some(match value.as_str() {
            Some(text) => require_column_type(text)?,
            None => return Err("That column type is not supported.".into()),
        });
    }
    if let Some(value) = changes.get("enumTypeId") {
        match value.as_str() {
            Some(text) if !js::trim(text).is_empty() => normalized.enum_type_id = Some(text.to_owned()),
            _ => return Err("Enum type references need an enum type id.".into()),
        }
    }
    if let Some(value) = changes.get("typeParameters") {
        let Some(parameters) = value.as_object() else { return Err("Column type parameters must be structured values.".into()) };
        for (key, value) in parameters {
            if !["length", "precision", "scale", "dimensions", "array"].contains(&key.as_str()) {
                return Err("Column type parameters include an unsupported field.".into());
            }
            let invalid_number = match js::integer(value) {
                None => true,
                Some(number) if key == "scale" => !(-1000.0..=1000.0).contains(&number),
                Some(number) => number < 0.0,
            };
            if key != "array" && invalid_number {
                return Err("Column type parameters must be valid integers.".into());
            }
        }
        if parameters.get("array").is_some_and(|array| !array.is_boolean()) {
            return Err("Array type must be true or false.".into());
        }
        normalized.type_parameters = Some(serde_json::from_value(value.clone()).map_err(|error| error.to_string())?);
    }
    normalized.nullable = boolean(changes, "nullable")?;
    normalized.primary_key = boolean(changes, "primaryKey")?;
    normalized.unique = boolean(changes, "unique")?;
    if let Some(value) = changes.get("notes") {
        match value.as_str() {
            Some(text) => normalized.notes = Some(js::trim(text).to_owned()),
            None => return Err("Column notes must be text.".into()),
        }
    }
    normalized.identity = boolean(changes, "identity")?;
    if let Some(value) = changes.get("default") {
        if !is_column_default(value) {
            return Err("That column default is not supported.".into());
        }
        let cleaned = normalize_column_default(value.as_object().expect("checked"));
        normalized.default = Some(serde_json::from_value(cleaned).map_err(|error| error.to_string())?);
    }
    Ok(normalized)
}

fn same_column(a: &DesignColumn, b: &DesignColumn) -> bool {
    a.id == b.id
        && a.name == b.name
        && a.column_type == b.column_type
        && a.enum_type_id == b.enum_type_id
        && a.type_parameters.clone().map(|p| serde_json::to_value(p).unwrap()) == b.type_parameters.clone().map(|p| serde_json::to_value(p).unwrap())
        && a.nullable == b.nullable
        && a.primary_key == b.primary_key
        && a.unique == b.unique
        && a.identity == b.identity
        && a.default == b.default
        && a.notes == b.notes
}

pub enum ColumnEdit {
    Unchanged,
    /// A change PostgreSQL would see.
    Schema(Design),
    /// Only the designer's note changed; the SQL and sandbox stay as they are.
    NotesOnly(Design),
}

pub fn update_column(design: &Design, table_id: &str, column_id: &str, changes: &Value) -> Result<ColumnEdit> {
    let table = require_table(design, table_id)?;
    let column = require_column(table, column_id)?;
    let changes = normalize_column_changes(changes)?;

    let is_junction_reference = design.relationships.iter().any(|relationship| {
        relationship.referencing_table_id == table.id
            && relationship.referencing_column_id == column.id
            && many_to_many_association_for_relationship(design, &relationship.id).is_some()
    });
    let supplies_value = changes.nullable == Some(true)
        || changes.primary_key == Some(true)
        || changes.unique == Some(true)
        || changes.identity == Some(true)
        || changes.default.as_ref().is_some_and(|default| *default != ColumnDefault::None);
    if is_junction_reference && supplies_value {
        return Err("Many-to-many junction references must remain required and cannot own individual defaults, keys, or uniqueness.".into());
    }

    let mut updated = column.clone();
    if let Some(name) = &changes.name {
        updated.name = name.clone();
    }
    if let Some(column_type) = &changes.column_type {
        updated.column_type = column_type.clone();
    }
    if let Some(id) = &changes.enum_type_id {
        updated.enum_type_id = Some(id.clone());
    }
    if let Some(parameters) = &changes.type_parameters {
        updated.type_parameters = Some(parameters.clone());
    }
    if let Some(value) = changes.nullable {
        updated.nullable = value;
    }
    if let Some(value) = changes.primary_key {
        updated.primary_key = value;
    }
    if let Some(value) = changes.unique {
        updated.unique = value;
    }
    if let Some(value) = &changes.notes {
        updated.notes = value.clone();
    }
    if let Some(value) = changes.identity {
        updated.identity = value;
    }
    if let Some(value) = &changes.default {
        updated.default = value.clone();
    }
    // Identity generation only exists for integer types, so changing the type to another
    // family drops it in the same visible edit.
    if let Some(new_type) = &changes.column_type {
        if *new_type != column.column_type && column.identity && !find_column_type(new_type).is_some_and(|info| info.identity) {
            updated.identity = false;
        }
    }

    let columns: Vec<DesignColumn> = table
        .columns
        .iter()
        .map(|candidate| {
            if candidate.id == column.id {
                return updated.clone();
            }
            // A table has a single-column key, so choosing a new key column demotes the previous one in the same edit.
            if updated.primary_key && candidate.primary_key {
                return DesignColumn { primary_key: false, ..candidate.clone() };
            }
            candidate.clone()
        })
        .collect();
    if columns.iter().zip(&table.columns).all(|(next, current)| same_column(next, current)) {
        return Ok(ColumnEdit::Unchanged);
    }
    let next = replace_table(design, DesignTable { columns, ..table.clone() });
    let schema_changed = changes.keys.iter().any(|key| key != "notes");
    Ok(if schema_changed { ColumnEdit::Schema(next) } else { ColumnEdit::NotesOnly(next) })
}
