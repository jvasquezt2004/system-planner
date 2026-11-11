//! Reading DDL into a Design and keeping identity across a file edit, against the original
//! (`fixtures/generate-ddl.ts`): the same scripts must give the same Designs, raw SQL and errors.
//! Scripts that reach the three behaviours the port fixes on purpose are tested below by hand.

use schema_assistant::ddl::translate_ddl_text;
use schema_domain::design::{empty_design, Design};
use schema_domain::geometry::CanvasViewport;
use schema_domain::schema_identity::adopt_identities;
use serde_json::{json, Value};

fn fixture() -> Value {
    serde_json::from_str(include_str!("../../../fixtures/data/ddl.json")).unwrap()
}

fn counter(prefix: &str) -> impl FnMut() -> String {
    let prefix = prefix.to_owned();
    let mut n = 0;
    move || {
        n += 1;
        format!("{prefix}{n}")
    }
}

fn base(viewport: &Value) -> Design {
    let mut design = empty_design();
    design.viewport = serde_json::from_value::<CanvasViewport>(viewport.clone()).unwrap();
    design
}

/// What the original recorded for a script, in the shape this side produces.
fn expected(out: &Value) -> Value {
    if let Some(error) = out.get("error") {
        json!({ "error": error })
    } else {
        json!({ "design": out["design"], "kept": out["kept"], "count": out["count"] })
    }
}

fn describe(translated: Result<schema_assistant::ddl::Translated, String>, adopt_onto: Option<&Design>) -> Value {
    match translated {
        Err(error) => json!({ "error": error }),
        Ok(translated) => {
            let design = match adopt_onto {
                Some(current) => adopt_identities(current, &translated.design),
                None => translated.design,
            };
            json!({ "design": design, "kept": translated.kept_as_sql, "count": translated.statement_count })
        }
    }
}

fn first_difference(path: &str, left: &Value, right: &Value) -> Option<String> {
    match (left, right) {
        (Value::Object(a), Value::Object(b)) => {
            for key in a.keys().chain(b.keys()) {
                let (x, y) = (a.get(key).unwrap_or(&Value::Null), b.get(key).unwrap_or(&Value::Null));
                if a.contains_key(key) != b.contains_key(key) {
                    return Some(format!("{path}.{key}: {} vs {}", short(x), short(y)));
                }
                if let Some(found) = first_difference(&format!("{path}.{key}"), x, y) {
                    return Some(found);
                }
            }
            None
        }
        (Value::Array(a), Value::Array(b)) => {
            if a.len() != b.len() {
                return Some(format!("{path}: length {} vs {}", a.len(), b.len()));
            }
            a.iter().zip(b).enumerate().find_map(|(index, (x, y))| first_difference(&format!("{path}[{index}]"), x, y))
        }
        _ if left == right => None,
        _ => Some(format!("{path}: {} vs {}", short(left), short(right))),
    }
}

fn short(value: &Value) -> String {
    let text = value.to_string();
    if text.len() > 300 { format!("{}…", &text[..300]) } else { text }
}

#[test]
fn scripts_read_like_the_original() {
    let fixture = fixture();
    let viewport = &fixture["viewport"];
    let mut failures = Vec::new();
    for case in fixture["translate"].as_array().unwrap() {
        let sql = case["sql"].as_str().unwrap();
        let mut create_id = counter("n");
        let actual = describe(translate_ddl_text(&base(viewport), sql, &mut create_id), None);
        if let Some(found) = first_difference("", &actual, &expected(&case["out"])) {
            failures.push(format!("{sql:?}\n    {found}"));
        }
    }
    assert!(failures.is_empty(), "{} of {} scripts differ; first:\n{}", failures.len(), fixture["translate"].as_array().unwrap().len(), failures.iter().take(12).cloned().collect::<Vec<_>>().join("\n"));
}

#[test]
fn identity_is_kept_across_an_edit_like_the_original() {
    let fixture = fixture();
    let viewport = &fixture["viewport"];
    let mut failures = Vec::new();
    for case in fixture["adopt"].as_array().unwrap() {
        let sql = case["sql"].as_str().unwrap();
        let current = Design::load(&case["current"]).expect("the recorded Design loads");
        let mut create_id = counter("n");
        let actual = describe(translate_ddl_text(&base(viewport), sql, &mut create_id), Some(&current));
        if let Some(found) = first_difference("", &actual, &expected(&case["out"])) {
            failures.push(format!("{sql:?}\n    {found}"));
        }
    }
    assert!(failures.is_empty(), "{} of {} edits differ; first:\n{}", failures.len(), fixture["adopt"].as_array().unwrap().len(), failures.iter().take(12).cloned().collect::<Vec<_>>().join("\n"));
}

fn read(sql: &str) -> Design {
    let mut create_id = counter("x");
    translate_ddl_text(&empty_design(), sql, &mut create_id).ok().expect("the script reads").design
}

#[test]
fn zero_and_false_defaults_keep_their_value() {
    let design = read("create table t (id int primary key, a int default 0, b boolean default false, c int default 7);");
    let defaults: Vec<Value> = design.tables[0].columns.iter().map(|column| serde_json::to_value(&column.default).unwrap()).collect();
    assert_eq!(defaults[1], json!({ "kind": "literal", "literalType": "integer", "value": "0" }));
    assert_eq!(defaults[2], json!({ "kind": "literal", "literalType": "boolean", "value": "false" }));
    assert_eq!(defaults[3], json!({ "kind": "literal", "literalType": "integer", "value": "7" }));
}

#[test]
fn numeric_with_scale_zero_is_a_numeric_column() {
    let design = read("create table t (id int primary key, a numeric(10,0));");
    assert!(design.raw_statements.is_none());
    assert_eq!(serde_json::to_value(design.tables[0].columns[1].type_parameters.as_ref().unwrap()).unwrap(), json!({ "precision": 10, "scale": 0 }));
}

#[test]
fn a_function_with_parameters_is_a_function() {
    let design = read("create function add_one(a int, b int) returns int language sql as 'select a + b';");
    assert!(design.raw_statements.is_none());
    let function = &design.functions.as_ref().unwrap()[0];
    assert_eq!(function.arguments.iter().map(|argument| (argument.name.as_str(), argument.argument_type.as_str())).collect::<Vec<_>>(), vec![("a", "pg_catalog.int4"), ("b", "pg_catalog.int4")]);
}
