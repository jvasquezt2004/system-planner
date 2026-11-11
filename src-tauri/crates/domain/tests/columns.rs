mod support;

use std::collections::HashSet;

use schema_domain::column_defaults::{ColumnDefault, column_default_problem, render_default_expression};
use schema_domain::column_types::render_column_type;
use schema_domain::design::ColumnTypeParameters;
use schema_domain::postgres_identifiers::*;
use serde_json::Value;
use support::read_json;

fn failures_report(name: &str, failures: &[String], total: usize) {
    assert!(failures.is_empty(), "{} of {total} {name} differ from the TypeScript oracle:\n{}", failures.len(), failures.iter().take(8).cloned().collect::<Vec<_>>().join("\n"));
    println!("{total} {name} match the TypeScript oracle");
}

#[test]
fn column_default_validation_matches_typescript() {
    let fixture = read_json("columns.json");
    let mut failures = Vec::new();
    let cases = fixture["problems"].as_array().unwrap();
    for case in cases {
        let (column_type, value, expected) = (case[0].as_str().unwrap(), &case[1], &case[2]);
        let default: ColumnDefault = serde_json::from_value(value.clone()).unwrap();
        let actual = column_default_problem(column_type, &default);
        if actual.as_deref() != expected.as_str() {
            failures.push(format!("- {column_type} {value}\n    expected {expected}\n    actual   {actual:?}"));
        }
    }
    failures_report("default validations", &failures, cases.len());
}

#[test]
fn default_expressions_match_typescript() {
    let fixture = read_json("columns.json");
    let mut failures = Vec::new();
    let cases = fixture["renders"].as_array().unwrap();
    for case in cases {
        let (column_type, value, expected) = (case[0].as_str(), &case[1], &case[2]);
        let default: ColumnDefault = serde_json::from_value(value.clone()).unwrap();
        let actual = render_default_expression(&default, column_type);
        if actual.as_deref() != expected.as_str() {
            failures.push(format!("- {column_type:?} {value}\n    expected {expected}\n    actual   {actual:?}"));
        }
    }
    failures_report("default renderings", &failures, cases.len());
}

#[test]
fn rendered_column_types_match_typescript() {
    let fixture = read_json("columns.json");
    let mut failures = Vec::new();
    let cases = fixture["renderedTypes"].as_array().unwrap();
    for case in cases {
        let (column_type, parameters, expected) = (case[0].as_str().unwrap(), &case[1], case[2].as_str().unwrap());
        let parameters: Option<ColumnTypeParameters> = (!parameters.is_null()).then(|| serde_json::from_value(parameters.clone()).unwrap());
        let actual = render_column_type(column_type, parameters.as_ref());
        if actual != expected {
            failures.push(format!("- {column_type} {parameters:?}\n    expected {expected:?}\n    actual   {actual:?}"));
        }
    }
    failures_report("rendered types", &failures, cases.len());
}

fn expect(result: &Value, actual: Result<String, String>) -> Option<String> {
    match (result.get("ok"), result.get("error"), actual) {
        (Some(expected), _, Ok(actual)) if expected.as_str() == Some(actual.as_str()) => None,
        (_, Some(expected), Err(actual)) if expected.as_str() == Some(actual.as_str()) => None,
        (expected, error, actual) => Some(format!("expected {expected:?}/{error:?}, got {actual:?}")),
    }
}

#[test]
fn identifier_naming_matches_typescript() {
    let fixture = read_json("identifiers.json");
    let mut failures = Vec::new();
    let mut total = 0;
    for case in fixture["truncate"].as_array().unwrap() {
        total += 1;
        let value = case["value"].as_str().unwrap();
        let actual = match case["maxBytes"].as_u64() {
            Some(max) => truncate_postgres_identifier(value, max as usize),
            None => truncate_postgres_identifier(value, MAX_IDENTIFIER_BYTES),
        };
        if let Some(problem) = expect(&case["result"], Ok(actual)) {
            failures.push(format!("- truncate {case}\n    {problem}"));
        }
    }
    for case in fixture["withSuffix"].as_array().unwrap() {
        total += 1;
        let actual = postgres_identifier_with_suffix(case["value"].as_str().unwrap(), case["suffix"].as_str().unwrap());
        if let Some(problem) = expect(&case["result"], actual) {
            failures.push(format!("- withSuffix {case}\n    {problem}"));
        }
    }
    for case in fixture["unique"].as_array().unwrap() {
        total += 1;
        let occupied: HashSet<String> = case["occupied"].as_array().unwrap().iter().map(|name| name.as_str().unwrap().to_owned()).collect();
        let actual = unique_postgres_identifier(case["base"].as_str().unwrap(), &occupied);
        if let Some(problem) = expect(&case["result"], Ok(actual)) {
            failures.push(format!("- unique {case}\n    {problem}"));
        }
    }
    for case in fixture["generated"].as_array().unwrap() {
        total += 1;
        let actual = postgres_generated_object_name(case["name1"].as_str().unwrap(), case["name2"].as_str(), case["label"].as_str().unwrap());
        if let Some(problem) = expect(&case["result"], actual) {
            failures.push(format!("- generated {case}\n    {problem}"));
        }
    }
    failures_report("identifier cases", &failures, total);
}
