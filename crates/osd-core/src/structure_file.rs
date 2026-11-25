//! Workspace-owned structure edits. Callers must resolve an authorized owner
//! workspace first; neither disk/home scopes nor directory selection belong here.
//!
//! The ledger lock serializes cooperating processes, not external editors.
//! Hash checks detect observed changes; they are not a filesystem CAS against
//! writers that ignore that lock. Parent directories must not be concurrently
//! replaced by an untrusted process while an operation is in progress.
use std::fs::{self, File, Metadata};
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::ledger::{lock_ledger, LedgerGuard};
use crate::provenance::{append_record_locked, versions_for};
use crate::runtime::write_atomic;

pub const MAX_CONTENT_BYTES: usize = 5 * 1024 * 1024;
const EDITS: &str = ".openscience/structure-edits";
const PENDING: &str = ".openscience/structure-edits/pending";
const COMPLETED: &str = ".openscience/structure-edits/completed";

/// Resolve the same explicit owner on desktop and gateway, never an arbitrary disk scope.
pub fn workspace_root(
    env: &crate::Env,
    root: Option<&str>,
    directory: Option<&str>,
) -> Result<PathBuf, String> {
    if !matches!(root, None | Some("workspace") | Some("base")) {
        return Err("structure files require a workspace or base root".into());
    }
    if let Some(directory) = directory.filter(|d| !d.is_empty()) {
        let candidate = Path::new(directory)
            .canonicalize()
            .map_err(|_| "workspace directory not found")?;
        let base = crate::runtime::base_workspace_dir(env)?
            .canonicalize()
            .map_err(|e| e.to_string())?;
        let active = crate::runtime::workspace_dir(env)?
            .canonicalize()
            .map_err(|e| e.to_string())?;
        if candidate.starts_with(base)
            || candidate == active
            || crate::project::is_registered_project_path(env, &candidate)
        {
            return Ok(candidate);
        }
        return Err("directory is outside registered workspaces".into());
    }
    crate::artifact_file::scope_root(env, root)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidPath,
    UnsupportedFormat,
    InvalidContent,
    InvalidRequest,
    TooLarge,
    NotFound,
    Conflict,
    RecoveryRequired,
    Io,
}

#[derive(Debug, Serialize)]
pub struct Error {
    pub code: ErrorCode,
    pub message: String,
}

