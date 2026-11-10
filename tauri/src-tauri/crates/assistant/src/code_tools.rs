//! `manage_code` (the tool in the original runtime): create, rename, remove, write or exact-string-edit
//! a Scenario, an Edge function or a design Function's body.
//!
//! TypeScript diagnostics of the written source are not produced here: the original runs the
//! TypeScript compiler over it, and the result says that no diagnostics are available.

use std::sync::Arc;

use serde_json::{json, Value};

use crate::read_tools::ToolContext;
use crate::tools::{ProjectTool, ToolResult};

type Result<T> = std::result::Result<T, String>;

pub struct ManageCode(pub Arc<ToolContext>);

fn field<'a>(item: &'a Value, key: &str) -> &'a str {
    item[key].as_str().unwrap_or_default()
}

/// Refuses a change to code the Assistant read before it changed.
fn check_relevant_content(reads: &crate::read_tools::ReadState, state: &schema_workspace::WorkspaceState, kind: &str, id: Option<&str>, action: &str, name: Option<&str>) -> Result<()> {
    let (Some(read_scenarios), Some(read_edge)) = (&reads.scenarios, &reads.edge_functions) else { return Ok(()) };
    if action == "create" {
        if let Some(name) = name {
            let trimmed = schema_domain::js::trim(name);
            let (label, read, current) = match kind {
                "scenario" => ("Scenario", read_scenarios, &state.scenarios),
                "edge-function" => ("Edge function", read_edge, &state.edge_functions),
                _ => return Ok(()),
            };
            if !read.iter().any(|item| field(item, "name") == trimmed) && current.iter().any(|item| field(item, "name") == trimmed) {
                return Err(format!("Stale relevant content: {label} \"{trimmed}\" was created since last read. Re-read the project before creating it."));
            }
        }
        return Ok(());
    }
    let Some(id) = id.filter(|id| !id.is_empty()) else { return Ok(()) };
    let (label, read, current): (&str, Option<&Vec<Value>>, Vec<Value>) = match kind {
        "scenario" => ("Scenario", Some(read_scenarios), state.scenarios.clone()),
        "edge-function" => ("Edge function", Some(read_edge), state.edge_functions.clone()),
        _ => ("Function", reads.functions.as_ref(), state.design.iter().flat_map(|design| design.functions.iter().flatten()).map(|function| json!(function)).collect()),
    };
    let read_item = read.and_then(|items| items.iter().find(|item| field(item, "id") == id));
    let current_item = current.iter().find(|item| field(item, "id") == id);
    let content = |item: &Value| if kind == "function-body" { field(item, "body").to_owned() } else { format!("{}\u{0}{}", field(item, "source"), field(item, "name")) };
    match (read_item, current_item) {
        (Some(read), Some(current)) if content(read) != content(current) => {
            Err(format!("Stale relevant content: {label} \"{}\" changed since last read. Re-read the project before writing code.", field(current, "name")))
        }
        (Some(read), None) => Err(format!("Stale relevant content: {label} \"{}\" was removed since last read. Re-read the project before writing code.", field(read, "name"))),
        _ => Ok(()),
    }
}

impl ProjectTool for ManageCode {
    fn name(&self) -> &str {
        "manage_code"
    }

