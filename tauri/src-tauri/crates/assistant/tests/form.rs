use std::path::Path;

use schema_assistant::form::*;
use serde_json::Value;

fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same(a, b)),
        (Value::Object(a), Value::Object(b)) => a.len() == b.len() && a.iter().all(|(key, a)| b.get(key).is_some_and(|b| same(a, b))),
        _ => a == b,
    }
}

#[test]
fn forms_match_the_typescript_forms() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/data/harness-form.json");
    let cases: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let mut failures = Vec::new();
    for (index, case) in cases.as_array().unwrap().iter().enumerate() {
        let (input, expected) = (&case["input"], &case["output"]);
        let actual = match case["kind"].as_str().unwrap() {
            "questions" => form_from_codex_questions(input),
            "schema" => form_from_json_schema(input).unwrap_or(Value::Null),
            "answer" => validate_form_answer(&input["form"], &input["answer"]).map_or(Value::Null, Value::Object),
            "codexAnswers" => codex_answers_from_form(input),
            other => panic!("unknown kind {other}"),
        };
        if !same(&actual, expected) {
            failures.push(format!("case {index} {}: {input}\n  expected {expected}\n  actual   {actual}", case["kind"]));
        }
    }
    assert!(failures.is_empty(), "{} of {} cases differ:\n{}", failures.len(), cases.as_array().unwrap().len(), failures.iter().take(6).cloned().collect::<Vec<_>>().join("\n"));
}
