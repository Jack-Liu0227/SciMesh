//! Thin desktop commands for the shared scientific services.
use osd_core::{journal, structure_file};
use serde::Deserialize;
use tauri::AppHandle;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StructureRead {
    path: String,
    root: Option<String>,
    directory: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StructureSave {
    path: String,
    root: Option<String>,
    directory: Option<String>,
    content: String,
    expected_hash: String,
    operation_id: String,
}

fn invalid_path(message: String) -> structure_file::Error {
    structure_file::Error {
        code: structure_file::ErrorCode::InvalidPath,
        message,
    }
}

#[tauri::command(async)]
pub fn structure_read(
    app: AppHandle,
    request: StructureRead,
) -> Result<structure_file::ReadResult, structure_file::Error> {
    let root = structure_file::workspace_root(
        &crate::env_of(&app),
        request.root.as_deref(),
        request.directory.as_deref(),
    )
    .map_err(invalid_path)?;
    structure_file::read(&root, &request.path)
}

#[tauri::command(async)]
pub fn structure_save(
    app: AppHandle,
    request: StructureSave,
) -> Result<structure_file::SaveResult, structure_file::Error> {
    let root = structure_file::workspace_root(
        &crate::env_of(&app),
        request.root.as_deref(),
        request.directory.as_deref(),
    )
    .map_err(invalid_path)?;
    structure_file::save(
        &root,
        structure_file::SaveRequest {
            path: request.path,
            content: request.content,
            expected_hash: request.expected_hash,
            operation_id: request.operation_id,
        },
    )
}

#[tauri::command(async)]
pub fn journal_status(app: AppHandle) -> Result<journal::JournalStatus, journal::JournalError> {
    journal::status(&crate::env_of(&app))
}

#[tauri::command(async)]
pub fn set_journal_key(
    app: AppHandle,
    key: String,
) -> Result<journal::JournalStatus, journal::JournalError> {
    journal::save_key(&crate::env_of(&app), &key)
}

#[tauri::command(async)]
pub fn delete_journal_key(app: AppHandle) -> Result<journal::JournalStatus, journal::JournalError> {
    journal::delete_key(&crate::env_of(&app))
}

#[tauri::command(async)]
pub fn journal_lookup(
    app: AppHandle,
    query: String,
) -> Result<journal::JournalInfo, journal::JournalError> {
    journal::lookup(&crate::env_of(&app), &query)
}
