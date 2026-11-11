//! A question an external harness (Codex, OpenCode) asks the designer, shown as a form in the
//! Assistant sidebar (`src/shared/harness-form.ts`). Forms are JSON, as the view reads them.

use serde_json::{json, Map, Value};

fn record(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

/// `String(value)` for the values a question can hold.
fn text(value: &Value) -> String {
    schema_domain::js::to_js_string(value)
}

fn field_list(form: &Value) -> &[Value] {
    form["fields"].as_array().map_or(&[], Vec::as_slice)
}

/// Fields shown for the answers given so far. Hidden fields keep their default.
pub fn visible_fields<'a>(form: &'a Value, values: &Map<String, Value>) -> Vec<&'a Value> {
    field_list(form)
        .iter()
        .filter(|field| {
            !truthy(&field["hidden"])
                && field["when"].as_array().map_or(&[][..], Vec::as_slice).iter().all(|condition| {
                    let current = values.get(condition["key"].as_str().unwrap_or_default());
                    let equal = current == condition.get("value");
                    if condition["op"] == "eq" { equal } else { !equal }
                })
        })
        .collect()
}

/// Accepts an answer only if it fits the form: known keys, right types, allowed choices, required fields present.
pub fn validate_form_answer(form: &Value, answer: &Value) -> Option<Map<String, Value>> {
    let answer = record(answer)?;
    let mut clean = Map::new();
    for (key, value) in answer {
        let field = field_list(form).iter().find(|field| field["key"].as_str() == Some(key.as_str()))?;
        let kind = field["type"].as_str().unwrap_or_default();
        if kind == "external" {
            return None;
        }
        let allowed: Option<Vec<&str>> = field["options"].as_array().map(|options| options.iter().filter_map(|option| option["value"].as_str()).collect());
        let custom = truthy(&field["custom"]);
        match kind {
            "string" => {
                let value = value.as_str()?;
                if allowed.as_ref().is_some_and(|allowed| !custom && !allowed.contains(&value)) {
                    return None;
                }
            }
            "number" | "integer" => {
                let number = value.as_f64().filter(|number| number.is_finite())?;
                if kind == "integer" && number.fract() != 0.0 {
                    return None;
                }
                if field["minimum"].as_f64().is_some_and(|minimum| number < minimum) || field["maximum"].as_f64().is_some_and(|maximum| number > maximum) {
                    return None;
                }
            }
            "boolean" => {
                value.as_bool()?;
            }
            "multiselect" => {
                let items = value.as_array()?;
                if items.iter().any(|item| !item.is_string()) || allowed.as_ref().is_some_and(|allowed| !custom && items.iter().any(|item| !allowed.contains(&item.as_str().unwrap_or_default()))) {
                    return None;
                }
            }
            _ => {}
        }
        clean.insert(key.clone(), value.clone());
    }
    for field in visible_fields(form, &clean) {
        if truthy(&field["required"]) && field["type"] != "external" && !clean.contains_key(field["key"].as_str().unwrap_or_default()) {
            return None;
        }
    }
    Some(clean)
}

/// Codex `item/tool/requestUserInput` questions as a form. Every question is required.
pub fn form_from_codex_questions(questions: &Value) -> Value {
    let fields: Vec<Value> = questions
        .as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter_map(record)
        .filter(|question| question.get("id").is_some_and(Value::is_string))
        .map(|question| {
            let options: Vec<Value> = question
                .get("options")
                .and_then(Value::as_array)
                .map_or(&[][..], Vec::as_slice)
                .iter()
                .filter_map(record)
                .map(|option| {
                    let label = option.get("label").map_or_else(|| "undefined".to_owned(), text);
                    let mut entry = json!({ "value": label, "label": label });
                    if option.get("description").is_some_and(|description| !is_falsy(description)) {
                        entry["description"] = json!(text(&option["description"]));
                    }
                    entry
                })
                .collect();
            let mut field = Map::new();
            field.insert("key".into(), json!(text(&question["id"])));
            field.insert("type".into(), json!("string"));
            if let Some(header) = question.get("header").filter(|header| header.is_string()) {
                field.insert("title".into(), header.clone());
            }
            if let Some(description) = question.get("question").filter(|description| description.is_string()) {
                field.insert("description".into(), description.clone());
            }
            field.insert("required".into(), json!(true));
            field.insert("secret".into(), json!(question.get("isSecret") == Some(&json!(true))));
            if !options.is_empty() {
                field.insert("options".into(), Value::Array(options));
            }
            field.insert("custom".into(), json!(question.get("isOther") == Some(&json!(true))));
            Value::Object(field)
        })
        .collect();
    json!({ "fields": fields })
}