impl Error {
    pub fn status_code(&self) -> u16 {
        match self.code {
            ErrorCode::Conflict => 409,
            ErrorCode::NotFound => 404,
            ErrorCode::TooLarge => 413,
            ErrorCode::InvalidPath | ErrorCode::UnsupportedFormat | ErrorCode::InvalidRequest => {
                400
            }
            ErrorCode::InvalidContent => 422,
            ErrorCode::RecoveryRequired => 503,
            ErrorCode::Io => 500,
        }
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Error {}

fn error(code: ErrorCode, message: impl Into<String>) -> Error {
    Error {
        code,
        message: message.into(),
    }
}

fn io(e: std::io::Error) -> Error {
    error(
        if e.kind() == std::io::ErrorKind::NotFound {
            ErrorCode::NotFound
        } else {
            ErrorCode::Io
        },
        e.to_string(),
    )
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadResult {
    pub content: String,
    pub hash: String,
    /// Normalized identity relative to the supplied owner workspace.
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveRequest {
    pub path: String,
    pub content: String,
    pub expected_hash: String,
    pub operation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub hash: String,
    pub version: u32,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Edit {
    schema: u8,
    path: String,
    expected_hash: String,
    hash: String,
    operation_id: String,
}

#[derive(Serialize, Deserialize)]
struct PendingEdit {
    #[serde(flatten)]
    edit: Edit,
    content: String,
}

#[derive(Serialize, Deserialize)]
struct CompletedEdit {
    #[serde(flatten)]
    edit: Edit,
    version: u32,
}

fn hash(content: &str) -> String {
    format!("{:x}", Sha256::digest(content.as_bytes()))
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn valid_operation_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
        && value.bytes().any(|b| b.is_ascii_hexdigit())
}

fn normalize_path(rel: &str) -> Result<String, Error> {
    let normalized = rel.replace('\\', "/");
    if normalized.is_empty() || normalized.len() > 4096 {
        return Err(error(
            ErrorCode::InvalidPath,
            "expected a workspace-relative structure path",
        ));
    }
    for part in normalized.split('/') {
        let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with(['.', ' '])
            || part
                .chars()
                .any(|c| c.is_control() || "<>:\"|?*".contains(c))
            || matches!(part.to_ascii_lowercase().as_str(), ".git" | ".openscience")
            || matches!(
                stem.as_str(),
                "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
            )
            || (stem.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        {
            return Err(error(
                ErrorCode::InvalidPath,
                "path must contain only plain workspace-relative components",
            ));
        }
    }
    format_for(&normalized)?;
    Ok(normalized)
}

#[derive(Clone, Copy)]
enum Format {
    Cif,
    Vasp,
}

fn format_for(rel: &str) -> Result<Format, Error> {
    let path = Path::new(rel);
    if matches!(
        path.file_name().and_then(|n| n.to_str()),
        Some("POSCAR" | "CONTCAR")
    ) {
        return Ok(Format::Vasp);
    }
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "cif" | "mcif" => Ok(Format::Cif),
        "vasp" => Ok(Format::Vasp),
        _ => Err(error(
            ErrorCode::UnsupportedFormat,
            "only CIF, MCIF, VASP, POSCAR and CONTCAR files are editable",
        )),
    }
}

fn linked(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_type().is_symlink() || metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn owner_root(root: &Path) -> Result<PathBuf, Error> {
    if !root.is_absolute() || linked(&fs::symlink_metadata(root).map_err(io)?) {
        return Err(error(
            ErrorCode::InvalidPath,
            "an authorized, non-linked owner workspace is required",
        ));
    }
    let root = root.canonicalize().map_err(io)?;
    if !root.is_dir() {
        return Err(error(
            ErrorCode::InvalidPath,
            "owner workspace must be a directory",
        ));
    }
    Ok(root)
}

/// Check every component, including existing targets and internal state paths.
/// Only a missing final component is permitted when creating internal files.
fn checked_path(root: &Path, rel: &str, missing: bool) -> Result<PathBuf, Error> {
    let mut full = root.to_path_buf();
    let mut parts = rel.split('/').peekable();
    while let Some(part) = parts.next() {
        full.push(part);
        let metadata = match fs::symlink_metadata(&full) {
            Ok(metadata) => metadata,
            Err(e)
                if missing
                    && parts.peek().is_none()
                    && e.kind() == std::io::ErrorKind::NotFound =>
            {
                return Ok(full)
            }
            Err(e) => return Err(io(e)),
        };
        if linked(&metadata) || !full.canonicalize().map_err(io)?.starts_with(root) {
            return Err(error(
                ErrorCode::InvalidPath,
                "linked paths and paths outside the owner workspace are forbidden",
            ));
        }
        if parts.peek().is_some() && !metadata.is_dir() {
            return Err(error(
                ErrorCode::InvalidPath,
                "a parent path is not a directory",
            ));
        }
    }
    Ok(full)
}

fn regular_path(root: &Path, rel: &str, missing: bool) -> Result<PathBuf, Error> {
    let full = checked_path(root, rel, missing)?;
    match fs::symlink_metadata(&full) {
        Ok(m) if m.is_file() && !linked(&m) => Ok(full),
        Err(e) if missing && e.kind() == std::io::ErrorKind::NotFound => Ok(full),
        Err(e) => Err(io(e)),
        _ => Err(error(ErrorCode::InvalidPath, "expected a regular file")),
    }
}

fn ensure_dir(root: &Path, rel: &str) -> Result<(), Error> {
    let mut current = String::new();
    for part in rel.split('/') {
        if !current.is_empty() {
            current.push('/');
        }
        current.push_str(part);
        let full = checked_path(root, &current, true)?;
        match fs::create_dir(&full) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(io(e)),
        }
        if !checked_path(root, &current, false)?.is_dir() {
            return Err(error(
                ErrorCode::InvalidPath,
                "edit state parent must be a directory",
            ));
        }
    }
    Ok(())
}

fn bounded_text(path: &Path, limit: usize) -> Result<String, Error> {
    let file = File::open(path).map_err(io)?;
    let metadata = file.metadata().map_err(io)?;
    if !metadata.is_file() || linked(&metadata) {
        return Err(error(
            ErrorCode::InvalidPath,
            "expected a regular text file",
        ));
    }
    if metadata.len() > limit as u64 {
        return Err(error(
            ErrorCode::TooLarge,
            "structure file exceeds the size limit",
        ));
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(io)?;
    if bytes.len() > limit {
        return Err(error(
            ErrorCode::TooLarge,
            "structure file exceeds the size limit",
        ));
    }
    String::from_utf8(bytes).map_err(|_| {
        error(
            ErrorCode::InvalidContent,
            "structure file must be UTF-8 text",
        )
    })
}

fn validate_content(rel: &str, content: &str) -> Result<(), Error> {
    if content.len() > MAX_CONTENT_BYTES {
        return Err(error(ErrorCode::TooLarge, "structure file exceeds 5 MiB"));
    }
    if content
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err(error(
            ErrorCode::InvalidContent,
            "structure file contains binary/control characters",
        ));
    }
    let content = content.trim_start_matches('\u{feff}');
    let invalid = || {
        error(
            ErrorCode::InvalidContent,
            "content does not have a supported structure header and coordinate layout",
        )
    };
    if content.trim_start().starts_with("#!") {
        return Err(invalid());
    }
    match format_for(rel)? {
        Format::Cif => {
            let mut data = false;
            let mut cell = [false; 6];
            let mut fractional = [false; 3];
            let mut cartesian = [false; 3];
            let tags = [
                "_cell_length_a",
                "_cell_length_b",
                "_cell_length_c",
                "_cell_angle_alpha",
                "_cell_angle_beta",
                "_cell_angle_gamma",
            ];
            for line in content.lines() {
                let line = line.trim();
                let token = line
                    .split_whitespace()
                    .next()
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if token.is_empty() || token.starts_with('#') {
                    continue;
                }
                if !data && !(token.starts_with("data_") && token.len() > 5) {
                    return Err(invalid());
                }
                if token.starts_with("data_") && token.len() > 5 {
                    data = true;
                }
                for (i, tag) in tags.iter().enumerate() {
                    if token == *tag {
                        cell[i] = true;
                    }
                }
                match token.as_str() {
                    "_atom_site_fract_x" => fractional[0] = true,
                    "_atom_site_fract_y" => fractional[1] = true,
                    "_atom_site_fract_z" => fractional[2] = true,
                    "_atom_site_cartn_x" => cartesian[0] = true,
                    "_atom_site_cartn_y" => cartesian[1] = true,
                    "_atom_site_cartn_z" => cartesian[2] = true,
                    _ => {}
                }
            }
            if !data
                || !cell.iter().all(|v| *v)
                || !(fractional.iter().all(|v| *v) || cartesian.iter().all(|v| *v))
            {
                return Err(invalid());
            }
        }
        Format::Vasp => {
            let mut lines = content.lines();
            lines
                .next()
                .filter(|l| !l.trim().is_empty())
                .ok_or_else(invalid)?;
            let scale = lines
                .next()
                .ok_or_else(invalid)?
                .split_whitespace()
                .collect::<Vec<_>>();
            if !matches!(scale.len(), 1 | 3)
                || !scale
                    .iter()
                    .all(|s| s.parse::<f64>().is_ok_and(|v| v.is_finite() && v != 0.0))
            {
                return Err(invalid());
            }
            for _ in 0..3 {
                vector(lines.next().ok_or_else(invalid)?).ok_or_else(invalid)?;
            }
            let mut counts = lines.next().ok_or_else(invalid)?;
            if !counts
                .split_whitespace()
                .all(|v| v.parse::<usize>().is_ok())
            {
                counts = lines.next().ok_or_else(invalid)?;
            }
            let counts = counts
                .split_whitespace()
                .map(str::parse::<usize>)
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| invalid())?;
            let atoms = counts
                .iter()
                .try_fold(0usize, |a, b| a.checked_add(*b))
                .ok_or_else(invalid)?;
            if counts.is_empty() || atoms == 0 || atoms > MAX_CONTENT_BYTES / 5 {
                return Err(invalid());
            }
            let mut mode = lines.next().ok_or_else(invalid)?.trim();
            if mode.starts_with(['s', 'S']) {
                mode = lines.next().ok_or_else(invalid)?.trim();
            }
            if !mode.starts_with(['d', 'D', 'c', 'C', 'k', 'K']) {
                return Err(invalid());
            }
            for _ in 0..atoms {
                vector(lines.next().ok_or_else(invalid)?).ok_or_else(invalid)?;
            }
        }
    }
    Ok(())
}

fn vector(line: &str) -> Option<()> {
    let mut values = line.split_whitespace();
    for _ in 0..3 {
        if !values.next()?.parse::<f64>().ok()?.is_finite() {
            return None;
        }
    }
    Some(())
}

pub fn read(root: &Path, rel: &str) -> Result<ReadResult, Error> {
    let root = owner_root(root)?;
    let path = normalize_path(rel)?;
    let content = bounded_text(&regular_path(&root, &path, false)?, MAX_CONTENT_BYTES)?;
    // Reading unsupported structure syntax must still allow a source or
    // molecular preview. Scientific edit validation belongs at save time.
    Ok(ReadResult {
        hash: hash(&content),
        content,
        path,
    })
}

fn edit_file(dir: &str, id: &str) -> String {
    format!("{dir}/{id}.json")
}

fn write_json(root: &Path, rel: &str, value: &impl Serialize) -> Result<(), Error> {
    let full = regular_path(root, rel, true)?;
    let text = serde_json::to_string(value).map_err(|e| error(ErrorCode::Io, e.to_string()))?;
    write_atomic(&full, &text).map_err(|e| error(ErrorCode::Io, e))
}

fn load_json<T: serde::de::DeserializeOwned>(root: &Path, rel: &str) -> Result<Option<T>, Error> {
    let full = regular_path(root, rel, true)?;
    match bounded_text(&full, MAX_CONTENT_BYTES * 6 + 4096) {
        Ok(text) => serde_json::from_str(&text).map(Some).map_err(|_| {
            error(
                ErrorCode::RecoveryRequired,
                "invalid structure edit manifest",
            )
        }),
        Err(e) if e.code == ErrorCode::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn check_ledger(root: &Path) -> Result<(), Error> {
    regular_path(root, ".openscience/ledger.lock", true)?;
    regular_path(root, ".openscience/provenance.jsonl", true)?;
    Ok(())
}

fn validate_edit(edit: &Edit) -> Result<(), Error> {
    if edit.schema != 1
        || !valid_operation_id(&edit.operation_id)
        || !valid_hash(&edit.expected_hash)
        || !valid_hash(&edit.hash)
        || !normalize_path(&edit.path).is_ok_and(|path| path == edit.path)
    {
        return Err(error(
            ErrorCode::RecoveryRequired,
            "invalid structure edit identity",
        ));
    }
    Ok(())
}

fn complete(root: &Path, pending: PendingEdit, version: u32) -> Result<SaveResult, Error> {
    let result = SaveResult {
        hash: pending.edit.hash.clone(),
        version,
    };
    let pending_path = edit_file(PENDING, &pending.edit.operation_id);
    write_json(
        root,
        &edit_file(COMPLETED, &pending.edit.operation_id),
        &CompletedEdit {
            edit: pending.edit,
            version,
        },
    )?;
    fs::remove_file(regular_path(root, &pending_path, false)?).map_err(io)?;
    Ok(result)
}

fn edit_log(edit: &Edit) -> String {
    format!(
        "Structure edit {}; SHA-256 {} -> {}",
        edit.operation_id, edit.expected_hash, edit.hash
    )
}

fn sync_provenance(root: &Path) -> Result<(), Error> {
    // Persist the ledger before retiring the recovery manifest. The shared
    // append API intentionally leaves durability policy to its caller.
    File::options()
        .write(true)
        .open(regular_path(root, ".openscience/provenance.jsonl", false)?)
        .map_err(io)?
        .sync_all()
        .map_err(io)
}

fn record_pending(
    root: &Path,
    guard: &LedgerGuard,
    pending: PendingEdit,
) -> Result<SaveResult, Error> {
    check_ledger(root)?;
    let record = append_record_locked(
        guard,
        root,
        &pending.edit.path,
        "structure_save",
        None,
        None,
        Some(pending.content.clone()),
        None,
        Some(edit_log(&pending.edit)),
        None,
        None,
        Some(format!("structure-edit:{}", pending.edit.operation_id)),
    )
    .map_err(|e| error(ErrorCode::Io, e))?;
    sync_provenance(root)?;
    complete(root, pending, record.version)
}

fn recover(root: &Path, guard: &LedgerGuard, pending: PendingEdit) -> Result<SaveResult, Error> {
    validate_edit(&pending.edit)?;
    validate_content(&pending.edit.path, &pending.content)?;
    if hash(&pending.content) != pending.edit.hash {
        return Err(error(
            ErrorCode::RecoveryRequired,
            "structure edit manifest content hash mismatch",
        ));
    }
    check_ledger(root)?;
    let call_id = format!("structure-edit:{}", pending.edit.operation_id);
    if let Some(record) = versions_for(root, &pending.edit.path)
        .map_err(|e| error(ErrorCode::Io, e))?
        .into_iter()
        .find(|record| record.call_id.as_deref() == Some(&call_id))
    {
        if record.tool != "structure_save"
            || record.log.as_deref() != Some(edit_log(&pending.edit).as_str())
        {
            return Err(error(
                ErrorCode::RecoveryRequired,
                "operationId conflicts with an unrelated provenance record",
            ));
        }
        sync_provenance(root)?;
        return complete(root, pending, record.version);
    }
    let current = read(root, &pending.edit.path)?;
    if current.hash == pending.edit.expected_hash {
        let full = regular_path(root, &pending.edit.path, false)?;
        write_atomic(&full, &pending.content).map_err(|e| error(ErrorCode::Io, e))?;
        crate::git_snapshot::request_snapshot(root);
    } else if current.hash != pending.edit.hash {
        return Err(error(ErrorCode::RecoveryRequired, "a pending structure edit conflicts with the current file; preserve the manifest for recovery"));
    }
    // A receipt is returned only after provenance was recorded. A failed append
    // leaves the complete pending content available to the next identical retry.
    record_pending(root, guard, pending)
}

/// Save an existing structure file, preserving a recoverable manifest before
/// replacement. Reuse an operation ID only for an identical request. Successful
/// retries return the original version even after subsequent edits.
pub fn save(root: &Path, request: SaveRequest) -> Result<SaveResult, Error> {
    let root = owner_root(root)?;
    let path = normalize_path(&request.path)?;
    if !valid_hash(&request.expected_hash) || !valid_operation_id(&request.operation_id) {
        return Err(error(ErrorCode::InvalidRequest, "expectedHash must be lowercase SHA-256 and operationId must contain 1-128 hex/hyphen characters"));
    }
    validate_content(&path, &request.content)?;
    // Validate the target before creating internal state or taking the lock.
    regular_path(&root, &path, false)?;
    ensure_dir(&root, ".openscience")?;
    check_ledger(&root)?;
    let guard = lock_ledger(&root).map_err(|e| error(ErrorCode::Io, e))?;
    ensure_dir(&root, EDITS)?;
    ensure_dir(&root, PENDING)?;
    ensure_dir(&root, COMPLETED)?;
    check_ledger(&root)?;
    let edit = Edit {
        schema: 1,
        path,
        expected_hash: request.expected_hash,
        hash: hash(&request.content),
        operation_id: request.operation_id,
    };
    if let Some(done) =
        load_json::<CompletedEdit>(&root, &edit_file(COMPLETED, &edit.operation_id))?
    {
        validate_edit(&done.edit)?;
        if done.version == 0 {
            return Err(error(
                ErrorCode::RecoveryRequired,
                "invalid structure edit version",
            ));
        }
        if done.edit != edit {
            return Err(error(
                ErrorCode::Conflict,
                "operationId was already used for a different request",
            ));
        }
        return Ok(SaveResult {
            hash: done.edit.hash,
            version: done.version,
        });
    }
    if let Some(pending) = load_json::<PendingEdit>(&root, &edit_file(PENDING, &edit.operation_id))?
    {
        if pending.edit != edit || pending.content != request.content {
            return Err(error(
                ErrorCode::Conflict,
                "operationId was already used for a different request",
            ));
        }
        return recover(&root, &guard, pending).map_err(recovery_error);
    }
    // Finish an earlier failed edit of this file before accepting a new one.
    // Completed receipts are small and live separately, so only pending work is scanned.
    for entry in fs::read_dir(checked_path(&root, PENDING, false)?).map_err(io)? {
        let entry = entry.map_err(io)?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| error(ErrorCode::RecoveryRequired, "invalid pending edit filename"))?;
        // A crash inside write_atomic can leave an unpublished temporary file.
        if name.starts_with('.') && name.ends_with(".tmp") {
            continue;
        }
        let id = name
            .strip_suffix(".json")
            .filter(|id| valid_operation_id(id))
            .ok_or_else(|| error(ErrorCode::RecoveryRequired, "invalid pending edit filename"))?;
        let pending = load_json::<PendingEdit>(&root, &edit_file(PENDING, id))?
            .ok_or_else(|| error(ErrorCode::RecoveryRequired, "pending edit disappeared"))?;
        if pending.edit.operation_id != id {
            return Err(error(
                ErrorCode::RecoveryRequired,
                "pending edit filename does not match its operationId",
            ));
        }
        validate_edit(&pending.edit)?;
        if pending.edit.path == edit.path {
            recover(&root, &guard, pending).map_err(recovery_error)?;
        }
    }
    let current = read(&root, &edit.path)?;
    if current.hash != edit.expected_hash {
        return Err(error(
            ErrorCode::Conflict,
            "structure file changed since it was read",
        ));
    }
    let pending = PendingEdit {
        edit,
        content: request.content,
    };
    write_json(
        &root,
        &edit_file(PENDING, &pending.edit.operation_id),
        &pending,
    )?;
    let result = recover(&root, &guard, pending).map_err(recovery_error)?;
    Ok(result)
}

fn recovery_error(e: Error) -> Error {
    error(
        ErrorCode::RecoveryRequired,
        format!("Structure edit is pending; retry the same operationId to recover: {e}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::test_support::{assert_exits_ok, spawn_test, wait_for_file};
    use std::sync::{Arc, Barrier};

    const CIF: &str = "data_Si\n_cell_length_a 5.43\n_cell_length_b 5.43\n_cell_length_c 5.43\n_cell_angle_alpha 90\n_cell_angle_beta 90\n_cell_angle_gamma 90\nloop_\n_atom_site_label\n_atom_site_fract_x\n_atom_site_fract_y\n_atom_site_fract_z\nSi1 0 0 0\n";
    const VASP: &str = "Si\n1.0\n5.43 0 0\n0 5.43 0\n0 0 5.43\nSi\n1\nDirect\n0 0 0\n";

    struct Fixture {
        base: PathBuf,
        root: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let base = std::env::temp_dir().join(format!(
                "osd-structure-{}-{}",
                std::process::id(),
                crate::runtime::random_hex(8)
            ));
            let root = base.join("owner");
            fs::create_dir_all(root.join("structures")).unwrap();
            fs::write(root.join("structures/Si.cif"), CIF).unwrap();
            Self {
                base,
                root: root.canonicalize().unwrap(),
            }
        }

        fn request(&self, id: &str, content: &str) -> SaveRequest {
            SaveRequest {
                path: "structures/Si.cif".into(),
                content: content.into(),
                expected_hash: read(&self.root, "structures/Si.cif").unwrap().hash,
                operation_id: id.into(),
            }
        }

        fn pending(&self, request: &SaveRequest) -> PendingEdit {
            ensure_dir(&self.root, PENDING).unwrap();
            ensure_dir(&self.root, COMPLETED).unwrap();
            let pending = PendingEdit {
                edit: Edit {
                    schema: 1,
                    path: request.path.clone(),
                    expected_hash: request.expected_hash.clone(),
                    hash: hash(&request.content),
                    operation_id: request.operation_id.clone(),
                },
                content: request.content.clone(),
            };
            write_json(
                &self.root,
                &edit_file(PENDING, &request.operation_id),
                &pending,
            )
            .unwrap();
            pending
        }

        fn env(&self) -> crate::env::Env {
            let env = crate::env::Env::new(
                self.base.join("app-data"),
                self.base.join("resources"),
                Some(self.base.join("documents")),
                "test".into(),
            );
            let runtime = crate::runtime::runtime_root(&env).unwrap();
            fs::create_dir_all(&runtime).unwrap();
            fs::write(
                runtime.join("active-workspace.txt"),
                self.root.to_str().unwrap(),
            )
            .unwrap();
            env
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            assert!(self.base.starts_with(std::env::temp_dir()));
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    #[test]
    fn roundtrip_hash_and_provenance_belong_to_owner_workspace() {
        let fixture = Fixture::new();
        let original = read(&fixture.root, "structures\\Si.cif").unwrap();
        assert_eq!(original.path, "structures/Si.cif");
        assert_eq!(original.content, CIF);
        assert_eq!(
            hash("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let updated = CIF.replace("5.43", "5.44");
        let result = save(&fixture.root, fixture.request("ab-01", &updated)).unwrap();
        assert_eq!(
            result,
            SaveResult {
                hash: hash(&updated),
                version: 1
            }
        );
        assert_eq!(
            read(&fixture.root, &original.path).unwrap().content,
            updated
        );
        let history = versions_for(&fixture.root, &original.path).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].tool, "structure_save");
        assert_eq!(history[0].content.as_deref(), Some(updated.as_str()));
        assert_eq!(history[0].call_id.as_deref(), Some("structure-edit:ab-01"));
        assert!(history[0].log.as_ref().unwrap().contains(&result.hash));
        assert!(!fixture.base.join(".openscience").exists());
        assert!(!fixture.root.join(edit_file(PENDING, "ab-01")).exists());
    }

    #[test]
    fn stale_expected_hash_and_reused_operation_id_conflict() {
        let fixture = Fixture::new();
        let request = fixture.request("aa", &CIF.replace("5.43", "5.44"));
        let stale = fixture.request("bb", &CIF.replace("5.43", "5.45"));
        save(&fixture.root, request.clone()).unwrap();
        let e = save(&fixture.root, stale).unwrap_err();
        assert_eq!(e.code, ErrorCode::Conflict);
        assert_eq!(e.status_code(), 409);
        let changed = SaveRequest {
            content: CIF.into(),
            ..request
        };
        assert_eq!(
            save(&fixture.root, changed).unwrap_err().code,
            ErrorCode::Conflict
        );
        assert_eq!(
            versions_for(&fixture.root, "structures/Si.cif")
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn retries_keep_the_original_version_without_overwriting_later_edits() {
        let fixture = Fixture::new();
        let first = fixture.request("aa", &CIF.replace("5.43", "5.44"));
        let result = save(&fixture.root, first.clone()).unwrap();
        assert_eq!(save(&fixture.root, first.clone()).unwrap(), result);
        let second = fixture.request("bb", &CIF.replace("5.43", "5.45"));
        assert_eq!(save(&fixture.root, second.clone()).unwrap().version, 2);
        assert_eq!(save(&fixture.root, first).unwrap(), result);
        assert_eq!(
            read(&fixture.root, &second.path).unwrap().content,
            second.content
        );
        assert_eq!(versions_for(&fixture.root, &second.path).unwrap().len(), 2);
    }

    #[test]
    fn generic_workspace_writes_remain_scoped_and_preserve_explicit_disk_scope() {
        let fixture = Fixture::new();
        let env = fixture.env();
        crate::artifact_file::write_workspace_file(
            &env,
            "notebooks/nested/one.ipynb".into(),
            "new notebook".into(),
            None,
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(fixture.root.join("notebooks/nested/one.ipynb")).unwrap(),
            "new notebook"
        );
        assert!(crate::artifact_file::write_workspace_file(
            &env,
            "../escape.ipynb".into(),
            "bad".into(),
            None
        )
        .is_err());
        let outside = fixture.base.join("outside.ipynb");
        fs::write(&outside, "original").unwrap();
        fs::hard_link(&outside, fixture.root.join("hardlinked.ipynb")).unwrap();
        crate::artifact_file::write_workspace_file(
            &env,
            "hardlinked.ipynb".into(),
            "safe replacement".into(),
            None,
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&outside).unwrap(), "original");
        crate::artifact_file::write_workspace_file(
            &env,
            outside.to_str().unwrap().into(),
            "explicit disk edit".into(),
            Some("disk".into()),
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&outside).unwrap(), "explicit disk edit");
        assert_eq!(
            fs::read_to_string(fixture.root.join("hardlinked.ipynb")).unwrap(),
            "safe replacement"
        );
    }

    #[test]
    fn unrelated_provenance_cannot_impersonate_a_successful_structure_edit() {
        let fixture = Fixture::new();
        crate::provenance::append_record(
            &fixture.root,
            "structures/Si.cif",
            "write",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some("structure-edit:aa".into()),
        )
        .unwrap();
        let request = fixture.request("aa", &CIF.replace("5.43", "5.44"));
        assert_eq!(
            save(&fixture.root, request).unwrap_err().code,
            ErrorCode::RecoveryRequired
        );
        assert_eq!(
            read(&fixture.root, "structures/Si.cif").unwrap().content,
            CIF
        );
    }

    #[test]
    fn invalid_paths_formats_ids_and_content_do_not_write() {
        let fixture = Fixture::new();
        for path in [
            "../outside.cif",
            "/outside.cif",
            "C:\\outside.cif",
            "structures/../Si.cif",
            "structures/./Si.cif",
            "structures//Si.cif",
            "structures/Si.cif:stream",
            "structures/Si.cif.",
            ".openscience/Si.cif",
            "NUL.cif",
            "",
            "structures/a\0.cif",
        ] {
            assert_eq!(
                read(&fixture.root, path).unwrap_err().code,
                ErrorCode::InvalidPath,
                "{path:?}"
            );
            let request = SaveRequest {
                path: path.into(),
                ..fixture.request("ab", CIF)
            };
            assert_eq!(
                save(&fixture.root, request).unwrap_err().code,
                ErrorCode::InvalidPath
            );
        }
        for path in ["script.py", "notes.txt", "Si.mmcif"] {
            assert_eq!(
                read(&fixture.root, path).unwrap_err().code,
                ErrorCode::UnsupportedFormat
            );
        }
        for id in ["", "../aa", "zz", "--", "aa/ff", &"a".repeat(129)] {
            assert_eq!(
                save(&fixture.root, fixture.request(id, CIF))
                    .unwrap_err()
                    .code,
                ErrorCode::InvalidRequest
            );
        }
        for content in [
            "print('hello')",
            "data_bad\n_atom_site_label\n",
            "\0",
            &CIF.replace("data_Si", "#!/bin/sh\ndata_Si"),
        ] {
            assert_eq!(
                save(&fixture.root, fixture.request("ab", content))
                    .unwrap_err()
                    .code,
                ErrorCode::InvalidContent
            );
        }
        let too_large = format!("{CIF}{}", " ".repeat(MAX_CONTENT_BYTES));
        assert_eq!(
            save(&fixture.root, fixture.request("ab", &too_large))
                .unwrap_err()
                .status_code(),
            413
        );
        assert_eq!(
            save(
                &fixture.root,
                SaveRequest {
                    expected_hash: "wrong".into(),
                    ..fixture.request("ab", CIF)
                }
            )
            .unwrap_err()
            .code,
            ErrorCode::InvalidRequest
        );
        assert_eq!(
            read(Path::new(""), "Si.cif").unwrap_err().code,
            ErrorCode::InvalidPath
        );
        assert!(!fixture.root.join(".openscience").exists());
        assert_eq!(
            fs::read_to_string(fixture.root.join("structures/Si.cif")).unwrap(),
            CIF
        );
    }

    #[test]
    fn vasp_variants_and_capped_utf8_reads() {
        let fixture = Fixture::new();
        for (index, name) in ["Si.vasp", "POSCAR", "CONTCAR"].into_iter().enumerate() {
            fs::write(fixture.root.join(name), VASP).unwrap();
            let original = read(&fixture.root, name).unwrap();
            let request = SaveRequest {
                path: name.into(),
                content: VASP.replace("Direct", "Selective dynamics\nDirect"),
                expected_hash: original.hash,
                operation_id: "ab".into(),
            };
            // operation IDs identify the whole workspace, not just one path.
            let request = SaveRequest {
                operation_id: format!("ab-{index}"),
                ..request
            };
            save(&fixture.root, request).unwrap();
        }
        for content in [
            VASP.replace("5.43 0 0", "NaN 0 0"),
            VASP.replace("Si\n1\nDirect", "Si\n999999999999999999999\nDirect"),
            VASP.replace("0 0 0\n", ""),
        ] {
            assert_eq!(
                validate_content("POSCAR", &content).unwrap_err().code,
                ErrorCode::InvalidContent
            );
        }
        fs::write(fixture.root.join("bad.cif"), [0xff, 0xfe]).unwrap();
        assert_eq!(
            read(&fixture.root, "bad.cif").unwrap_err().code,
            ErrorCode::InvalidContent
        );
        let large = File::create(fixture.root.join("large.cif")).unwrap();
        large.set_len(MAX_CONTENT_BYTES as u64 + 1).unwrap();
        assert_eq!(
            read(&fixture.root, "large.cif").unwrap_err().code,
            ErrorCode::TooLarge
        );
    }

    #[test]
    fn unsupported_cif_syntax_can_be_read_but_cannot_be_saved_as_a_crystal_edit() {
        let fixture = Fixture::new();
        let source = "data_protein\nloop_\n_atom_site.Cartn_x\n_atom_site.Cartn_y\n_atom_site.Cartn_z\n1 2 3\n";
        fs::write(fixture.root.join("protein.cif"), source).unwrap();
        let original = read(&fixture.root, "protein.cif").unwrap();
        assert_eq!(original.content, source);
        assert_eq!(
            save(
                &fixture.root,
                SaveRequest {
                    path: original.path,
                    content: source.into(),
                    expected_hash: original.hash,
                    operation_id: "ab-cd".into()
                }
            )
            .unwrap_err()
            .code,
            ErrorCode::InvalidContent
        );
        assert_eq!(
            fs::read_to_string(fixture.root.join("protein.cif")).unwrap(),
            source
        );
    }

    #[test]
    fn failed_recording_preserves_pending_content_and_retry_recovers_once() {
        let fixture = Fixture::new();
        let request = fixture.request("aa", &CIF.replace("5.43", "5.44"));
        let pending = fixture.pending(&request);
        let guard = lock_ledger(&fixture.root).unwrap();
        write_atomic(&fixture.root.join(&request.path), &request.content).unwrap();
        let ledger = fixture.root.join(".openscience/provenance.jsonl");
        fs::create_dir(&ledger).unwrap();
        assert!(record_pending(&fixture.root, &guard, pending).is_err());
        assert!(fixture.root.join(edit_file(PENDING, "aa")).is_file());
        drop(guard);
        fs::remove_dir(&ledger).unwrap();
        let result = save(&fixture.root, request.clone()).unwrap();
        assert_eq!(result.version, 1);
        assert_eq!(save(&fixture.root, request).unwrap(), result);
        assert_eq!(
            versions_for(&fixture.root, "structures/Si.cif")
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn failed_receipt_recovers_after_recording_without_overwriting_external_change() {
        let fixture = Fixture::new();
        let request = fixture.request("aa", &CIF.replace("5.43", "5.44"));
        let pending = fixture.pending(&request);
        let guard = lock_ledger(&fixture.root).unwrap();
        write_atomic(&fixture.root.join(&request.path), &request.content).unwrap();
        let receipts = fixture.root.join(COMPLETED);
        fs::remove_dir(&receipts).unwrap();
        fs::write(&receipts, "receipt unavailable").unwrap();
        assert!(record_pending(&fixture.root, &guard, pending).is_err());
        assert_eq!(versions_for(&fixture.root, &request.path).unwrap().len(), 1);
        drop(guard);
        fs::remove_file(&receipts).unwrap();
        let external = CIF.replace("5.43", "6.00");
        fs::write(fixture.root.join(&request.path), &external).unwrap();
        assert_eq!(save(&fixture.root, request).unwrap().version, 1);
        assert_eq!(
            read(&fixture.root, "structures/Si.cif").unwrap().content,
            external
        );
        assert_eq!(
            versions_for(&fixture.root, "structures/Si.cif")
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn pending_edit_recovers_before_a_new_save_and_detects_external_conflicts() {
        let fixture = Fixture::new();
        let first = fixture.request("aa", &CIF.replace("5.43", "5.44"));
        fixture.pending(&first);
        write_atomic(&fixture.root.join(&first.path), &first.content).unwrap();
        let second = fixture.request("bb", &CIF.replace("5.43", "5.45"));
        assert_eq!(save(&fixture.root, second).unwrap().version, 2);
        let interrupted = fixture.request("cc", &CIF.replace("5.43", "5.46"));
        fixture.pending(&interrupted);
        fs::write(fixture.root.join(&interrupted.path), CIF).unwrap();
        assert_eq!(
            save(&fixture.root, interrupted).unwrap_err().code,
            ErrorCode::RecoveryRequired
        );
        assert_eq!(
            read(&fixture.root, "structures/Si.cif").unwrap().content,
            CIF
        );
    }

    #[test]
    fn crash_before_replace_can_resume_and_corrupt_manifest_cannot_escape() {
        let fixture = Fixture::new();
        let request = fixture.request("aa", &CIF.replace("5.43", "5.44"));
        fixture.pending(&request);
        assert_eq!(save(&fixture.root, request).unwrap().version, 1);
        let request = fixture.request("bb", &CIF.replace("5.43", "5.45"));
        let mut pending = fixture.pending(&request);
        pending.edit.path = "../outside.cif".into();
        write_json(&fixture.root, &edit_file(PENDING, "bb"), &pending).unwrap();
        let another = fixture.request("cc", CIF);
        assert!(save(&fixture.root, another).is_err());
        assert!(!fixture.base.join("outside.cif").exists());
    }

    #[test]
    fn concurrent_saves_allow_one_writer_for_an_expected_hash() {
        let fixture = Fixture::new();
        let barrier = Arc::new(Barrier::new(2));
        let mut workers = Vec::new();
        for (id, length) in [("aa", "5.44"), ("bb", "5.45")] {
            let request = fixture.request(id, &CIF.replace("5.43", length));
            let root = fixture.root.clone();
            let barrier = barrier.clone();
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                save(&root, request)
            }));
        }
        let results = workers
            .into_iter()
            .map(|w| w.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|r| matches!(r, Err(e) if e.code == ErrorCode::Conflict))
                .count(),
            1
        );
        assert_eq!(
            versions_for(&fixture.root, "structures/Si.cif")
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn child_save() {
        let Some(root) = std::env::var_os("OSD_STRUCTURE_CHILD_ROOT").map(PathBuf::from) else {
            return;
        };
        fs::write(root.join("ready"), "ready").unwrap();
        let request = SaveRequest {
            path: "structures/Si.cif".into(),
            content: CIF.replace("5.43", "5.44"),
            expected_hash: hash(CIF),
            operation_id: "aa".into(),
        };
        save(&root, request).unwrap();
    }

    #[test]
    fn ledger_lock_excludes_a_separate_saving_process() {
        let fixture = Fixture::new();
        let guard = lock_ledger(&fixture.root).unwrap();
        let mut child = spawn_test(
            "structure_file::tests::child_save",
            &[("OSD_STRUCTURE_CHILD_ROOT", fixture.root.to_str().unwrap())],
        );
        wait_for_file(&fixture.root.join("ready"));
        assert!(child.try_wait().unwrap().is_none());
        assert_eq!(
            read(&fixture.root, "structures/Si.cif").unwrap().content,
            CIF
        );
        drop(guard);
        assert_exits_ok(&mut child);
        assert_eq!(
            versions_for(&fixture.root, "structures/Si.cif")
                .unwrap()
                .len(),
            1
        );
    }

    #[cfg(any(windows, unix))]
    fn link_directory(target: &Path, link: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
        #[cfg(windows)]
        {
            let powershell =
                crate::which::find_on_path("pwsh", std::env::var("PATH").ok().as_deref())
                    .unwrap_or_else(|| {
                        PathBuf::from(std::env::var_os("SystemRoot").unwrap())
                            .join("System32/WindowsPowerShell/v1.0/powershell.exe")
                    });
            let output = crate::runtime::quiet_command(powershell)
                .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "New-Item -ItemType Junction -Path $env:OSD_TEST_LINK -Target $env:OSD_TEST_TARGET -ErrorAction Stop | Out-Null"])
                .env("OSD_TEST_LINK", link).env("OSD_TEST_TARGET", target).output().unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }

    #[cfg(any(windows, unix))]
    #[test]
    fn generic_workspace_writes_reject_linked_parents() {
        let fixture = Fixture::new();
        let env = fixture.env();
        let outside = fixture.base.join("outside");
        fs::create_dir(&outside).unwrap();
        let link = fixture.root.join("linked");
        link_directory(&outside, &link);
        assert!(crate::artifact_file::write_workspace_file(
            &env,
            "linked/subfolder/new.ipynb".into(),
            "bad".into(),
            None
        )
        .is_err());
        assert!(!outside.join("subfolder").exists());
        #[cfg(windows)]
        fs::remove_dir(link).unwrap();
        #[cfg(unix)]
        fs::remove_file(link).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlink_files_parents_and_internal_state_are_refused() {
        let fixture = Fixture::new();
        let outside = fixture.base.join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("Si.cif"), CIF).unwrap();
        std::os::unix::fs::symlink(&outside, fixture.root.join("linked")).unwrap();
        std::os::unix::fs::symlink(outside.join("Si.cif"), fixture.root.join("file.cif")).unwrap();
        for path in ["linked/Si.cif", "file.cif"] {
            assert_eq!(
                read(&fixture.root, path).unwrap_err().code,
                ErrorCode::InvalidPath
            );
            assert_eq!(
                save(
                    &fixture.root,
                    SaveRequest {
                        path: path.into(),
                        ..fixture.request("aa", CIF)
                    }
                )
                .unwrap_err()
                .code,
                ErrorCode::InvalidPath
            );
        }
        std::os::unix::fs::symlink(&outside, fixture.root.join(".openscience")).unwrap();
        assert_eq!(
            save(&fixture.root, fixture.request("aa", CIF))
                .unwrap_err()
                .code,
            ErrorCode::InvalidPath
        );
        assert_eq!(fs::read_to_string(outside.join("Si.cif")).unwrap(), CIF);
        assert!(!outside.join("ledger.lock").exists());
    }

    #[cfg(windows)]
    #[test]
    fn junction_parents_and_internal_state_are_refused() {
        let fixture = Fixture::new();
        let outside = fixture.base.join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("Si.cif"), CIF).unwrap();
        for link in [
            fixture.root.join("linked"),
            fixture.root.join(".openscience"),
        ] {
            link_directory(&outside, &link);
        }
        assert_eq!(
            read(&fixture.root, "linked/Si.cif").unwrap_err().code,
            ErrorCode::InvalidPath
        );
        assert_eq!(
            save(
                &fixture.root,
                SaveRequest {
                    path: "linked/Si.cif".into(),
                    ..fixture.request("aa", CIF)
                }
            )
            .unwrap_err()
            .code,
            ErrorCode::InvalidPath
        );
        assert_eq!(
            save(&fixture.root, fixture.request("aa", CIF))
                .unwrap_err()
                .code,
            ErrorCode::InvalidPath
        );
        assert_eq!(fs::read_to_string(outside.join("Si.cif")).unwrap(), CIF);
        assert!(!outside.join("ledger.lock").exists());
        fs::remove_dir(fixture.root.join("linked")).unwrap();
        fs::remove_dir(fixture.root.join(".openscience")).unwrap();
    }
}
