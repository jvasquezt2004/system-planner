mod support;

use schema_domain::system_design::normalize_system_design;
use schema_domain::walkthrough::normalize_walkthroughs;
use support::{read_json, replay};

#[test]
fn system_design_matches_typescript() {
    replay(&read_json("system-design.json"), |input| {
        let design = normalize_system_design(input)?;
        Ok(serde_json::to_value(design).expect("serializes"))
    });
}

#[test]
fn walkthroughs_match_typescript() {
    replay(&read_json("walkthroughs.json"), |input| {
        let walkthroughs = normalize_walkthroughs(input)?;
        Ok(serde_json::to_value(walkthroughs).expect("serializes"))
    });
}

#[test]
fn designs_match_typescript() {
    replay(&read_json("designs.json"), |input| schema_domain::design::normalize_design(input));
}

/// Every accepted, normalized Design must survive the typed model unchanged, so
/// saving through the Rust structs never loses or alters stored data.
#[test]
fn typed_design_is_lossless() {
    let cases = read_json("designs.json");
    let mut not_typed = Vec::new();
    let mut checked = 0;
    for case in cases.as_array().unwrap() {
        let Some(expected) = case["result"].get("ok") else { continue };
        let name = case["name"].as_str().unwrap().to_owned();
        match serde_json::from_value::<schema_domain::design::Design>(expected.clone()) {
            Ok(design) => {
                let actual = serde_json::to_value(&design).unwrap();
                assert!(support::json_equal(&actual, expected), "{name}: typed round trip changed the document\n  before {expected}\n  after  {actual}");
                checked += 1;
            }
            Err(error) => not_typed.push(format!("{name}: {error}")),
        }
    }
    println!("{checked} documents round-trip; {} cannot be typed:", not_typed.len());
    for entry in &not_typed {
        println!("  {entry}");
    }
    // These cases keep deliberately wrong field types, which JavaScript tolerates and a typed model cannot.
    let garbage = ["unique text", "unique number", "rowLevelSecurity text", "rowLevelSecurity number", "notes number", "viewport partial", "viewport empty"];
    for entry in &not_typed {
        assert!(garbage.iter().any(|marker| entry.contains(marker)), "unexpected untypeable document: {entry}");
    }
}