fn truthy(value: &Value) -> bool {
    !is_falsy(value)
}

/// JavaScript falsiness of a JSON value.
fn is_falsy(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::Bool(flag) => !flag,
        Value::Number(number) => number.as_f64().is_some_and(|number| number == 0.0),
        Value::String(text) => text.is_empty(),
        _ => false,
    }
}

/// The answer Codex expects for the questions of a form.
pub fn codex_answers_from_form(result: &Value) -> Value {
    let Some(answer) = result.get("answer").and_then(Value::as_object) else { return json!({ "answers": {} }) };
    let answers: Map<String, Value> = answer
        .iter()
        .map(|(key, value)| {
            let values = match value {
                Value::Array(items) => items.clone(),
                other => vec![json!(text(other))],
            };
            (key.clone(), json!({ "answers": values }))
        })
        .collect();
    json!({ "answers": answers })
}

/// A simple JSON Schema object (flat string, number, integer, boolean, and enum properties) as a
/// form, or `None` when the schema needs more than that.
pub fn form_from_json_schema(schema: &Value) -> Option<Value> {
    let schema = record(schema).filter(|schema| schema.get("type") == Some(&json!("object")))?;
    let properties = schema.get("properties").and_then(Value::as_object)?;
    let required: Vec<String> = schema.get("required").and_then(Value::as_array).map_or(vec![], |items| items.iter().map(text).collect());
    let mut fields = Vec::new();
    for (key, raw) in properties {
        let raw = record(raw)?;
        let mut field = Map::new();
        field.insert("key".into(), json!(key));
        if let Some(title) = raw.get("title").filter(|title| title.is_string()) {
            field.insert("title".into(), title.clone());
        }
        if let Some(description) = raw.get("description").filter(|description| description.is_string()) {
            field.insert("description".into(), description.clone());
        }
        field.insert("required".into(), json!(required.contains(key)));
        let enum_values: Option<Vec<String>> = raw.get("enum").and_then(Value::as_array).map(|values| values.iter().map(text).collect());
        match raw.get("type").and_then(Value::as_str) {
            Some("string") => {
                field.insert("type".into(), json!("string"));
                if let Some(values) = enum_values {
                    let names: Vec<String> = raw.get("enumNames").and_then(Value::as_array).map_or(vec![], |names| names.iter().map(text).collect());
                    let options: Vec<Value> = values.iter().enumerate().map(|(index, value)| json!({ "value": value, "label": names.get(index).unwrap_or(value) })).collect();
                    field.insert("options".into(), Value::Array(options));
                }
                if let Some(default) = raw.get("default").filter(|default| default.is_string()) {
                    field.insert("default".into(), default.clone());
                }
            }
            Some(kind @ ("number" | "integer")) => {
                field.insert("type".into(), json!(kind));
                for bound in ["minimum", "maximum"] {
                    if let Some(value) = raw.get(bound).filter(|value| value.is_number()) {
                        field.insert(bound.into(), value.clone());
                    }
                }
                if let Some(default) = raw.get("default").filter(|default| default.is_number()) {
                    field.insert("default".into(), default.clone());
                }
            }
            Some("boolean") => {
                field.insert("type".into(), json!("boolean"));
                if let Some(default) = raw.get("default").filter(|default| default.is_boolean()) {
                    field.insert("default".into(), default.clone());
                }
            }
            Some("array") => {
                let values = raw.get("items").and_then(Value::as_object).and_then(|items| items.get("enum")).and_then(Value::as_array)?;
                field.insert("type".into(), json!("multiselect"));
                field.insert("options".into(), Value::Array(values.iter().map(|value| json!({ "value": text(value), "label": text(value) })).collect()));
            }
            _ => return None,
        }
        fields.push(Value::Object(field));
    }
    (!fields.is_empty()).then(|| json!({ "fields": fields }))
}
