mod support;

use schema_domain::geometry::{CanvasPoint, CanvasViewport, Size};
use schema_domain::system_design::SystemDesign;
use schema_domain::system_ops::*;
use serde::de::DeserializeOwned;
use serde_json::Value;
use support::{json_equal, read_json};

/// What an operation produced: a new design, which becomes the next state, or a plan.
enum Output {
    Design(Box<SystemDesign>),
    Plan(Value),
}

fn arg<T: DeserializeOwned>(args: &Value, key: &str) -> T {
    serde_json::from_value(args[key].clone()).unwrap_or_else(|error| panic!("argument {key}: {error} in {args}"))
}

fn text(args: &Value, key: &str) -> String {
    args[key].as_str().unwrap_or_else(|| panic!("argument {key} in {args}")).to_owned()
}

fn plan<T: serde::Serialize>(plan: Result<T, String>) -> Result<Output, String> {
    plan.map(|plan| Output::Plan(serde_json::to_value(plan).unwrap()))
}

fn design(result: Result<SystemDesign, String>) -> Result<Output, String> {
    result.map(|design| Output::Design(Box::new(design)))
}

fn apply(d: &SystemDesign, op: &str, args: &Value) -> Result<Output, String> {
    match op {
        "addService" => design(add_service(d, &arg::<ServiceInput>(args, "input"))),
        "updateService" => design(update_service(d, &text(args, "serviceId"), &arg::<ServiceChanges>(args, "changes"))),
        "moveService" => design(move_service(d, &text(args, "serviceId"), arg::<CanvasPoint>(args, "position"))),
        "resizeService" => design(resize_service(d, &text(args, "serviceId"), arg::<Size>(args, "size"))),
        "setServiceCollapsed" => design(set_service_collapsed(d, &text(args, "serviceId"), arg::<bool>(args, "collapsed"))),
        "setFocus" => {
            let service_id: Option<String> = arg(args, "serviceId");
            let viewport: Option<CanvasViewport> = args.get("viewport").map(|v| serde_json::from_value(v.clone()).unwrap());
            design(set_focus(d, service_id.as_deref(), viewport))
        }
        "removeService" => design(remove_service(d, &text(args, "serviceId"))),
        "describeServiceRemoval" => plan(describe_service_removal(d, &text(args, "serviceId"))),
        "addGroup" => design(add_group(d, &arg::<GroupInput>(args, "input"))),
        "updateGroup" => design(update_group(d, &text(args, "groupId"), &arg::<GroupChanges>(args, "changes"))),
        "moveGroup" => design(move_group(d, &text(args, "groupId"), arg::<CanvasPoint>(args, "position"))),
        "resizeGroup" => design(resize_group(d, &text(args, "groupId"), arg::<Size>(args, "size"))),
        "removeGroup" => design(remove_group(d, &text(args, "groupId"))),
        "describeGroupMove" => plan(describe_group_move(d, &text(args, "groupId"))),
        "addComponent" => design(add_component(d, &arg::<ComponentInput>(args, "input"))),
        "updateComponent" => design(update_component(d, &text(args, "componentId"), &arg::<ComponentChanges>(args, "changes"))),
        "moveComponent" => design(move_component(d, &text(args, "componentId"), arg::<CanvasPoint>(args, "position"))),
        "removeComponent" => design(remove_component(d, &text(args, "componentId"))),
        "describeComponentRemoval" => plan(describe_component_removal(d, &text(args, "componentId"))),
        "addConnection" => design(add_connection(d, &arg::<ConnectionInput>(args, "input"))),
        "updateConnection" => design(update_connection(d, &text(args, "connectionId"), &arg::<ConnectionChanges>(args, "changes"))),
        "removeConnection" => design(remove_connection(d, &text(args, "connectionId"))),
        "describeConnectionRemoval" => plan(describe_connection_removal(d, &text(args, "connectionId"))),
        other => panic!("unknown operation {other}"),
    }
}

#[test]
fn system_design_operations_match_typescript() {
    let sessions = read_json("system-ops.json");
    let mut failures = Vec::new();
    let mut steps_checked = 0;
    for session in sessions.as_array().unwrap() {
        let name = session["name"].as_str().unwrap();
        let mut state: SystemDesign = serde_json::from_value(session["base"].clone()).expect("base design");
        for (index, step) in session["steps"].as_array().unwrap().iter().enumerate() {
            let op = step["op"].as_str().unwrap();
            let actual = apply(&state, op, &step["args"]);
            let result = &step["result"];
            let mismatch = match (&actual, result.get("ok"), result.get("error")) {
                (Ok(output), Some(expected), _) => {
                    let actual_json = match output {
                        Output::Design(design) => serde_json::to_value(design.as_ref()).unwrap(),
                        Output::Plan(plan) => plan.clone(),
                    };
                    if json_equal(&actual_json, expected) {
                        if let Output::Design(design) = output {
                            state = design.as_ref().clone();
                        }
                        None
                    } else {
                        Some(format!("output differs\n    expected {expected}\n    actual   {actual_json}"))
                    }
                }
                (Err(actual), _, Some(expected)) if Some(actual.as_str()) == expected.as_str() => None,
                (Err(actual), _, Some(expected)) => Some(format!("error differs\n    expected {expected}\n    actual   {actual:?}")),
                (Ok(_), _, Some(expected)) => Some(format!("expected error {expected}, but it succeeded")),
                (Err(actual), Some(_), _) => Some(format!("expected success, got error {actual:?}")),
                _ => Some("malformed fixture step".into()),
            };
            steps_checked += 1;
            if let Some(mismatch) = mismatch {
                failures.push(format!("- {name} step {index}: {op} {}\n    {mismatch}", step["args"]));
                break; // later steps would start from a diverged state
            }
        }
    }
    assert!(failures.is_empty(), "{} sessions diverge from the TypeScript oracle:\n{}", failures.len(), failures.iter().take(5).cloned().collect::<Vec<_>>().join("\n"));
    println!("{steps_checked} steps across the sessions match the TypeScript oracle");
}
