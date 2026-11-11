//! OpenCode's side of the harness: the Project tool server, the model catalog and forms.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};

use schema_assistant::codex::DynamicTool;
use schema_assistant::opencode::{form_fields_from_opencode, parse_models, variant_to_level, ProjectToolServer};
use serde_json::{json, Value};

fn post(url: &str, body: &str, token: Option<&str>) -> (u16, String) {
    let address = url.trim_start_matches("http://").split('/').next().unwrap();
    let mut stream = TcpStream::connect(address).unwrap();
    let mut request = format!("POST /mcp HTTP/1.1\r\nhost: {address}\r\ncontent-type: application/json\r\ncontent-length: {}\r\n", body.len());
    if let Some(token) = token {
        request.push_str(&format!("authorization: Bearer {token}\r\n"));
    }
    request.push_str("\r\n");
    request.push_str(body);
    stream.write_all(request.as_bytes()).unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    let status = response.split_whitespace().nth(1).unwrap().parse().unwrap();
    (status, response.split("\r\n\r\n").nth(1).unwrap_or_default().to_owned())
}

fn rpc(url: &str, body: Value) -> Value {
    let (_, text) = post(url, &body.to_string(), Some("secret"));
    serde_json::from_str(&text).unwrap_or(Value::Null)
}

fn server(call: impl Fn(&str, &Value) -> Result<Value, String> + Send + Sync + 'static) -> ProjectToolServer {
    ProjectToolServer::start("secret", vec![DynamicTool { name: "read_project".into(), description: "Read".into(), input_schema: json!({ "type": "object", "properties": {} }) }], Arc::new(call)).unwrap()
}

#[test]
fn the_tool_server_rejects_callers_without_the_token() {
    let server = server(|_, _| Ok(json!({})));
    assert_eq!(post(&server.url, &json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }).to_string(), Some("wrong")).0, 401);
    assert_eq!(post(&server.url, "{}", None).0, 401);
    server.close();
}

#[test]
fn the_tool_server_initializes_lists_tools_and_runs_a_call() {
    let calls: Arc<Mutex<Vec<(String, Value)>>> = Default::default();
    let record = calls.clone();
    let server = server(move |name, arguments| {
        record.lock().unwrap().push((name.to_owned(), arguments.clone()));
        Ok(json!({ "success": true, "contentItems": [{ "type": "inputText", "text": "Project: X" }] }))
    });
    let init = rpc(&server.url, json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18" } }));
    assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
    assert!(init["result"]["capabilities"]["tools"].is_object());
    assert_eq!(post(&server.url, &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }).to_string(), Some("secret")).0, 202);
    let list = rpc(&server.url, json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }));
    assert_eq!(list["result"]["tools"][0]["name"], "read_project");
    let result = rpc(&server.url, json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "read_project", "arguments": {} } }));
    assert_eq!(result["result"], json!({ "content": [{ "type": "text", "text": "Project: X" }], "isError": false }));
    assert_eq!(calls.lock().unwrap().len(), 1);
    assert_eq!(rpc(&server.url, json!({ "jsonrpc": "2.0", "id": 4, "method": "nope" }))["error"]["code"], -32601);
    server.close();
}

#[test]
fn unknown_tools_and_failed_calls_are_reported_without_failing() {
    let server = server(|_, _| Err("boom".into()));
    let unknown = rpc(&server.url, json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "nope" } }));
    assert_eq!(unknown["error"]["code"], -32602);
    let failed = rpc(&server.url, json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "read_project" } }));
    assert_eq!(failed["result"], json!({ "content": [{ "type": "text", "text": "boom" }], "isError": true }));
    server.close();
}

#[test]
fn the_model_catalog_keeps_usable_chat_models_and_maps_variants_to_levels() {
    let models = parse_models(&json!({ "data": [
        { "providerID": "opencode", "modelID": "a", "name": "A", "type": "chat", "enabled": true, "status": "active", "variants": [{ "id": "none" }, { "id": "low" }, { "id": "weird" }] },
        { "providerID": "opencode", "modelID": "img", "name": "Img", "type": "image", "enabled": true, "status": "active" },
        { "providerID": "x", "modelID": "off", "name": "Off", "type": "chat", "enabled": false, "status": "active" },
        { "providerID": "x", "modelID": "old", "name": "Old", "type": "chat", "enabled": true, "status": "deprecated" },
    ] }));
    assert_eq!(models.iter().map(|model| model.id.as_str()).collect::<Vec<_>>(), vec!["opencode/a"]);
    assert_eq!(models[0].variants.iter().map(|variant| variant_to_level(variant)).collect::<Vec<_>>(), vec![Some("off".to_owned()), Some("low".to_owned()), None]);
}

#[test]
fn form_fields_drop_unknown_types_and_non_finite_bounds() {
    let fields = form_fields_from_opencode(&json!([
        { "key": "q0", "title": "Color", "type": "string", "options": [{ "value": "Red", "label": "Red" }], "custom": true },
        { "key": "n", "type": "number", "minimum": "-Infinity", "maximum": 10 },
        { "key": "weird", "type": "hologram" },
    ]));
    assert_eq!(fields.iter().map(|field| field["key"].as_str().unwrap()).collect::<Vec<_>>(), vec!["q0", "n"]);
    assert_eq!(fields[0]["custom"], true);
    assert_eq!(fields[0]["options"], json!([{ "value": "Red", "label": "Red" }]));
    assert_eq!(fields[1]["maximum"], 10);
    assert!(fields[1].get("minimum").is_none());
}
