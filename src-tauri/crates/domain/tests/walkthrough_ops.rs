mod support;

use schema_domain::system_design::SystemDesign;
use schema_domain::walkthrough::Walkthrough;
use schema_domain::walkthrough_ops::*;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use support::{json_equal, read_json};

enum Output {
    /// The new list of Walkthroughs, which becomes the next state.
    State(Vec<Walkthrough>),
    Read(Value),
}

fn arg<T: DeserializeOwned>(args: &Value, key: &str) -> T {
    serde_json::from_value(args[key].clone()).unwrap_or_else(|error| panic!("argument {key}: {error} in {args}"))
}

fn text(args: &Value, key: &str) -> String {
    args[key].as_str().unwrap_or_else(|| panic!("argument {key} in {args}")).to_owned()
}

fn number(args: &Value, key: &str) -> f64 {
    args[key].as_f64().unwrap_or_else(|| panic!("argument {key} in {args}"))
}

fn state(result: Result<Vec<Walkthrough>, String>) -> Result<Output, String> {
    result.map(Output::State)
}

fn apply(w: &[Walkthrough], designs: &[SystemDesign], op: &str, args: &Value) -> Result<Output, String> {
    let design = || &designs[args["designIndex"].as_u64().unwrap() as usize];
    match op {
        "addWalkthrough" => state(add_walkthrough(w, &arg::<WalkthroughInput>(args, "input"))),
        "renameWalkthrough" => state(rename_walkthrough(w, &text(args, "walkthroughId"), &text(args, "name"))),
        "removeWalkthrough" => state(remove_walkthrough(w, &text(args, "walkthroughId"))),
        "moveWalkthrough" => state(move_walkthrough(w, &text(args, "walkthroughId"), number(args, "toIndex"))),
        "addStep" => state(add_step(w, &text(args, "walkthroughId"), &arg::<StepInput>(args, "input"), design())),
        "addBlock" => state(add_block(w, &text(args, "walkthroughId"), &arg::<BlockInput>(args, "input"))),
        "addParallelBranch" => state(add_parallel_branch(w, &text(args, "walkthroughId"), &text(args, "blockId"))),
        "updateRepeat" => state(update_repeat(w, &text(args, "walkthroughId"), &text(args, "blockId"), number(args, "count"))),
        "updateStep" => state(update_step(w, &text(args, "walkthroughId"), &text(args, "stepId"), &arg::<StepDraft>(args, "changes"))),
        "moveStep" => state(move_step(w, &text(args, "walkthroughId"), &text(args, "stepId"), number(args, "toIndex"))),
        "moveBlock" => state(move_block(w, &text(args, "walkthroughId"), &text(args, "blockId"), number(args, "toIndex"))),
        "removeStep" => state(remove_step(w, &text(args, "walkthroughId"), &text(args, "stepId"))),
        "removeBlock" => state(remove_block(w, &text(args, "walkthroughId"), &text(args, "blockId"))),
        "repairStep" => state(repair_step(w, &text(args, "walkthroughId"), &text(args, "stepId"), &text(args, "connectionId"), design())),
        "acceptRedirection" => state(accept_step_redirection(w, &text(args, "walkthroughId"), &text(args, "stepId"), design())),
        "stepsOnConnections" => {
            let ids: Vec<String> = arg(args, "connectionIds");
            Ok(Output::Read(serde_json::to_value(steps_on_connections(w, &ids)).unwrap()))
        }
        "stepStatuses" => Ok(Output::Read(Value::Array(
            w.iter()
                .flat_map(|walkthrough| walkthrough_steps(walkthrough))
                .map(|step| json!({ "stepId": step.id, "status": step_status(step, design()) }))
                .collect(),
        ))),
        other => panic!("unknown operation {other}"),
    }
}

#[test]
fn walkthrough_operations_match_typescript() {
    let fixture = read_json("walkthrough-ops.json");
    let designs: Vec<SystemDesign> = serde_json::from_value(fixture["designs"].clone()).expect("designs");
    let mut failures = Vec::new();
    let mut steps_checked = 0;
    for session in fixture["sessions"].as_array().unwrap() {
        let name = session["name"].as_str().unwrap();
        let mut current: Vec<Walkthrough> = serde_json::from_value(session["base"].clone()).expect("base walkthroughs");
        for (index, step) in session["steps"].as_array().unwrap().iter().enumerate() {
            let op = step["op"].as_str().unwrap();
            let actual = apply(&current, &designs, op, &step["args"]);
            let result = &step["result"];
            let mismatch = match (&actual, result.get("ok"), result.get("error")) {
                (Ok(output), Some(expected), _) => {
                    let actual_json = match output {
                        Output::State(list) => serde_json::to_value(list).unwrap(),
                        Output::Read(value) => value.clone(),
                    };
                    if json_equal(&actual_json, expected) {
                        if let Output::State(list) = output {
                            current = list.clone();
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
