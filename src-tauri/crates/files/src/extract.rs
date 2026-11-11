//! The text the Assistant reads for a file, or why there is none. Nothing here executes the file.

use schema_domain::js;

use crate::{file_extension, is_text_file_name};

/// Text kept per file; the rest of a very long document is not searchable by the Assistant.
const STORED_TEXT_LIMIT: usize = 2_000_000;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ExtractedText {
    pub text: Option<String>,
    pub pages: Option<i64>,
    pub note: Option<String>,
}

fn note(text: &str) -> ExtractedText {
    ExtractedText { text: None, pages: None, note: Some(text.to_owned()) }
}

pub fn extract_file_text(name: &str, bytes: &[u8]) -> ExtractedText {
    let extension = file_extension(name);
    if extension == "pdf" {
        return match pdf_extract::extract_text_from_mem_by_pages(bytes) {
            Ok(pages) => {
                let total = pages.len() as i64;
                let text = js::trim(&pages.join("\n\n")).to_owned();
                if text.is_empty() {
                    ExtractedText { text: None, pages: Some(total), note: Some("No text found: this PDF looks scanned or is made of images.".into()) }
                } else {
                    ExtractedText { text: Some(js::slice(&text, STORED_TEXT_LIMIT)), pages: Some(total), note: None }
                }
            }
            Err(error) => {
                let message = error.to_string();
                let lower = message.to_lowercase();
                note(&if lower.contains("password") || lower.contains("encrypt") {
                    "This PDF is password protected.".to_owned()
                } else {
                    format!("The PDF could not be read: {message}")
                })
            }
        };
    }
    if is_text_file_name(name) {
        let text = String::from_utf8_lossy(bytes).replace('\0', "");
        return if js::trim(&text).is_empty() {
            note("The file is empty.")
        } else {
            ExtractedText { text: Some(js::slice(&text, STORED_TEXT_LIMIT)), pages: None, note: None }
        };
    }
    if ["png", "jpg", "jpeg", "gif", "webp"].contains(&extension.as_str()) {
        return note("An image: it has no text to read.");
    }
    note("Text can be read from PDF and plain text files only.")
}
