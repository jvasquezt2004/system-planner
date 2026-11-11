//! Writing new files and naming them (`writeNewFile`, `exportFileName` and `systemDesignFileName`
//! in the original).

use std::io::Write;
use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;
use schema_domain::js;
use unicode_normalization::UnicodeNormalization;

/// Node's wording for the failures a designer can meet, so messages read the same as before.
pub fn io_error_message(error: &std::io::Error, path: &Path) -> String {
    #[cfg(target_os = "macos")]
    const NAME_TOO_LONG: i32 = 63;
    #[cfg(not(target_os = "macos"))]
    const NAME_TOO_LONG: i32 = 36;
    let (code, text) = match (error.kind(), error.raw_os_error()) {
        (std::io::ErrorKind::AlreadyExists, _) => ("EEXIST", "file already exists"),
        (std::io::ErrorKind::NotFound, _) => ("ENOENT", "no such file or directory"),
        (std::io::ErrorKind::PermissionDenied, _) => ("EACCES", "permission denied"),
        (_, Some(code)) if code == NAME_TOO_LONG => ("ENAMETOOLONG", "name too long"),
        (std::io::ErrorKind::NotADirectory, _) => ("ENOTDIR", "not a directory"),
        (std::io::ErrorKind::IsADirectory, _) => ("EISDIR", "illegal operation on a directory"),
        (std::io::ErrorKind::ReadOnlyFilesystem, _) => ("EROFS", "read-only file system"),
        (std::io::ErrorKind::StorageFull, _) => ("ENOSPC", "no space left on device"),
        _ => return error.to_string(),
    };
    format!("{code}: {text}, open '{}'", path.display())
}

pub fn is_already_exists(message: &str) -> bool {
    message.starts_with("EEXIST:")
}

/// Writes a file that does not exist yet; an existing file is never overwritten, and a failed
/// write leaves nothing behind.
pub fn write_new_file(path: &Path, contents: &[u8]) -> Result<(), String> {
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(path).map_err(|error| io_error_message(&error, path))?;
    let written = file.write_all(contents).and_then(|()| file.sync_all());
    drop(file);
    if let Err(error) = written {
        let _ = std::fs::remove_file(path);
        return Err(error.to_string());
    }
    Ok(())
}

fn slug(name: &str) -> String {
    static NOT_ALPHANUMERIC: OnceLock<Regex> = OnceLock::new();
    let pattern = NOT_ALPHANUMERIC.get_or_init(|| Regex::new(r"[^\p{L}\p{N}]+").expect("valid pattern"));
    let decomposed: String = name.nfkd().collect();
    let dashed = pattern.replace_all(&decomposed, "-");
    js::slice(&dashed.trim_matches('-').to_lowercase(), 60)
}

/// `toISOString().replace(/[:.]/g, "-")`: "2026-10-26T21-00-00-000Z".
pub fn timestamp(millis: i64) -> String {
    let days = millis.div_euclid(86_400_000);
    let of_day = millis.rem_euclid(86_400_000);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 { month_index + 3 } else { month_index - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}-{:02}-{:02}-{:03}Z",
        of_day / 3_600_000,
        of_day / 60_000 % 60,
        of_day / 1000 % 60,
        of_day % 1000
    )
}

/// "shop-2026-10-26T21-00-00-000Z.schema-designer.json": a new name each export, so a repeat never collides.
pub fn export_file_name(project_name: &str, now: i64) -> String {
    let slug = slug(project_name);
    format!("{}-{}{}", if slug.is_empty() { "project" } else { &slug }, timestamp(now), schema_domain::project_portability::PROJECT_EXPORT_FILE_SUFFIX)
}

/// "shop-system-design-2026-10-26T21-00-00-000Z.svg": the same rule for every System design image format.
pub fn system_design_file_name(project_name: &str, now: i64, extension: &str) -> String {
    let slug = slug(project_name);
    format!("{}-system-design-{}.{extension}", if slug.is_empty() { "project" } else { &slug }, timestamp(now))
}
