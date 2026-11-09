//! The desktop's side of the file actions: the native pickers and the clipboard.

use schema_transfer::Platform;
use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;

pub struct Desktop {
    pub app: AppHandle,
}

impl Platform for Desktop {
    fn choose_directory(&self) -> Option<String> {
        let folder = self.app.dialog().file().blocking_pick_folder()?;
        folder.into_path().ok().map(|path| path.to_string_lossy().into_owned())
    }

    fn choose_file(&self) -> Option<String> {
        let file = self.app.dialog().file().blocking_pick_file()?;
        file.into_path().ok().map(|path| path.to_string_lossy().into_owned())
    }

    fn write_clipboard_text(&self, text: &str) -> Result<(), String> {
        self.app.clipboard().write_text(text.to_owned()).map_err(|error| error.to_string())
    }

    fn now_millis(&self) -> i64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis() as i64)
    }
}