    fn description(&self) -> &str {
        "Create (optionally with its full source), rename, or remove a Scenario or Edge function; write or exact-string-edit a Scenario, Edge function, or design Function body. Every edit must match exactly once. Code writes use ordinary workspace saves; tool results include the complete source diff and TypeScript diagnostics for Scenarios and Edge functions (not available in this app yet)."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "action": { "enum": ["create", "rename", "remove", "write", "edit"] },
                "kind": { "enum": ["scenario", "edge-function", "function-body"] },
                "id": { "type": "string" }, "name": { "type": "string" }, "source": { "type": "string" },
                "oldText": { "type": "string" }, "newText": { "type": "string" },
            },
            "required": ["action", "kind"],
        })
    }

    fn execute(&self, _call_id: &str, arguments: &Value) -> Result<ToolResult> {
        let context = &self.0;
        let state = context.bound_state()?;
        let (mut action, kind) = (arguments["action"].as_str().unwrap_or_default().to_owned(), arguments["kind"].as_str().unwrap_or_default().to_owned());
        let mut id = arguments["id"].as_str().filter(|id| !id.is_empty()).map(str::to_owned);
        let name = arguments["name"].as_str().filter(|name| !name.is_empty());
        let design_id = context.target.1.clone();
        let turn = (context.turn_id)();
        let turn = turn.as_deref();
        {
            let reads = context.reads.lock().map_err(|_| "Read state is unavailable.")?;
            check_relevant_content(&reads, &context.workspace.state(), &kind, id.as_deref(), &action, name)?;
        }
        let remember = |state: &schema_workspace::WorkspaceState| {
            if let Ok(mut reads) = context.reads.lock() {
                match kind.as_str() {
                    "scenario" => reads.scenarios = Some(state.scenarios.clone()),
                    "edge-function" => reads.edge_functions = Some(state.edge_functions.clone()),
                    _ => {
                        reads.functions = Some(state.design.iter().flat_map(|design| design.functions.iter().flatten()).map(|function| json!(function)).collect());
                    }
                }
            }
        };
        let check_target = |after: &schema_workspace::WorkspaceState, message: &str| -> Result<()> {
            let open = (after.project.as_ref().map(|project| project.id.as_str()), after.active_design_id.as_deref());
            if open != (Some(context.target.0.as_str()), Some(context.target.1.as_str())) {
                return Err(message.to_owned());
            }
            Ok(())
        };
        let mut params = json!({ "designId": design_id });
        if let Some(turn) = turn {
            params["assistantTurnId"] = json!(turn);
        }
        let details_of = |value: Value| ToolResult { content: vec![value.to_string()], details: value, is_error: false };
        let project_and_design = json!({ "projectId": context.target.0, "designId": context.target.1 });

        if action == "create" {
            if kind == "function-body" {
                return Err("Function bodies cannot be created; define a Function in the schema SQL.".into());
            }
            let Some(name) = name else { return Err("A name is required to create a code item.".into()) };
            let mut create = params.clone();
            create["name"] = json!(name);
            let after = context.workspace.request(if kind == "scenario" { "createScenario" } else { "createEdgeFunction" }, create)?;
            let _ = after;
            let after = context.workspace.state();
            check_target(&after, "The project or Design changed before the code item was created.")?;
            let trimmed = schema_domain::js::trim(name);
            let list = if kind == "scenario" { &after.scenarios } else { &after.edge_functions };
            let Some(item) = list.iter().find(|candidate| field(candidate, "name") == trimmed).cloned() else {
                return Err("The created code item could not be found in the bound project and Design.".into());
            };
            remember(&after);
            if arguments.get("source").is_none() {
                let mut details = json!({ "action": "created", "kind": kind, "id": item["id"], "name": item["name"] });
                details.as_object_mut().map(|object| object.extend(project_and_design.as_object().cloned().unwrap_or_default()));
                return Ok(details_of(details));
            }
            // A create that carries source continues as a whole-file write of the new item.
            id = item["id"].as_str().map(str::to_owned);
            action = "write".into();
        }
        if action == "rename" || action == "remove" {
            if kind == "function-body" {
                return Err("Function bodies cannot be renamed or removed through code tools.".into());
            }
            let Some(id) = id.as_deref() else { return Err("An item id is required to rename or remove a code item.".into()) };
            if action == "rename" && name.is_none() {
                return Err("A new name is required to rename a code item.".into());
            }
            let mut request = params.clone();
            let method = match (kind.as_str(), action.as_str()) {
                ("scenario", "rename") => {
                    request["scenarioId"] = json!(id);
                    request["name"] = json!(name);
                    "renameScenario"
                }
                ("scenario", _) => {
                    request["scenarioId"] = json!(id);
                    "removeScenario"
                }
                (_, "rename") => {
                    request["edgeFunctionId"] = json!(id);
                    request["name"] = json!(name);
                    "renameEdgeFunction"
                }
                _ => {
                    request["edgeFunctionId"] = json!(id);
                    "removeEdgeFunction"
                }
            };
            context.workspace.request(method, request)?;
            let after = context.workspace.state();
            check_target(&after, "The project or Design changed before the code item was updated.")?;
            remember(&after);
            let mut details = json!({ "action": if action == "rename" { "renamed" } else { "removed" }, "kind": kind, "id": id });
            if let Some(name) = name {
                details["name"] = json!(name);
            }
            details.as_object_mut().map(|object| object.extend(project_and_design.as_object().cloned().unwrap_or_default()));
            return Ok(details_of(details));
        }

        let Some(id) = id else { return Err("An item id is required to write code.".into()) };
        let current = context.workspace.state();
        let (item_name, before) = match kind.as_str() {
            "scenario" => {
                let item = current.scenarios.iter().find(|item| field(item, "id") == id).ok_or("That Scenario could not be found in the bound project.")?;
                (field(item, "name").to_owned(), field(item, "source").to_owned())
            }
            "edge-function" => {
                let item = current.edge_functions.iter().find(|item| field(item, "id") == id).ok_or("That Edge function could not be found in the bound project.")?;
                (field(item, "name").to_owned(), field(item, "source").to_owned())
            }
            _ => {
                let function = current.design.iter().flat_map(|design| design.functions.iter().flatten()).find(|function| function.id == id).ok_or("That Function could not be found in the bound project.")?;
                (function.name.clone(), function.body.clone())
            }
        };
        let after_text = if action == "write" {
            arguments["source"].as_str().ok_or("A complete source string is required for a whole-file write.")?.to_owned()
        } else {
            let (Some(old), Some(new)) = (arguments["oldText"].as_str(), arguments["newText"].as_str()) else { return Err("Exact-string edit requires oldText and newText.".into()) };
            let matches = if old.is_empty() { 0 } else { before.matches(old).count() };
            // Matches are counted from every start, so overlapping ones count too.
            let overlapping = if old.is_empty() { 0 } else { (0..before.len()).filter(|start| before.is_char_boundary(*start) && before[*start..].starts_with(old)).count() };
            let found = matches.max(overlapping);
            if found != 1 {
                return Err(format!("Exact-string edit expected exactly one match; found {found}."));
            }
            before.replacen(old, new, 1)
        };
        let mut request = params.clone();
        let after = match kind.as_str() {
            "scenario" => {
                request["scenarioId"] = json!(id);
                request["source"] = json!(after_text);
                context.workspace.request("updateScenarioSource", request)?;
                context.workspace.state()
            }
            "edge-function" => {
                request["edgeFunctionId"] = json!(id);
                request["source"] = json!(after_text);
                context.workspace.request("updateEdgeFunctionSource", request)?;
                context.workspace.state()
            }
            _ => {
                let mut design = current.design.clone().ok_or("Open a project before writing a Function body.")?;
                for function in design.functions.iter_mut().flatten() {
                    if function.id == id {
                        function.body = after_text.clone();
                    }
                }
                context.workspace.apply_assistant_design(design, &design_id, turn)?
            }
        };
        check_target(&after, "The project or Design changed before the code write completed.")?;
        remember(&after);
        let applied = match kind.as_str() {
            "scenario" => after.scenarios.iter().find(|item| field(item, "id") == id).map(|item| field(item, "source").to_owned()),
            "edge-function" => after.edge_functions.iter().find(|item| field(item, "id") == id).map(|item| field(item, "source").to_owned()),
            _ => after.design.iter().flat_map(|design| design.functions.iter().flatten()).find(|function| function.id == id).map(|function| function.body.clone()),
        };
        if applied.as_deref() != Some(after_text.as_str()) {
            return Err("The code write was not saved to the bound project and Design.".into());
        }
        let note = if kind == "function-body" { "TypeScript diagnostics do not apply to SQL Function bodies." } else { "TypeScript diagnostics are not available in this app yet." };
        let mut details = json!({ "action": action, "kind": kind, "id": id, "name": item_name, "diagnostics": [], "diagnosticsNote": note });
        details.as_object_mut().map(|object| object.extend(project_and_design.as_object().cloned().unwrap_or_default()));
        let (shown, _) = (details.clone(), 0);
        let mut recorded = details;
        recorded["before"] = json!(before);
        recorded["after"] = json!(after_text);
        Ok(ToolResult { content: vec![shown.to_string()], details: recorded, is_error: false })
    }
}
