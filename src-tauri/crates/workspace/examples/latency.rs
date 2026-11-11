//! How long each edit takes to settle with the real sandbox. An edit returns once its SQL preview
//! has been validated, so this is the latency the view waits on.
//!
//!   cargo run --release -p schema-workspace --example latency

use std::sync::Arc;
use std::time::Instant;

use schema_sandbox::PgliteSandbox;
use schema_workspace::{Options, Workspace};

fn main() -> Result<(), String> {
    let directory = std::env::temp_dir().join(format!("latency-{}", std::process::id()));
    let workspace = Workspace::open(Options::new(directory.join("db.sqlite"), Arc::new(|| Box::new(PgliteSandbox))))?;
    let design_id = workspace.create_project("Latency")?.active_design_id.expect("design");
    let mut table = String::new();
    for step in 0..8 {
        let started = Instant::now();
        let label = if step == 0 {
            table = workspace.add_table(&design_id, "orders", None)?.design.expect("design").tables[0].id.clone();
            "add table (first sandbox in the process)".to_owned()
        } else {
            workspace.add_column(&design_id, &table, Some(&format!("c{step}")), Some("text"))?;
            format!("add column {step}")
        };
        println!("{:>6.0} ms  {label}", started.elapsed().as_secs_f64() * 1000.0);
    }
    let started = Instant::now();
    workspace.set_viewport(&design_id, 5.0, 5.0, 1.0)?;
    println!("{:>6.0} ms  pan the canvas (layout only, no preview)", started.elapsed().as_secs_f64() * 1000.0);
    let _ = std::fs::remove_dir_all(directory);
    Ok(())
}
