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

pub fn require_column<'a>(table: &'a DesignTable, column_id: &str) -> Result<&'a DesignColumn> {
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

fn type_parameters_json(column: &DesignColumn) -> String {
    column.type_parameters.as_ref().map_or_else(|| "{}".to_owned(), |parameters| serde_json::to_string(parameters).unwrap_or_default())
}

fn same_column(a: &DesignColumn, b: &DesignColumn) -> bool {
    a.id == b.id
        && a.name == b.name
        && a.column_type == b.column_type
        && a.enum_type_id == b.enum_type_id
        // `JSON.stringify(a.typeParameters ?? {})`: no parameters and an empty object are the same.
        && type_parameters_json(a) == type_parameters_json(b)
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

/* ------------------------------------------------------------ relationships */

use schema_domain::design::DesignRelationship;
use schema_domain::design::DesignManyToManyAssociation;
use schema_domain::relationships::{foreign_key_column_name, is_relationship_cardinality, primary_key_column, resolve_relationship};
use schema_domain::postgres_identifiers::unique_postgres_identifier;
use schema_domain::sql::postgres_schema_relation_names;

/// A foreign-key column, named after what it references and typed like the key it points at.
fn create_relationship_column(referencing: &DesignTable, referenced: &DesignTable, referenced_column: &DesignColumn, create_id: &mut dyn FnMut() -> String) -> DesignColumn {
    let mut column = new_column(create_id(), foreign_key_column_name(referencing, referenced, referenced_column), referenced_column.column_type.clone());
    column.nullable = false;
    column
}

pub fn require_cardinality(value: Option<&Value>) -> Result<String> {
    match value {
        None => Ok("one-to-many".into()),
        Some(Value::String(text)) if is_relationship_cardinality(text) => Ok(text.clone()),
        Some(_) => Err("That relationship cardinality is not supported.".into()),
    }
}

fn require_referential_action(value: &Value) -> Result<String> {
    match value.as_str() {
        Some(action) if ["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"].contains(&action) => Ok(action.to_owned()),
        _ => Err("That foreign-key referential action is not supported.".into()),
    }
}

/// `addRelationship`: a foreign-key column on the referencing table, or for many-to-many a visible
/// junction table with a column for each side.
pub fn add_relationship(
    design: &Design,
    referencing_id: &str,
    referenced_id: &str,
    cardinality: Option<&Value>,
    junction_position: Option<CanvasPoint>,
    create_id: &mut dyn FnMut() -> String,
) -> Result<Design> {
    let referencing = require_table(design, referencing_id)?;
    let referenced = require_table(design, referenced_id)?;
    let creation = match cardinality {
        None => "one-to-many".to_owned(),
        Some(Value::String(text)) if text == "many-to-many" || is_relationship_cardinality(text) => text.clone(),
        Some(_) => return Err("That relationship cardinality is not supported.".into()),
    };

    if creation == "many-to-many" {
        let Some(left_key) = primary_key_column(referencing) else {
            return Err(format!("Table \"{}\" needs exactly one primary key column before it can participate in a many-to-many relationship.", referencing.name));
        };
        let Some(right_key) = primary_key_column(referenced) else {
            return Err(format!("Table \"{}\" needs exactly one primary key column before it can participate in a many-to-many relationship.", referenced.name));
        };
        let name = unique_postgres_identifier(&format!("{}{}", referencing.name, referenced.name), &postgres_schema_relation_names(design));
        let position = match junction_position {
            Some(point) => require_point(point, "Junction table position")?,
            None => default_table_position(design),
        };
        let mut junction = create_default_table(&name, position, create_id);
        let left_column = create_relationship_column(&junction, referencing, left_key, create_id);
        junction.columns.push(left_column.clone());
        let right_column = create_relationship_column(&junction, referenced, right_key, create_id);
        junction.columns.push(right_column.clone());
        let relationship = |referencing_column: &DesignColumn, referenced_table: &DesignTable, create_id: &mut dyn FnMut() -> String| DesignRelationship {
            id: create_id(),
            cardinality: "one-to-many".into(),
            referencing_table_id: junction.id.clone(),
            referencing_column_id: referencing_column.id.clone(),
            referenced_table_id: referenced_table.id.clone(),
            on_delete: None,
            on_update: None,
        };
        let left = relationship(&left_column, referencing, create_id);
        let right = relationship(&right_column, referenced, create_id);
        let association = DesignManyToManyAssociation {
            id: create_id(),
            left_table_id: referencing.id.clone(),
            right_table_id: referenced.id.clone(),
            junction_table_id: junction.id.clone(),
            left_relationship_id: left.id.clone(),
            right_relationship_id: right.id.clone(),
        };
        let mut next = design.clone();
        next.tables.push(junction);
        next.relationships.extend([left, right]);
        next.many_to_many_relationships.push(association);
        return Ok(next);
    }

    let cardinality = require_cardinality(Some(&Value::String(creation)))?;
    let Some(referenced_column) = primary_key_column(referenced) else {
        return Err(format!("Table \"{}\" needs exactly one primary key column before another table can reference it.", referenced.name));
    };
    let column = create_relationship_column(referencing, referenced, referenced_column, create_id);
    let relationship = DesignRelationship {
        id: create_id(),
        cardinality,
        referencing_table_id: referencing.id.clone(),
        referencing_column_id: column.id.clone(),
        referenced_table_id: referenced.id.clone(),
        on_delete: None,
        on_update: None,
    };
    let mut table = referencing.clone();
    table.columns.push(column);
    let mut next = replace_table(design, table);
    next.relationships.push(relationship);
    Ok(next)
}

pub fn require_relationship<'a>(design: &'a Design, relationship_id: &str) -> Result<&'a DesignRelationship> {
    design.relationships.iter().find(|candidate| candidate.id == relationship_id).ok_or_else(|| "That relationship could not be found.".to_owned())
}

