//! MoleculeForge desktop shell (Tauri 2).
//!
//! Responsibilities: host the bundled UI, run the compute sidecar over stdio, relay validated
//! JSON-RPC between them, and mediate file dialogs. The web view gets exactly four commands
//! (see capabilities/main.json) and no filesystem, shell or network access of its own.

mod files;
mod sidecar;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Instant;

use sidecar::SidecarState;
use tauri::{Manager, RunEvent, State};

static STARTED: OnceLock<Instant> = OnceLock::new();
static INTERACTIVE: AtomicBool = AtomicBool::new(false);

#[tauri::command]
fn rpc_send(line: String, state: State<'_, SidecarState>, picked: State<'_, files::PickedModel>) -> Result<(), String> {
    sidecar::validate_request(&line)?;
    {
        let chosen = picked.0.lock().map_err(|_| "model state poisoned")?;
        sidecar::check_model_path(&line, chosen.as_deref())?;
    }
    // Performance probe (§10 cold start): the UI asks for capabilities as soon as the engine is
    // ready, which is when the app becomes interactive. Reported only when MF_STARTUP_PROBE is set.
    if !INTERACTIVE.load(Ordering::Relaxed) && line.contains("\"system.capabilities\"") && std::env::var_os("MF_STARTUP_PROBE").is_some() {
        INTERACTIVE.store(true, Ordering::Relaxed);
        if let Some(start) = STARTED.get() {
            eprintln!("MoleculeForge startup: interactive after {} ms", start.elapsed().as_millis());
        }
    }
    sidecar::send(&state, &line)
}

pub fn run() {
    let _ = STARTED.set(Instant::now());
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(SidecarState::default())
        .manage(files::PickedModel::default())
        .invoke_handler(tauri::generate_handler![rpc_send, files::open_text_file, files::save_file, files::choose_model])
        .setup(|app| {
            #[cfg(debug_assertions)]
            if std::env::var_os("MF_DEVTOOLS").is_some() {
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                }
            }
            let handle = app.handle().clone();
            if let Err(message) = sidecar::spawn(&handle, &app.state::<SidecarState>()) {
                // The UI shows the engine as unavailable; the reason goes to the log.
                eprintln!("MoleculeForge: compute engine failed to start: {message}");
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building MoleculeForge");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            sidecar::shutdown(&handle.state::<SidecarState>());
        }
    });
}
