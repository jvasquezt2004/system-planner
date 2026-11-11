//! What the runtime needs of a harness's conversation, whichever harness it is.

use serde_json::Value;

type Result<T> = std::result::Result<T, String>;

/// One conversation with a harness: Codex's app-server thread or an OpenCode session.
pub trait HarnessSession: Send + Sync {
    /// The thread, and the turn while one runs.
    fn target(&self) -> Option<(String, Option<String>)>;
    fn default_model(&self) -> Option<String>;
    /// Sends a message and waits until the turn ends. `Err` says why it did not complete.
    fn send(&self, text: &str, model: Option<&str>, effort: Option<&str>) -> Result<()>;
    fn interrupt(&self) -> Result<()>;
    /// Adds to the turn that is running.
    fn steer(&self, text: &str) -> Result<()>;
    /// Ends a waiting turn because the connection is gone.
    fn close(&self, reason: &str);
    /// Lets the harness's notifications settle a turn (Codex reports completion that way).
    fn accept_notification(&self, _method: &str, _params: &Value) {}
}
