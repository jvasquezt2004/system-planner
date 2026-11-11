mod support;

use schema_domain::geometry::CanvasPoint;
use schema_domain::system_design::SystemDesign;
use schema_domain::system_layout::*;
use serde_json::{json, Value};
use support::{json_equal, read_json};

#[test]
fn layout_matches_the_typescript_engine() {
    let cases = read_json("layout.json");
    let mut failures = Vec::new();
    for (index, case) in cases.as_array().unwrap().iter().enumerate() {
        let design: SystemDesign = match serde_json::from_value(case["design"].clone()) {
            Ok(design) => design,
            Err(error) => panic!("case {index}: design: {error}"),
        };
        let args = &case["args"];
        let ids = |key: &str| -> Vec<String> { args[key].as_array().into_iter().flatten().map(|id| id.as_str().unwrap().to_owned()).collect() };
        let point = || CanvasPoint { x: args["x"].as_f64().unwrap(), y: args["y"].as_f64().unwrap() };
        let frame = |frame: Option<(CanvasPoint, schema_domain::geometry::Size)>| frame.map_or(Value::Null, |(position, size)| json!({ "position": { "x": position.x, "y": position.y }, "size": { "width": size.width, "height": size.height } }));
        let actual: Result<Value, String> = match case["kind"].as_str().unwrap() {
            "layout" => {
                let subset = args.get("ids").filter(|ids| !ids.is_null()).map(|_| ids("ids"));
                compute_system_layout(&design, subset.as_deref()).map(|placement| placement.to_value())
            }
            "spot" => Ok({ let spot = open_spot_near(&design, point()); json!({ "x": spot.x, "y": spot.y }) }),
            "serviceSpot" => Ok({ let spot = open_service_spot_near(&design, point()); json!({ "x": spot.x, "y": spot.y }) }),
            "frame" => Ok(frame(frame_around_members(&design, &ids("members")))),
            other => panic!("unknown kind {other}"),
        };
        let expected = &case["result"];
        let matches = match (&actual, expected.get("ok"), expected.get("error")) {
            (Ok(actual), Some(ok), _) => json_equal(actual, ok),
            (Err(actual), _, Some(error)) => error.as_str() == Some(actual.as_str()),
            _ => false,
        };
        if !matches {
            let first = match (&actual, expected.get("ok")) {
                (Ok(actual), Some(ok)) => ["components", "services", "groups"].iter().find(|key| !json_equal(&actual[**key], &ok[**key])).map_or("shape".to_owned(), |key| format!("{key}: expected {} actual {}", ok[*key], actual[*key])),
                _ => String::new(),
            };
            failures.push(format!("case {index} {} {args}\n  {first}", case["kind"]));
        }
    }
    assert!(failures.is_empty(), "{} of {} cases differ:\n{}", failures.len(), cases.as_array().unwrap().len(), failures.iter().take(4).cloned().collect::<Vec<_>>().join("\n"));
}
