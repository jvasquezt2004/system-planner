//! The Scenario API against the original (`fixtures/generate-scenario-api.ts`): the same requests,
//! in the same order, on the same seeded database, must get the same responses and log entries.

use schema_domain::design::DesignFunction;
use schema_scenario::{capture_result_grids, create_run_database, handle_request, Relationship, Table};
use serde_json::Value;

fn first_difference(path: &str, left: &Value, right: &Value) -> Option<String> {
    match (left, right) {
        (Value::Object(a), Value::Object(b)) => {
            for key in a.keys().chain(b.keys()) {
                let (x, y) = (a.get(key), b.get(key));
                if x.is_none() != y.is_none() {
                    return Some(format!("{path}.{key}: {} vs {}", short(x), short(y)));
                }
                if let Some(found) = first_difference(&format!("{path}.{key}"), x.unwrap(), y.unwrap()) {
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
        // Numbers are compared as numbers: 10.50 and 10.5 are the same JSON value.
        (Value::Number(a), Value::Number(b)) if a.as_f64() == b.as_f64() => None,
        _ if left == right => None,
        _ => Some(format!("{path}: {} vs {}", short(Some(left)), short(Some(right)))),
    }
}

fn short(value: Option<&Value>) -> String {
    let text = value.map_or("<absent>".to_owned(), Value::to_string);
    if text.chars().count() > 300 { format!("{}…", text.chars().take(300).collect::<String>()) } else { text }
}

#[test]
fn requests_are_answered_like_the_original() {
    let fixture: Value = serde_json::from_str(include_str!("../../../../fixtures/data/scenario-api.json")).unwrap();
    let tables: Vec<Table> = serde_json::from_value(fixture["tables"].clone()).unwrap();
    let relationships: Vec<Relationship> = serde_json::from_value(fixture["relationships"].clone()).unwrap();
    let functions: Vec<DesignFunction> = serde_json::from_value(fixture["functions"].clone()).unwrap();
    let sql = format!("{}\n{}", fixture["schema"].as_str().unwrap(), fixture["seed"].as_str().unwrap());
    let mut failures = Vec::new();
    let mut total = 0;
    for (number, session) in fixture["sessions"].as_array().unwrap().iter().enumerate() {
        let mut database = create_run_database(&sql).expect("the fixture database builds");
        for (index, step) in session["steps"].as_array().unwrap().iter().enumerate() {
            total += 1;
            let (response, entry) = handle_request(&mut database, &tables, &step["request"], &relationships, &functions);
            for (label, actual, expected) in [("response", &response, &step["response"]), ("entry", &entry, &step["entry"])] {
                if let Some(found) = first_difference("", actual, expected) {
                    failures.push(format!("session {number} request {index} {} {} {}?{}: {label}{found}", step["request"]["method"], step["request"]["path"], "", step["request"]["query"]));
                }
            }
        }
        let tables_for_grid = &tables;
        let grids = capture_result_grids(&mut database, tables_for_grid).expect("grids are captured");
        let expected = &session["grids"];
        for (grid, expected) in grids.iter().zip(expected.as_array().unwrap()) {
            if let Some(found) = first_difference("", &grid["columns"], &expected["columns"]).or_else(|| first_difference("", &grid["total"], &expected["total"])) {
                failures.push(format!("session {number} grid {}: {found}", grid["table"]));
            }
        }
    }
    assert!(failures.is_empty(), "{} of {total} requests differ; first:\n{}", failures.len(), failures.iter().take(15).cloned().collect::<Vec<_>>().join("\n"));
}

#[test]
fn a_body_that_is_not_json_is_a_bad_request() {
    let mut database = create_run_database("CREATE TABLE t (id integer PRIMARY KEY);").unwrap();
    let tables: Vec<Table> = serde_json::from_value(serde_json::json!([{ "name": "t", "columns": [{ "name": "id", "primaryKey": true, "unique": true }] }])).unwrap();
    let request = serde_json::json!({ "method": "POST", "path": "/rest/v1/t", "query": "", "headers": {}, "body": "{not json" });
    let (response, entry) = handle_request(&mut database, &tables, &request, &[], &[]);
    // The message is the JSON parser's own, which differs between engines.
    assert_eq!(response["status"], 400);
    assert_eq!(entry["status"], 400);
}
