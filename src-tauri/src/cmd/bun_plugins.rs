use super::{CmdResult, StringifyErr as _};

#[tauri::command]
#[specta::specta]
pub async fn list_bun_plugins() -> CmdResult<crate::ipc::JsonValue> {
    let value = crate::bun_plugins::list().await.stringify_err()?;
    serde_json::from_value(value).stringify_err()
}

#[tauri::command]
#[specta::specta]
pub async fn set_bun_plugin_enabled(id: String, enabled: bool) -> CmdResult<()> {
    crate::bun_plugins::set_enabled(&id, enabled).await.stringify_err()
}

#[tauri::command]
#[specta::specta]
pub async fn install_bun_plugin(directory: String) -> CmdResult<()> {
    crate::bun_plugins::install(directory).await.stringify_err()
}

#[tauri::command]
#[specta::specta]
pub async fn remove_bun_plugin(id: String) -> CmdResult<()> {
    crate::bun_plugins::remove(&id).await.stringify_err()
}

#[tauri::command]
#[specta::specta]
pub async fn bun_plugin_command(id: String, command: String) -> CmdResult<()> {
    crate::bun_plugins::command(&id, &command).await.stringify_err()
}
