//! Fills a database with a small demo Project through the workspace, the same path the
//! view uses, so the Tauri window has something to show.
//!
//!   cargo run -p schema-workspace --example seed -- /path/to/db.sqlite [system|database]

use std::sync::Arc;

use schema_domain::geometry::CanvasPoint;
use schema_domain::system_design::SystemViewName;
use schema_sandbox::PgliteSandbox;
use schema_workspace::{Options, Workspace};
use serde_json::json;

fn main() -> Result<(), String> {
    let path = std::env::args().nth(1).ok_or("usage: seed <database path>")?;
    let workspace = Workspace::open(Options::new(path, Arc::new(|| Box::new(PgliteSandbox))))?;
    let design_id = workspace.create_project("Shop")?.active_design_id.expect("a design");

    let customers = workspace.add_table(&design_id, "customers", Some(CanvasPoint { x: 60.0, y: 60.0 }))?.design.expect("design").tables[0].id.clone();
    workspace.add_column(&design_id, &customers, Some("name"), Some("text"))?;
    let email = workspace.add_column(&design_id, &customers, Some("email"), Some("text"))?.design.expect("design").tables[0].columns[2].id.clone();
    workspace.update_column(&design_id, &customers, &email, &json!({ "unique": true, "nullable": false }))?;

    let orders = workspace.add_table(&design_id, "orders", Some(CanvasPoint { x: 420.0, y: 60.0 }))?.design.expect("design").tables[1].id.clone();
    workspace.add_column(&design_id, &orders, Some("customer_id"), Some("bigint"))?;
    workspace.add_column(&design_id, &orders, Some("total"), Some("numeric"))?;
    let placed = workspace.add_column(&design_id, &orders, Some("placed_at"), Some("timestamptz"))?.design.expect("design").tables[1].columns[3].id.clone();
    workspace.update_column(&design_id, &orders, &placed, &json!({ "nullable": false, "default": { "kind": "currentTimestamp" } }))?;

    // The System overview: a storefront calls the Checkout service's API, which writes to the orders
    // database (linked to the design above) and emits payments to a queue. One Walkthrough explains it.
    let call = |method: &str, params: serde_json::Value| workspace.request(method, params);
    call("addSystemService", json!({ "id": "svc-checkout", "name": "Checkout", "x": 330, "y": 40 }))?;
    call("addSystemComponent", json!({ "id": "web", "kind": "browser", "name": "Storefront", "x": 40, "y": 140 }))?;
    call("addSystemComponent", json!({ "id": "api", "kind": "api", "name": "Checkout API", "technology": "Fastify", "x": 380, "y": 120, "serviceId": "svc-checkout" }))?;
    call("addSystemComponent", json!({ "id": "queue", "kind": "queue", "name": "Payments queue", "x": 380, "y": 280, "serviceId": "svc-checkout" }))?;
    call("addSystemComponent", json!({ "id": "db", "kind": "database", "name": "Orders DB", "x": 740, "y": 120 }))?;
    call("linkSystemDatabase", json!({ "componentId": "db", "designId": design_id }))?;
    call("addSystemConnection", json!({ "id": "c1", "sourceId": "web", "targetId": "api", "label": "Places order", "protocol": "HTTPS" }))?;
    call("addSystemConnection", json!({ "id": "c2", "sourceId": "api", "targetId": "db", "label": "Writes order" }))?;
    call("addSystemConnection", json!({ "id": "c3", "sourceId": "api", "targetId": "queue", "label": "Emits payment" }))?;
    call("createWalkthrough", json!({ "id": "wt", "name": "Place an order" }))?;
    call("addWalkthroughStep", json!({ "walkthroughId": "wt", "connectionId": "c1", "id": "s1", "title": "Customer submits the cart", "action": "send", "durationMs": 1200 }))?;
    call("addWalkthroughStep", json!({ "walkthroughId": "wt", "connectionId": "c2", "id": "s2", "title": "The order is stored", "action": "process" }))?;

    let view = std::env::args().nth(2).unwrap_or_else(|| "system".into());
    let state = workspace.set_active_view(if view == "database" { SystemViewName::Database } else { SystemViewName::System })?;
    println!("seeded {} (revision {}, sql {}, sandbox {}, view {})", state.project.expect("project").name, state.revision, state.sql["status"], state.sandbox["status"], view);
    Ok(())
}