/// What `updateRelationship` was asked to change. An absent property keeps its current value.
pub struct RelationshipChanges<'a> {
    pub required: Option<&'a Value>,
    pub cardinality: Option<&'a Value>,
    pub on_delete: Option<&'a Value>,
    pub on_update: Option<&'a Value>,
}

/// `None` when nothing would change.
pub fn update_relationship(design: &Design, relationship_id: &str, changes: &RelationshipChanges) -> Result<Option<Design>> {
    let relationship = require_relationship(design, relationship_id)?;
    let required = match changes.required {
        None => None,
        Some(Value::Bool(required)) => Some(*required),
        Some(_) => return Err("Relationship required must be true or false.".into()),
    };
    let association = many_to_many_association_for_relationship(design, &relationship.id);
    if association.is_some() && required == Some(false) {
        return Err("Many-to-many junction references must remain required.".into());
    }
    if association.is_some() && changes.cardinality.is_some_and(|value| value.as_str() != Some("one-to-many")) {
        return Err("Many-to-many junction reference cardinality cannot be changed.".into());
    }
    let cardinality = match changes.cardinality {
        None => relationship.cardinality.clone(),
        Some(value) => require_cardinality(Some(value))?,
    };
    let current_on_delete = relationship.on_delete.clone().unwrap_or_else(|| "NO ACTION".into());
    let current_on_update = relationship.on_update.clone().unwrap_or_else(|| "NO ACTION".into());
    let on_delete = match changes.on_delete {
        None => current_on_delete.clone(),
        Some(value) => require_referential_action(value)?,
    };
    let on_update = match changes.on_update {
        None => current_on_update.clone(),
        Some(value) => require_referential_action(value)?,
    };
    if required.is_none() && cardinality == relationship.cardinality && on_delete == current_on_delete && on_update == current_on_update {
        return Ok(None);
    }

    let view = resolve_relationship(design, relationship).ok_or("That relationship could not be found.")?;
    // Required and the foreign-key column's nullability are one setting.
    let next_required = required.unwrap_or(view.required);
    let columns = view
        .referencing_table
        .columns
        .iter()
        .map(|candidate| if candidate.id == view.referencing_column.id { DesignColumn { nullable: !next_required, ..candidate.clone() } } else { candidate.clone() })
        .collect();
    let mut next = replace_table(design, DesignTable { columns, ..view.referencing_table.clone() });
    next.relationships = design
        .relationships
        .iter()
        .map(|candidate| {
            if candidate.id == relationship.id {
                DesignRelationship { cardinality: cardinality.clone(), on_delete: Some(on_delete.clone()), on_update: Some(on_update.clone()), ..candidate.clone() }
            } else {
                candidate.clone()
            }
        })
        .collect();
    if cardinality == relationship.cardinality && on_delete == current_on_delete && on_update == current_on_update && next_required == view.required {
        return Ok(None);
    }
    Ok(Some(next))
}

/// Removes the relationship-owned constraints, never a junction or its columns.
pub fn remove_relationship(design: &Design, relationship_id: &str) -> Result<Design> {
    let relationship = require_relationship(design, relationship_id)?;
    let association = many_to_many_association_for_relationship(design, &relationship.id);
    let ids: Vec<&str> = match association {
        Some(association) => vec![association.left_relationship_id.as_str(), association.right_relationship_id.as_str()],
        None => vec![relationship.id.as_str()],
    };
    Ok(Design {
        relationships: design.relationships.iter().filter(|candidate| !ids.contains(&candidate.id.as_str())).cloned().collect(),
        many_to_many_relationships: match association {
            Some(association) => design.many_to_many_relationships.iter().filter(|candidate| candidate.id != association.id).cloned().collect(),
            None => design.many_to_many_relationships.clone(),
        },
        ..design.clone()
    })
}
