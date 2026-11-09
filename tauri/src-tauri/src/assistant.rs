//! The Assistant's requests from the view. The Assistant only mounts over Codex and OpenCode
//! (ADR 0003), so the provider flows of the Electrobun app (API keys, account sign-in, connections)
//! do not exist here.

use schema_assistant::runtime::{ProjectFolderSync, Runtime};
use serde_json::{json, Value};

use crate::folder::Folder;

type Result<T> = std::result::Result<T, String>;

impl ProjectFolderSync for Folder {
    fn sync(&self, force: bool) -> Option<std::path::PathBuf> {
        Folder::sync(self, force).ok().flatten()
    }

    fn schema_file(&self, design_id: &str) -> Option<std::path::PathBuf> {
        Folder::schema_file(self, design_id)
    }
}

const NO_PROVIDERS: &str = "Provider connections are not part of this app. The Assistant works through Codex or OpenCode.";

fn text<'a>(params: &'a Value, key: &str) -> &'a str {
    params[key].as_str().unwrap_or_default()
}

/// Answers an Assistant request, or `None` for a request that is not the Assistant's.
pub fn request(runtime: &Runtime, method: &str, params: &Value) -> Option<Result<Value>> {
    Some(match method {
        "listAssistantConversations" => runtime.list_conversations(text(params, "projectId")),
        "getAssistantConversation" => runtime.load_conversation(text(params, "conversationId")),
        "createAssistantConversation" => runtime.create_conversation(text(params, "projectId")),
        "renameAssistantConversation" => runtime.rename_conversation(text(params, "conversationId"), text(params, "title")).map(|renamed| json!(renamed)),
        "deleteAssistantConversation" => runtime.delete_conversation(text(params, "conversationId")).map(|deleted| json!(deleted)),
        "listAssistantModels" => runtime.list_models(),
        "listAssistantConnections" => runtime.list_connections(),
        "getAssistantRequestCap" => runtime.get_max_requests_per_turn().map(|cap| json!(cap)),
        "setAssistantRequestCap" => runtime.set_max_requests_per_turn(params["limit"].as_f64().unwrap_or(f64::NAN)).map(|()| Value::Null),
        "sendAssistantMessage" => {
            let thinking = params["thinkingLevel"].as_str().unwrap_or("medium");
            runtime.send_message(text(params, "conversationId"), text(params, "text"), text(params, "modelId"), thinking, params["connectionId"].as_str())
        }
        "stopAssistantTurn" => {
            runtime.stop(text(params, "conversationId"));
            Ok(Value::Null)
        }
        "getAssistantTurnStatus" => Ok(runtime.turn_status(text(params, "conversationId"))),
        "getCodexRequest" => Ok(runtime.get_codex_request(text(params, "conversationId"))),
        "answerCodexRequest" => Ok(json!(runtime.answer_codex_request(text(params, "conversationId"), text(params, "requestId"), &params["response"]))),
        // Verification in the harness's own sign-in flow is not offered here.
        "verifyCodexRequest" => Ok(json!(false)),
        "updateAssistantConversationSelection" => {
            runtime.update_conversation_selection(text(params, "conversationId"), params["connectionId"].as_str(), text(params, "modelId"), params["thinkingLevel"].as_str().unwrap_or("medium")).map(|()| Value::Null)
        }
        "continueAssistantTurn" => Err("This Assistant turn is not waiting to continue.".into()),
        "confirmAssistantDdlDrop" | "rejectAssistantDdlDrop" => Err("The Assistant turn for this confirmation is no longer active.".into()),
        "revertAssistantTurn" => Err("This Assistant turn is no longer available to revert.".into()),
        "setAssistantApiKey" | "removeAssistantConnection" | "startAssistantOAuthLogin" | "answerAssistantOAuthPrompt" | "cancelAssistantOAuthLogin" | "setClaudeOptIn" => Err(NO_PROVIDERS.into()),
        "getClaudeOptIn" => Ok(json!(false)),
        _ => return None,
    })
}
