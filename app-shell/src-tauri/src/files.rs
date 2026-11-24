//! File access for the web view, always mediated by a native dialog the user answers.
//!
//! The web view never receives a path or general filesystem access: it gets back the text of the
//! one file the user picked (opened files are treated as untrusted input and size-limited before
//! the sidecar parses them defensively), or a yes/no for a save the user confirmed.

use std::io::Read;
use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::{DialogExt, FilePath};

/// Molecule files larger than this are refused (the largest supported structures are far smaller).
pub const MAX_OPEN_BYTES: u64 = 64 * 1024 * 1024;
/// Exports larger than this are refused.
pub const MAX_SAVE_BYTES: usize = 256 * 1024 * 1024;

#[derive(Debug, Deserialize)]
pub struct Filter {
    name: String,
    extensions: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct OpenedFile {
    name: String,
    text: String,
}

fn clean_extensions(filter: &Filter) -> Vec<String> {
    filter
        .extensions
        .iter()
        .filter(|e| !e.is_empty() && e.len() <= 12 && e.chars().all(|c| c.is_ascii_alphanumeric()))
        .cloned()
        .collect()
}

fn into_path(picked: FilePath) -> Result<std::path::PathBuf, String> {
    picked.into_path().map_err(|e| format!("unsupported location: {e}"))
}

/// A bare file name: no directories, no control characters, sensible length.
pub fn safe_file_name(name: &str) -> String {
    let base = Path::new(name).file_name().and_then(|n| n.to_str()).unwrap_or("molecule");
    let cleaned: String = base.chars().filter(|c| !c.is_control() && !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')).take(120).collect();
    if cleaned.trim().is_empty() || cleaned.starts_with('.') {
        "molecule".to_string()
    } else {
        cleaned
    }
}

#[tauri::command]
pub async fn open_text_file(app: AppHandle, filters: Vec<Filter>) -> Result<Option<OpenedFile>, String> {
    let mut dialog = app.dialog().file();
    for filter in filters.iter().take(16) {
        let extensions = clean_extensions(filter);
        if !extensions.is_empty() {
            let refs: Vec<&str> = extensions.iter().map(String::as_str).collect();
            dialog = dialog.add_filter(&filter.name, &refs);
        }
    }
    let Some(picked) = dialog.blocking_pick_file() else { return Ok(None) };
    let path = into_path(picked)?;
    let size = std::fs::metadata(&path).map_err(|e| format!("cannot read file: {e}"))?.len();
    if size > MAX_OPEN_BYTES {
        return Err(format!("the file is {} MB; the limit is {} MB", size / 1_048_576, MAX_OPEN_BYTES / 1_048_576));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("cannot read file: {e}"))?;
    let text = String::from_utf8(bytes).map_err(|_| "the file is not a text molecule file (not UTF-8)".to_string())?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("molecule").to_string();
    Ok(Some(OpenedFile { name, text }))
}

#[tauri::command]
pub async fn save_file(app: AppHandle, default_name: String, bytes: Vec<u8>, filters: Vec<Filter>) -> Result<bool, String> {
    if bytes.len() > MAX_SAVE_BYTES {
        return Err("export too large".into());
    }
    let mut dialog = app.dialog().file().set_file_name(safe_file_name(&default_name));
    for filter in filters.iter().take(16) {
        let extensions = clean_extensions(filter);
        if !extensions.is_empty() {
            let refs: Vec<&str> = extensions.iter().map(String::as_str).collect();
            dialog = dialog.add_filter(&filter.name, &refs);
        }
    }
    let Some(picked) = dialog.blocking_save_file() else { return Ok(false) };
    let path = into_path(picked)?;
    std::fs::write(&path, &bytes).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    Ok(true)
}

/// The language-model file the user last picked in the native dialog. `ai.configure` may only
/// name this exact path, so the web view cannot point the model runtime at any other file.
#[derive(Default)]
pub struct PickedModel(pub Mutex<Option<String>>);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelChoice {
    name: String,
    path: String,
    size_bytes: u64,
}

/// True when the file starts with the GGUF magic number.
pub fn is_gguf(path: &Path) -> bool {
    let mut magic = [0u8; 4];
    std::fs::File::open(path).and_then(|mut f| f.read_exact(&mut magic)).is_ok() && &magic == b"GGUF"
}

#[tauri::command]
pub async fn choose_model(app: AppHandle, picked: State<'_, PickedModel>) -> Result<Option<ModelChoice>, String> {
    let dialog = app.dialog().file().add_filter("GGUF language model", &["gguf"]);
    let Some(file) = dialog.blocking_pick_file() else { return Ok(None) };
    let path = into_path(file)?;
    let path = path.canonicalize().map_err(|e| format!("cannot read the model: {e}"))?;
    let meta = std::fs::metadata(&path).map_err(|e| format!("cannot read the model: {e}"))?;
    let gguf_extension = path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("gguf"));
    if !meta.is_file() || !gguf_extension || !is_gguf(&path) {
        return Err("the file is not a GGUF language model".into());
    }
    let path_text = path.to_str().ok_or("the model path is not valid Unicode")?.to_string();
    *picked.0.lock().map_err(|_| "model state poisoned")? = Some(path_text.clone());
    let name = path.file_stem().and_then(|n| n.to_str()).unwrap_or("model").to_string();
    Ok(Some(ModelChoice { name, path: path_text, size_bytes: meta.len() }))
}

#[cfg(test)]
mod tests {
    use super::safe_file_name;

    #[test]
    fn file_names_are_reduced_to_a_bare_name() {
        assert_eq!(safe_file_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_file_name("aspirin-report.pdf"), "aspirin-report.pdf");
        assert_eq!(safe_file_name(".hidden"), "molecule");
        assert_eq!(safe_file_name(""), "molecule");
        assert_eq!(safe_file_name("a<b>c?.sdf"), "abc.sdf");
    }
}
