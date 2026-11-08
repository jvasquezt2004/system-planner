//! Fills a database with a small demo Project through the workspace, the same path the
//! view uses, so the Tauri window has something to show.
//!
//!   cargo run -p schema-workspace --example seed -- /path/to/db.sqlite

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

    let state = workspace.set_active_view(SystemViewName::Database)?;
    println!("seeded {} (revision {}, sql {}, sandbox {})", state.project.expect("project").name, state.revision, state.sql["status"], state.sandbox["status"]);
    Ok(())
}
