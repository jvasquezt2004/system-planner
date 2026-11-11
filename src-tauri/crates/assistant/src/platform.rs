//! The few places where Windows differs from Unix for starting a harness.

use std::path::PathBuf;
use std::process::Command;

/// The user's home directory: `HOME` on Unix, `USERPROFILE` on Windows.
pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).filter(|home| !home.is_empty()).map(PathBuf::from)
}

/// `HOME` as text, or `.` when the machine has none, for a directory a harness can start in.
pub fn home_or_current() -> String {
    home_dir().map_or_else(|| ".".to_owned(), |home| home.to_string_lossy().into_owned())
}

/// The file names a command can have on this platform: Windows installs add `.exe` or `.cmd`.
pub fn executable_names(base: &str) -> Vec<String> {
    if cfg!(windows) { vec![format!("{base}.exe"), format!("{base}.cmd"), format!("{base}.bat"), base.to_owned()] } else { vec![base.to_owned()] }
}

/// A command found on `PATH` under any of its platform names.
pub fn find_on_path(base: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    let names = executable_names(base);
    std::env::split_paths(&paths).flat_map(|directory| names.iter().map(move |name| directory.join(name))).find(|candidate| candidate.is_file())
}

/// Keeps a console window from flashing up when the desktop app starts a command-line harness.
pub fn hide_console(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
}
