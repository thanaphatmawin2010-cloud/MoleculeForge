//! The compute sidecar: a child process speaking newline-delimited JSON-RPC 2.0 over stdio.
//!
//! No sockets are involved. Requests from the web view are validated here (size, shape and a
//! method allowlist) before they reach the sidecar; every line the sidecar prints is forwarded
//! to the main window as a `sidecar://message` event. If the sidecar exits, a synthetic
//! `sidecar.exit` notification is forwarded so the UI can tell the user.

use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

/// Largest request accepted from the web view (a molecule with tens of thousands of atoms).
pub const MAX_REQUEST_BYTES: usize = 64 * 1024 * 1024;
/// Lines from the sidecar larger than this are dropped rather than forwarded.
const MAX_RESPONSE_BYTES: usize = 256 * 1024 * 1024;

/// Every method the sidecar registers. Anything else is rejected before it reaches Python.
/// Kept in sync with compute/mfcompute/handlers.py by tests/integration/test_shell_allowlist.py.
pub const ALLOWED_METHODS: &[&str] = &[
    "ai.cancel",
    "ai.configure",
    "ai.query",
    "ai.status",
    "chem.convertFormat",
    "chem.descriptors",
    "chem.layout2d",
    "chem.relax",
    "chem.repairGeometry",
    "chem.sanitize",
    "chem.validateBonds",
    "chem.wedges",
    "elements.all",
    "elements.get",
    "job.cancel",
    "library.categories",
    "library.delete",
    "library.export",
    "library.favorite",
    "library.import",
    "library.list",
    "library.load",
    "library.save",
    "report.export",
    "sim.dock",
    "sim.md",
    "sim.minimize",
    "sim.properties",
    "system.capabilities",
    "system.ping",
];

#[derive(Default)]
pub struct SidecarState {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
}

struct Launch {
    program: PathBuf,
    args: Vec<String>,
    cwd: PathBuf,
    resource_root: PathBuf,
}

/// Development builds run the Python package from the checkout's virtualenv; packaged builds run
/// the frozen sidecar shipped in the resource directory.
fn locate(app: &AppHandle) -> Result<Launch, String> {
    if cfg!(debug_assertions) {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..");
        let repo = repo.canonicalize().map_err(|e| format!("checkout not found: {e}"))?;
        let python = if cfg!(windows) {
            repo.join("compute").join(".venv").join("Scripts").join("python.exe")
        } else {
            repo.join("compute").join(".venv").join("bin").join("python")
        };
        if python.exists() {
            return Ok(Launch {
                program: python,
                args: vec!["-m".into(), "mfcompute.server".into()],
                cwd: repo.join("compute"),
                resource_root: repo,
            });
        }
    }
    let resources = app.path().resource_dir().map_err(|e| format!("resource directory unavailable: {e}"))?;
    let exe = if cfg!(windows) { "moleculeforge-compute.exe" } else { "moleculeforge-compute" };
    let program = resources.join("compute").join(exe);
    if !program.exists() {
        return Err(format!("compute engine missing at {}", program.display()));
    }
    Ok(Launch { program, args: vec![], cwd: resources.join("compute"), resource_root: resources })
}

pub fn spawn(app: &AppHandle, state: &SidecarState) -> Result<(), String> {
    let launch = locate(app)?;
    let data_dir = app.path().app_data_dir().map_err(|e| format!("data directory unavailable: {e}"))?;
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("cannot create {}: {e}", data_dir.display()))?;
    let log_dir = app.path().app_log_dir().unwrap_or_else(|_| data_dir.join("logs"));
    let _ = std::fs::create_dir_all(&log_dir);

    let mut command = Command::new(&launch.program);
    command
        .args(&launch.args)
        .current_dir(&launch.cwd)
        .env("MF_RESOURCE_DIR", &launch.resource_root)
        .env("MF_DATA_DIR", &data_dir)
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .env_remove("PYTHONPATH")
        .env_remove("PYTHONHOME")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|e| format!("cannot start {}: {e}", launch.program.display()))?;
    let stdout = child.stdout.take().ok_or("sidecar stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("sidecar stderr unavailable")?;
    *state.stdin.lock().map_err(|_| "sidecar lock poisoned")? = child.stdin.take();
    *state.child.lock().map_err(|_| "sidecar lock poisoned")? = Some(child);

    // stderr → log file (the sidecar logs there; nothing on stderr is protocol).
    let log_path = log_dir.join("compute.log");
    thread::spawn(move || {
        let mut sink = File::create(&log_path).ok();
        let mut reader = BufReader::new(stderr);
        let mut line = Vec::new();
        while reader.read_until(b'\n', &mut line).map(|n| n > 0).unwrap_or(false) {
            if let Some(file) = sink.as_mut() {
                let _ = file.write_all(&line);
            }
            if cfg!(debug_assertions) {
                eprint!("[compute] {}", String::from_utf8_lossy(&line));
            }
            line.clear();
        }
    });

    // stdout → web view, one event per protocol line.
    let handle = app.clone();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = Vec::new();
        loop {
            line.clear();
            match (&mut reader).take(MAX_RESPONSE_BYTES as u64 + 1).read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            if line.len() > MAX_RESPONSE_BYTES {
                // Skip the rest of an oversized line.
                let mut rest = Vec::new();
                let _ = reader.read_until(b'\n', &mut rest);
                continue;
            }
            let text = String::from_utf8_lossy(&line);
            let text = text.trim_end_matches(['\r', '\n']);
            if !text.is_empty() {
                let _ = handle.emit_to("main", "sidecar://message", text.to_string());
            }
        }
        let code = handle
            .state::<SidecarState>()
            .child
            .lock()
            .ok()
            .and_then(|mut guard| guard.as_mut().and_then(|c| c.wait().ok()))
            .and_then(|status| status.code());
        let note = serde_json::json!({"jsonrpc": "2.0", "method": "sidecar.exit", "params": {"code": code}});
        let _ = handle.emit_to("main", "sidecar://message", note.to_string());
    });
    Ok(())
}

