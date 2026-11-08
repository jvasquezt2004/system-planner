//! PostgreSQL identifier naming (`src/shared/postgres-identifiers.ts`).
//!
//! Identifiers are limited to 63 *bytes*, so every cut is made on a character
//! boundary after counting UTF-8 bytes, never characters.

use std::collections::HashSet;

pub const MAX_IDENTIFIER_BYTES: usize = 63;

fn utf8_len(value: &str) -> usize {
    value.len()
}

/// Truncates at a character boundary within `max_bytes`.
pub fn truncate_postgres_identifier(value: &str, max_bytes: usize) -> String {
    let mut bytes = 0;
    let mut out = String::new();
    for character in value.chars() {
        let size = character.len_utf8();
        if bytes + size > max_bytes {
            break;
        }
        bytes += size;
        out.push(character);
    }
    out
}

/// Keeps a distinguishing suffix intact when a generated identifier is shortened.
pub fn postgres_identifier_with_suffix(value: &str, suffix: &str) -> Result<String, String> {
    let Some(available) = MAX_IDENTIFIER_BYTES.checked_sub(utf8_len(suffix)) else {
        return Err("PostgreSQL identifier suffix exceeds the identifier limit.".into());
    };
    Ok(format!("{}{suffix}", truncate_postgres_identifier(value, available)))
}

/// Finds the first available identifier, suffixing collisions with `_2`, `_3`, and so on.
pub fn unique_postgres_identifier(base_name: &str, occupied: &HashSet<String>) -> String {
    for index in 1usize.. {
        let suffix = if index == 1 { String::new() } else { format!("_{index}") };
        let name = postgres_identifier_with_suffix(base_name, &suffix).expect("a counter suffix is short");
        if !occupied.contains(&name) {
            return name;
        }
    }
    unreachable!("an unbounded search always ends")
}

/// Mirrors PostgreSQL `makeObjectName` for implicit indexes and sequences.
pub fn postgres_generated_object_name(name1: &str, name2: Option<&str>, label: &str) -> Result<String, String> {
    let mut name1_bytes = utf8_len(name1);
    let mut name2_bytes = name2.map_or(0, utf8_len);
    let overhead = usize::from(name2.is_some()) + utf8_len(label) + 1;
    let Some(available) = MAX_IDENTIFIER_BYTES.checked_sub(overhead) else {
        return Err("PostgreSQL generated-name label exceeds the identifier limit.".into());
    };
    while name1_bytes + name2_bytes > available {
        if name1_bytes > name2_bytes {
            name1_bytes -= 1;
        } else {
            name2_bytes -= 1;
        }
    }
    let clipped1 = truncate_postgres_identifier(name1, name1_bytes);
    let clipped2 = name2.map(|name| truncate_postgres_identifier(name, name2_bytes));
    Ok(format!("{clipped1}{}_{label}", clipped2.map(|name| format!("_{name}")).unwrap_or_default()))
}
