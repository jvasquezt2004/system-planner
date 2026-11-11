mod support;

use schema_domain::design::Design;
use schema_domain::index_methods::{IndexedType, index_method_problem};
use schema_domain::relationships::{RemovalTarget, foreign_key_column_name, removal_plan, resolve_relationships};
use schema_domain::sql::{SqlGeneration, generate_design_sql, plan_schema_object_names, postgres_schema_relation_names, render_schema_file};
use serde_json::{Value, json};
use support::{apply_edit, fingerprint, json_equal, read_json};

fn summarize(generation: &SqlGeneration) -> Value {
    match generation {
        SqlGeneration::Ok { sql, warnings } => json!({ "ok": true, "sql": fingerprint(sql), "warnings": warnings }),
        SqlGeneration::Errors(errors) => json!({ "ok": false, "errors": errors }),
    }
}

/// `{ ok }` for a value and `{ threw: true }` for an error, the shape the fixtures use.
fn captured(result: Result<Value, String>) -> Value {
    match result {
        Ok(value) => json!({ "ok": value }),
        Err(_) => json!({ "threw": true }),
    }
}

fn sorted_strings(mut values: Vec<String>) -> Value {
    values.sort();
    json!(values)
}

fn analyse(design: &Design, expected: &Value) -> Vec<(&'static str, Value, Value)> {
    let mut mismatches = Vec::new();
    let mut check = |name: &'static str, actual: Value, expected: &Value| {
        if !json_equal(&actual, expected) {
            mismatches.push((name, expected.clone(), actual));
        }
    };

    check("strict", captured(generate_design_sql(design, false).map(|g| summarize(&g))), &expected["strict"]);
    if let Some(lenient) = expected.get("lenient") {
        check("lenient", captured(generate_design_sql(design, true).map(|g| summarize(&g))), lenient);
    }
    // The generator stores the schema-file fingerprint unwrapped, and `{ threw: true }` on a throw.
    let schema_file = render_schema_file(design).map_or_else(|_| json!({ "threw": true }), |text| fingerprint(&text));
    check("schemaFile", schema_file, &expected["schemaFile"]);
    let names = plan_schema_object_names(design);
    check("names", json!({ "ok": serde_json::to_value(&names).unwrap() }), &expected["names"]);
    check("relationNames", json!({ "ok": sorted_strings(postgres_schema_relation_names(design).into_iter().collect()) }), &{
        // Compare as sets: JavaScript sorts by UTF-16 units and Rust by bytes.
        let mut value = expected["relationNames"].clone();
        if let Some(list) = value["ok"].as_array_mut() {
            list.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
        }
        value
    });

    let relationships: Vec<Value> = resolve_relationships(design)
        .iter()
        .map(|view| {
            json!({
                "id": view.relationship.id,
                "referencingTable": view.referencing_table.id,
                "referencingColumn": view.referencing_column.id,
                "referencedTable": view.referenced_table.id,
                "referencedColumn": view.referenced_column.map(|column| column.id.clone()),
                "required": view.required,
                "oneToOne": view.one_to_one,
                "ownsUniqueness": view.owns_uniqueness,
                "association": view.many_to_many_association.map(|association| association.id.clone()),
                "foreignKeyColumnName": view.referenced_column.map(|column| foreign_key_column_name(view.referencing_table, view.referenced_table, column)),
            })
        })
        .collect();
    check("relationships", json!({ "ok": relationships }), &expected["relationships"]);

    let removals: Vec<Value> = expected["removals"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            let target: RemovalTarget = serde_json::from_value(entry["target"].clone()).unwrap();
            json!({ "target": entry["target"], "plan": { "ok": serde_json::to_value(removal_plan(design, &target)).unwrap() } })
        })
        .collect();
    check("removals", json!(removals), &expected["removals"]);

    let mut problems = serde_json::Map::new();
    for table in &design.tables {
        for index in table.indexes.as_deref().unwrap_or(&[]) {
            let columns: Vec<_> = index.keys.iter().map(|key| table.columns.iter().find(|column| column.id == key.column_id)).collect();
            let supported = columns.iter().all(|column| column.is_some_and(|column| schema_domain::column_types::is_supported_column_type(&column.column_type)));
            if !supported {
                continue;
            }
            let types: Vec<IndexedType> = columns
                .iter()
                .flatten()
                .map(|column| IndexedType {
                    column_type: &column.column_type,
                    array: column.type_parameters.as_ref().and_then(|p| p.array) == Some(true),
                    dimensions: column.type_parameters.as_ref().and_then(|p| p.dimensions),
                })
                .collect();
            problems.insert(index.id.clone(), json!(index_method_problem(index, &types)));
        }
    }
    check("indexProblems", json!({ "ok": problems }), &expected["indexProblems"]);
    mismatches
}

#[test]
fn design_sql_matches_typescript() {
    let fixture = read_json("design-sql.json");
    let bases = fixture["bases"].as_array().unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    let mut failures = Vec::new();
    for (position, case) in cases.iter().enumerate() {
        let mut doc = bases[case["base"].as_u64().unwrap() as usize].clone();
        for edit in case["edits"].as_array().unwrap() {
            apply_edit(&mut doc, edit);
        }
        let design: Design = match serde_json::from_value(doc.clone()) {
            Ok(design) => design,
            Err(error) => panic!("case {position}: the mutated document cannot be typed ({error}); fix the mutator\n{}", case["edits"]),
        };
        for (what, expected, actual) in analyse(&design, case) {
            failures.push(format!("- case {position} ({what}) edits {}\n    expected {expected}\n    actual   {actual}", case["edits"]));
        }
    }
    assert!(
        failures.is_empty(),
        "{} differences from the TypeScript oracle across {} cases (bun src-tauri/fixtures/explain-design-sql.ts <case> prints the expected SQL):\n{}",
        failures.len(),
        cases.len(),
        failures.iter().take(6).cloned().collect::<Vec<_>>().join("\n")
    );
    println!("{} cases match the TypeScript oracle", cases.len());
}
