//! Decoding a PNG sent as base64 and refusing anything that is not a complete one (`decodePng`).

const SIGNATURE: [u8; 8] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/// Every PNG ends with this zero-length IEND chunk, so its presence shows the file was not cut short.
const TRAILER: [u8; 12] = [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];

/// Node's lenient base64: letters, digits and either alphabet's symbols count, everything else
/// between them is skipped, and decoding stops at the first padding.
pub fn lenient_base64(text: &str) -> Vec<u8> {
    let mut bytes = Vec::new();
    let (mut accumulator, mut bits) = (0u32, 0u32);
    for c in text.chars() {
        let value = match c {
            'A'..='Z' => c as u32 - 'A' as u32,
            'a'..='z' => c as u32 - 'a' as u32 + 26,
            '0'..='9' => c as u32 - '0' as u32 + 52,
            '+' | '-' => 62,
            '/' | '_' => 63,
            '=' => break,
            _ => continue,
        };
        accumulator = accumulator << 6 | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push((accumulator >> bits & 0xff) as u8);
        }
    }
    bytes
}

pub fn decode_png(base64: &str) -> Result<Vec<u8>, String> {
    if base64.is_empty() {
        return Err("No System design diagram is available to export.".into());
    }
    let bytes = lenient_base64(base64);
    let header_end = SIGNATURE.len() + 25;
    let be = |at: usize| u32::from_be_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]);
    let looks_like_png = bytes.len() >= header_end + TRAILER.len()
        && bytes[..SIGNATURE.len()] == SIGNATURE
        && be(SIGNATURE.len()) == 13
        && &bytes[SIGNATURE.len() + 4..SIGNATURE.len() + 8] == b"IHDR"
        && be(SIGNATURE.len() + 8) > 0
        && be(SIGNATURE.len() + 12) > 0
        && bytes[bytes.len() - TRAILER.len()..] == TRAILER;
    if !looks_like_png {
        return Err("The System design image is not a complete PNG.".into());
    }
    Ok(bytes)
}
