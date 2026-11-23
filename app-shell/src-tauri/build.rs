fn main() {
    // App commands get generated permissions (allow-rpc-send, ...) so the capability file can
    // grant exactly these and nothing else.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["rpc_send", "open_text_file", "save_file"])),
    )
    .expect("failed to run tauri-build");
}
