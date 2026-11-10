//! A development aid, compiled into debug builds only: with `SCHEMA_DESIGNER_DEBUG_SOCKET` set to a
//! path, the app listens on that Unix socket, runs each script it receives in its own window and
//! sends back what the script returned. It lets a developer (or an agent) drive the real window,
//! with no synthetic input to the desktop. Release builds do not contain it.

#![cfg(all(debug_assertions, unix))]

use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::unix::net::UnixListener;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tauri::Manager;

fn waiting() -> &'static Mutex<HashMap<u64, Sender<String>>> {
    static WAITING: OnceLock<Mutex<HashMap<u64, Sender<String>>>> = OnceLock::new();
    WAITING.get_or_init(Default::default)
}

/// The window's answer to a script (sent through the `__debugReport` message).
pub fn report(id: u64, result: String) {
    if let Some(sender) = waiting().lock().expect("debug waiting").remove(&id) {
        let _ = sender.send(result);
    }
}

pub fn start(app: tauri::AppHandle) {
    let Some(path) = std::env::var_os("SCHEMA_DESIGNER_DEBUG_SOCKET") else { return };
    let _ = std::fs::remove_file(&path);
    let Ok(listener) = UnixListener::bind(&path) else {
        eprintln!("[debug] could not listen on {}", path.to_string_lossy());
        return;
    };
    eprintln!("[debug] listening on {}", path.to_string_lossy());
    std::thread::spawn(move || {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            std::thread::spawn(move || {
                let mut stream = stream;
                let mut script = String::new();
                if stream.read_to_string(&mut script).is_err() {
                    return;
                }
                let id = NEXT.fetch_add(1, Ordering::SeqCst);
                let (sender, receiver) = mpsc::channel();
                waiting().lock().expect("debug waiting").insert(id, sender);
                let Some(window) = app.get_webview_window("main") else {
                    let _ = stream.write_all(b"ERROR: no main window");
                    return;
                };
                let wrapped = format!(
                    "(async () => {{ let report; try {{ const value = await (async () => {{ {script} }})(); report = typeof value === 'string' ? value : JSON.stringify(value === undefined ? null : value); }} catch (error) {{ report = 'ERROR: ' + (error && error.stack || error); }} await window.__TAURI_INTERNALS__.invoke('rpc_message', {{ method: '__debugReport', params: {{ id: {id}, result: report }} }}); }})();"
                );
                if let Err(error) = window.eval(&wrapped) {
                    let _ = stream.write_all(format!("ERROR: {error}").as_bytes());
                    return;
                }
                let answer = receiver.recv_timeout(Duration::from_secs(60)).unwrap_or_else(|_| "ERROR: the window did not answer in time".to_owned());
                let _ = stream.write_all(answer.as_bytes());
            });
        }
    });
}