/// Shape and allowlist checks for one request line from the web view.
pub fn validate_request(line: &str) -> Result<(), String> {
    if line.len() > MAX_REQUEST_BYTES {
        return Err("request too large".into());
    }
    if line.contains('\n') || line.contains('\r') {
        return Err("request must be a single line".into());
    }
    let value: Value = serde_json::from_str(line).map_err(|e| format!("request is not JSON: {e}"))?;
    let object = value.as_object().ok_or("request must be a JSON object")?;
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err("jsonrpc must be \"2.0\"".into());
    }
    let method = object.get("method").and_then(Value::as_str).ok_or("method missing")?;
    if !ALLOWED_METHODS.contains(&method) {
        return Err(format!("method not allowed: {method}"));
    }
    match object.get("id") {
        None | Some(Value::String(_)) | Some(Value::Number(_)) => {}
        Some(_) => return Err("id must be a string or number".into()),
    }
    match object.get("params") {
        None | Some(Value::Object(_)) => {}
        Some(_) => return Err("params must be an object".into()),
    }
    if object.keys().any(|k| !matches!(k.as_str(), "jsonrpc" | "method" | "id" | "params")) {
        return Err("unexpected request field".into());
    }
    Ok(())
}

pub fn send(state: &SidecarState, line: &str) -> Result<(), String> {
    let mut guard = state.stdin.lock().map_err(|_| "sidecar lock poisoned")?;
    let stdin = guard.as_mut().ok_or("compute engine is not running")?;
    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("compute engine unavailable: {e}"))
}

/// Ask the sidecar to stop, then make sure it has (it also exits when stdin closes).
pub fn shutdown(state: &SidecarState) {
    if let Ok(mut guard) = state.stdin.lock() {
        if let Some(stdin) = guard.as_mut() {
            let _ = stdin.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":\"shell-shutdown\",\"method\":\"system.shutdown\",\"params\":{}}\n");
            let _ = stdin.flush();
        }
        guard.take(); // closing stdin is the second, unconditional stop signal
    }
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        let finished = match state.child.lock() {
            Ok(mut guard) => match guard.as_mut() {
                Some(child) => child.try_wait().map(|s| s.is_some()).unwrap_or(true),
                None => true,
            },
            Err(_) => true,
        };
        if finished {
            return;
        }
        if Instant::now() >= deadline {
            if let Ok(mut guard) = state.child.lock() {
                if let Some(child) = guard.as_mut() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(test)]
mod tests {
    use super::validate_request;

    #[test]
    fn accepts_allowed_methods() {
        assert!(validate_request(r#"{"jsonrpc":"2.0","id":"a","method":"system.ping","params":{}}"#).is_ok());
    }

    #[test]
    fn rejects_unknown_methods_and_bad_shapes() {
        assert!(validate_request(r#"{"jsonrpc":"2.0","id":1,"method":"system.shutdown","params":{}}"#).is_err());
        assert!(validate_request(r#"{"jsonrpc":"2.0","id":1,"method":"os.exec","params":{}}"#).is_err());
        assert!(validate_request(r#"{"jsonrpc":"1.0","id":1,"method":"system.ping"}"#).is_err());
        assert!(validate_request(r#"{"jsonrpc":"2.0","id":{},"method":"system.ping"}"#).is_err());
        assert!(validate_request(r#"{"jsonrpc":"2.0","id":1,"method":"system.ping","params":[1]}"#).is_err());
        assert!(validate_request(r#"{"jsonrpc":"2.0","id":1,"method":"system.ping","extra":true}"#).is_err());
        assert!(validate_request("[1,2]").is_err());
        assert!(validate_request("{\"jsonrpc\":\"2.0\",\n\"method\":\"system.ping\"}").is_err());
    }
}
