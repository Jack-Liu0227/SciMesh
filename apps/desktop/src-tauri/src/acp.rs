// Supervising ACP agent children (#14, client direction).
//
// `AcpRuntime` (packages/sdk) speaks the Agent Client Protocol over an injected
// LINE transport and deliberately never spawns anything: the webview has no
// `child_process`, and the gateway web client — a phone — has no local process
// at all. So the child lives here, beside the OpenCode sidecar, and its stdio is
// relayed to the frontend as Tauri events.
//
// Safety (AGENTS.md): starting an agent IS command execution, so nothing here
// ever starts one on its own. A child appears only when the user has configured
// that command in Settings and asked for it, it runs in the active workspace
// folder and nowhere else, and every child is killed when the app exits — an
// agent process outliving the window would keep model access the user thinks
// they closed.
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

/// One line of agent stdout, relayed to the frontend. The payload carries the
/// agent id because several agents can be configured and running at once.
const LINE_EVENT: &str = "acp:line";
/// The child ended — the frontend fails every pending request rather than
/// waiting forever on an answer that can never come.
const EXIT_EVENT: &str = "acp:exit";

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpLine {
    pub agent_id: String,
    pub line: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpExit {
    pub agent_id: String,
    /// Why it ended, in the child's own words when it left any — an auth
    /// failure or "command not found" is the whole diagnostic value.
    pub reason: String,
}

/// The account an agent runs as: which agent's accounts, and which one.
#[derive(serde::Deserialize)]
pub struct AccountRef {
    pub kind: String,
    pub id: String,
}

struct Agent {
    child: Child,
    stdin: ChildStdin,
    logged_stdin: bool,
    redactions: Arc<Mutex<SecretRedactions>>,
    cwd: PathBuf,
}

#[derive(Default)]
struct SecretRedactions(Vec<String>);

impl SecretRedactions {
    fn remember(&mut self, values: Vec<String>) {
        for value in values {
            if !value.is_empty() && !self.0.contains(&value) {
                self.0.push(value);
            }
        }
        self.0.sort_by_key(|value| std::cmp::Reverse(value.len()));
    }

    fn text(&self, value: &str) -> String {
        self.0.iter().fold(value.to_string(), |text, secret| {
            let text = text.replace(secret, "[redacted]");
            let encoded = serde_json::to_string(secret).expect("a string serializes");
            text.replace(&encoded[1..encoded.len() - 1], "[redacted]")
        })
    }

    fn line(&self, line: &str) -> String {
        fn walk(value: &mut Value, redactions: &SecretRedactions) {
            match value {
                Value::String(text) => *text = redactions.text(text),
                Value::Array(items) => items.iter_mut().for_each(|item| walk(item, redactions)),
                Value::Object(object) => {
                    for (name, value) in object {
                        // Protocol routing and enum values are not credential
                        // output. Rewriting an RPC ID would lose its response.
                        let lower = name.to_ascii_lowercase();
                        let metadata = lower == "id"
                            || lower.ends_with("id")
                            || matches!(
                                lower.as_str(),
                                "jsonrpc"
                                    | "method"
                                    | "type"
                                    | "kind"
                                    | "role"
                                    | "status"
                                    | "sessionupdate"
                                    | "stopreason"
                                    | "mimetype"
                            );
                        if !metadata || !value.is_string() {
                            walk(value, redactions);
                        }
                    }
                }
                _ => {}
            }
        }
        if self.0.is_empty() {
            return line.to_string();
        }
        match serde_json::from_str::<Value>(line) {
            Ok(mut message) => {
                walk(&mut message, self);
                message.to_string()
            }
            Err(_) => self.text(line),
        }
    }
}

const MCP_CREDENTIAL_ERROR: &str = "The configured ACP MCP credentials could not be resolved.";
const MCP_CONFIG_ERROR: &str =
    "ACP MCP credential references must match an enabled connector in host Settings.";
const MAX_CREDENTIAL_BYTES: u64 = 64 * 1024;
const MCP_PROJECT_ERROR: &str =
    "The ACP session project configuration could not be safely applied.";

fn project_connectors(cwd: &Path) -> Result<Option<Vec<String>>, String> {
    fn safe_metadata(path: &Path) -> Result<Option<std::fs::Metadata>, String> {
        let metadata = match std::fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(MCP_PROJECT_ERROR.into()),
        };
        if metadata.file_type().is_symlink() {
            return Err(MCP_PROJECT_ERROR.into());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err(MCP_PROJECT_ERROR.into());
            }
        }
        Ok(Some(metadata))
    }
    let profile = cwd.join(".agents");
    let Some(metadata) = safe_metadata(&profile)? else {
        return Ok(None);
    };
    if !metadata.is_dir() {
        return Err(MCP_PROJECT_ERROR.into());
    }
    let path = profile.join("agent.json");
    let Some(metadata) = safe_metadata(&path)? else {
        return Ok(None);
    };
    if !metadata.is_file() {
        return Err(MCP_PROJECT_ERROR.into());
    }
    use std::io::Read;
    const MAX_CONFIG_BYTES: u64 = 256 * 1024;
    let mut bytes = Vec::new();
    std::fs::File::open(&path)
        .map_err(|_| MCP_PROJECT_ERROR)?
        .take(MAX_CONFIG_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| MCP_PROJECT_ERROR)?;
    if bytes.len() as u64 > MAX_CONFIG_BYTES {
        return Err(MCP_PROJECT_ERROR.into());
    }
    let config: Value = serde_json::from_slice(&bytes).map_err(|_| MCP_PROJECT_ERROR)?;
    osd_core::agent_config::validate_project(&config).map_err(|_| MCP_PROJECT_ERROR)?;
    config
        .get("connectors")
        .map(|value| {
            value
                .as_array()
                .ok_or(MCP_PROJECT_ERROR)?
                .iter()
                .map(|id| {
                    id.as_str()
                        .map(str::to_string)
                        .ok_or_else(|| MCP_PROJECT_ERROR.to_string())
                })
                .collect()
        })
        .transpose()
}

/// Use the cwd that will be sent to the ACP agent for this session, checked
/// against host-managed workspaces before reading any project files.
fn session_directory(
    env: &osd_core::Env,
    request: &Value,
    launched_in: &Path,
    active: &Path,
) -> Result<PathBuf, String> {
    let path = Path::new(request["params"]["cwd"].as_str().ok_or(MCP_PROJECT_ERROR)?);
    if !path.is_absolute() {
        return Err(MCP_PROJECT_ERROR.into());
    }
    let cwd = path.canonicalize().map_err(|_| MCP_PROJECT_ERROR)?;
    if !cwd.is_dir() {
        return Err(MCP_PROJECT_ERROR.into());
    }
    let native_roots = [
        Some(launched_in.to_path_buf()),
        Some(active.to_path_buf()),
        osd_core::runtime::base_workspace_dir(env).ok(),
    ];
    let managed = native_roots
        .into_iter()
        .flatten()
        .filter_map(|root| root.canonicalize().ok())
        .any(|root| cwd.starts_with(root));
    if !managed && !osd_core::project::is_inside_registered_project(env, &cwd) {
        return Err(MCP_PROJECT_ERROR.into());
    }
    Ok(cwd)
}

// Values live only on the native side. Never derive Debug or Serialize here.
struct ResolvedCredential {
    value: String,
    redactions: Vec<String>,
}

/// Expand original configuration text once, never recursively expand a secret's
/// contents. Reference names, paths and provider errors stay out of diagnostics.
fn resolve_credential_with(
    input: &str,
    mut resolve: impl FnMut(&str, &str) -> Result<String, String>,
) -> Result<ResolvedCredential, String> {
    let mut rest = input;
    let mut value = String::new();
    let mut redactions = Vec::new();
    while let Some((at, kind)) = [(rest.find("{env:"), "env"), (rest.find("{file:"), "file")]
        .into_iter()
        .filter_map(|(at, kind)| at.map(|at| (at, kind)))
        .min_by_key(|(at, _)| *at)
    {
        value.push_str(&rest[..at]);
        let reference = &rest[at + kind.len() + 2..];
        let end = reference.find('}').ok_or(MCP_CREDENTIAL_ERROR)?;
        let name = &reference[..end];
        if name.is_empty() || name.chars().any(char::is_control) || redactions.len() >= 64 {
            return Err(MCP_CREDENTIAL_ERROR.into());
        }
        let resolved = resolve(kind, name).map_err(|_| MCP_CREDENTIAL_ERROR)?;
        if resolved.len() as u64 > MAX_CREDENTIAL_BYTES || resolved.contains('\0') {
            return Err(MCP_CREDENTIAL_ERROR.into());
        }
        value.push_str(&resolved);
        redactions.push(resolved);
        rest = &reference[end + 1..];
        if value.len() as u64 > MAX_CREDENTIAL_BYTES {
            return Err(MCP_CREDENTIAL_ERROR.into());
        }
    }
    value.push_str(rest);
    if value.len() as u64 > MAX_CREDENTIAL_BYTES {
        return Err(MCP_CREDENTIAL_ERROR.into());
    }
    redactions.push(value.clone());
    Ok(ResolvedCredential { value, redactions })
}

fn resolve_credential(env: &osd_core::Env, input: &str) -> Result<ResolvedCredential, String> {
    resolve_credential_with(input, |kind, name| {
        if kind == "env" {
            if let Some(id) = name.strip_prefix("OSD_SECRET_") {
                if id.len() != 64 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                    return Err(MCP_CREDENTIAL_ERROR.into());
                }
                return osd_core::secrets::read(env, name)
                    .map_err(|_| MCP_CREDENTIAL_ERROR.to_string())?
                    .ok_or_else(|| MCP_CREDENTIAL_ERROR.into());
            }
            // Preserve OpenCode's empty substitution for an unset ordinary
            // variable. Reserved OSD credentials instead fail closed.
            return match std::env::var(name) {
                Ok(value) => Ok(value),
                Err(std::env::VarError::NotPresent) => Ok(String::new()),
                Err(_) => Err(MCP_CREDENTIAL_ERROR.into()),
            };
        }
        let path =
            if let Some(relative) = name.strip_prefix("~/").or_else(|| name.strip_prefix("~\\")) {
                let home = std::env::var_os("HOME")
                    .filter(|value| !value.is_empty())
                    .or_else(|| std::env::var_os("USERPROFILE").filter(|value| !value.is_empty()))
                    .ok_or(MCP_CREDENTIAL_ERROR)?;
                Path::new(&home).join(relative)
            } else {
                let path = Path::new(name);
                if path.is_absolute() {
                    path.to_path_buf()
                } else {
                    osd_core::agent_config::profile_dir(env).join(path)
                }
            };
        use std::io::Read;
        if !std::fs::metadata(&path)
            .map_err(|_| MCP_CREDENTIAL_ERROR)?
            .is_file()
        {
            return Err(MCP_CREDENTIAL_ERROR.into());
        }
        let file = std::fs::File::open(path).map_err(|_| MCP_CREDENTIAL_ERROR)?;
        if !file.metadata().map_err(|_| MCP_CREDENTIAL_ERROR)?.is_file() {
            return Err(MCP_CREDENTIAL_ERROR.into());
        }
        let mut bytes = Vec::new();
        file.take(MAX_CREDENTIAL_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| MCP_CREDENTIAL_ERROR)?;
        if bytes.len() as u64 > MAX_CREDENTIAL_BYTES {
            return Err(MCP_CREDENTIAL_ERROR.into());
        }
        String::from_utf8(bytes)
            .map(|value| value.trim().to_string())
            .map_err(|_| MCP_CREDENTIAL_ERROR.into())
    })
}

fn has_reference(value: &str) -> bool {
    value.contains("{env:") || value.contains("{file:")
}

fn server_has_reference(server: &Value) -> bool {
    ["env", "headers"].iter().any(|field| {
        server[*field].as_array().is_some_and(|pairs| {
            pairs
                .iter()
                .any(|pair| pair["value"].as_str().is_some_and(has_reference))
        })
    })
}

struct PreparedLine {
    payload: String,
    redactions: Vec<String>,
}

fn authorize_mcp_server(server: &Value, config: &Value) -> Result<(), String> {
    let name = server["name"].as_str().ok_or(MCP_CONFIG_ERROR)?;
    let configured = config["mcp"].get(name).ok_or(MCP_CONFIG_ERROR)?;
    if configured["enabled"] == false {
        return Err(MCP_CONFIG_ERROR.into());
    }
    let (field, configured_field, allowed): (&str, &str, &[&str]) = if server.get("type").is_none()
    {
        let expected = configured["command"].as_array().ok_or(MCP_CONFIG_ERROR)?;
        let args = server["args"].as_array().ok_or(MCP_CONFIG_ERROR)?;
        if configured["type"] != "local"
            || expected.is_empty()
            || server["command"] != expected[0]
            || args.as_slice() != &expected[1..]
        {
            return Err(MCP_CONFIG_ERROR.into());
        }
        ("env", "environment", &["name", "command", "args", "env"])
    } else {
        if configured["type"] != "remote"
            || !matches!(server["type"].as_str(), Some("http" | "sse"))
            || server["url"] != configured["url"]
        {
            return Err(MCP_CONFIG_ERROR.into());
        }
        ("headers", "headers", &["name", "type", "url", "headers"])
    };
    if server
        .as_object()
        .ok_or(MCP_CONFIG_ERROR)?
        .keys()
        .any(|key| !allowed.contains(&key.as_str()))
    {
        return Err(MCP_CONFIG_ERROR.into());
    }
    let pairs = server[field].as_array().ok_or(MCP_CONFIG_ERROR)?;
    let Some(expected) = configured[configured_field].as_object() else {
        return if configured.get(configured_field).is_none() && pairs.is_empty() {
            Ok(())
        } else {
            Err(MCP_CONFIG_ERROR.into())
        };
    };
    if pairs.len() != expected.len() {
        return Err(MCP_CONFIG_ERROR.into());
    }
    let mut seen = std::collections::HashSet::new();
    for pair in pairs {
        let key = pair["name"].as_str().ok_or(MCP_CONFIG_ERROR)?;
        let value = pair["value"].as_str().ok_or(MCP_CONFIG_ERROR)?;
        if pair.as_object().ok_or(MCP_CONFIG_ERROR)?.len() != 2
            || !seen.insert(key)
            || expected.get(key).and_then(Value::as_str) != Some(value)
        {
            return Err(MCP_CONFIG_ERROR.into());
        }
    }
    Ok(())
}

/// Bind each reference to the configured connector and its destination before
/// reading any credential. Other ACP messages remain unchanged.
fn prepare_mcp_line(
    line: &str,
    load_project: impl FnOnce(&Value) -> Result<Option<Vec<String>>, String>,
    load_config: impl FnOnce() -> Result<Value, String>,
    mut resolve: impl FnMut(&str) -> Result<ResolvedCredential, String>,
) -> Result<PreparedLine, String> {
    let mut message: Value = serde_json::from_str(line).map_err(|_| "Invalid ACP JSON message.")?;
    let session_request = matches!(
        message["method"].as_str(),
        Some("session/new" | "session/load" | "session/fork" | "session/resume")
    );
    if !session_request {
        return Ok(PreparedLine {
            payload: line.to_string(),
            redactions: Vec::new(),
        });
    }
    if message["params"]["mcpServers"]
        .as_array()
        .is_none_or(Vec::is_empty)
    {
        return Ok(PreparedLine {
            payload: line.to_string(),
            redactions: Vec::new(),
        });
    }
    let allowed = load_project(&message).map_err(|_| MCP_PROJECT_ERROR)?;
    let Some(servers) = message
        .get_mut("params")
        .and_then(|params| params.get_mut("mcpServers"))
        .and_then(Value::as_array_mut)
    else {
        return Ok(PreparedLine {
            payload: line.to_string(),
            redactions: Vec::new(),
        });
    };
    if let Some(allowed) = allowed {
        if servers
            .iter()
            .any(|server| server["name"].as_str().is_none())
        {
            return Err(MCP_CONFIG_ERROR.into());
        }
        servers.retain(|server| {
            server["name"]
                .as_str()
                .is_some_and(|name| allowed.iter().any(|allowed| allowed == name))
        });
    }
    if servers.is_empty() {
        return Ok(PreparedLine {
            payload: message.to_string(),
            redactions: Vec::new(),
        });
    }
    let config = load_config().map_err(|_| MCP_CREDENTIAL_ERROR)?;
    for server in servers.iter() {
        authorize_mcp_server(server, &config)?;
    }
    let mut redactions = Vec::new();
    for server in servers {
        if !server_has_reference(server) {
            continue;
        }
        let name = server["name"].as_str().ok_or(MCP_CONFIG_ERROR)?;
        let configured = config["mcp"].get(name).ok_or(MCP_CONFIG_ERROR)?;
        for (field, configured_field) in [("env", "environment"), ("headers", "headers")] {
            let Some(pairs) = server[field].as_array() else {
                continue;
            };
            if !pairs
                .iter()
                .any(|pair| pair["value"].as_str().is_some_and(has_reference))
            {
                continue;
            }
            for pair in server[field].as_array_mut().ok_or(MCP_CONFIG_ERROR)? {
                let key = pair["name"].as_str().ok_or(MCP_CONFIG_ERROR)?;
                let trusted = configured[configured_field]
                    .get(key)
                    .and_then(Value::as_str)
                    .ok_or(MCP_CONFIG_ERROR)?;
                if !has_reference(trusted) {
                    continue;
                }
                let resolved = resolve(trusted).map_err(|_| MCP_CREDENTIAL_ERROR)?;
                if field == "headers" && resolved.value.contains(['\r', '\n']) {
                    return Err(MCP_CREDENTIAL_ERROR.into());
                }
                // OS-backed config also contains ordinary environment values.
                // Hiding PORT=1 or an Accept MIME type would corrupt tool data.
                if !osd_core::agent_config::public_connector_parameter(field, key) {
                    redactions.extend(resolved.redactions);
                }
                pair["value"] = Value::String(resolved.value);
            }
        }
    }
    Ok(PreparedLine {
        payload: message.to_string(),
        redactions,
    })
}

#[derive(Default)]
pub struct AcpState {
    agents: Mutex<HashMap<String, Agent>>,
}

impl AcpState {
    /// Wait until a registered child exits and remove exactly that entry.
    ///
    /// Returning `None` means another path stopped and removed the child.
    fn wait_for_exit(&self, agent_id: &str) -> Option<String> {
        loop {
            {
                let mut agents = self.agents.lock().unwrap();
                let status = match agents.get_mut(agent_id) {
                    None => return None,
                    Some(agent) => match agent.child.try_wait() {
                        Ok(Some(status)) => Some(match status.code() {
                            Some(code) => format!("code {code}"),
                            None => "a signal".to_string(),
                        }),
                        Ok(None) => None,
                        Err(_) => Some("an unknown status".to_string()),
                    },
                };
                if let Some(how) = status {
                    agents.remove(agent_id);
                    return Some(how);
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
    }
}

fn exit_reason(command: &str, how: &str, detail: &str) -> String {
    if detail.is_empty() {
        format!("{command} exited ({how})")
    } else {
        let tail: String = detail
            .chars()
            .rev()
            .take(500)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
        format!("{command} exited ({how}): {tail}")
    }
}

/// Split whatever whole lines `buffer` now holds, leaving any trailing partial
/// line behind.
///
/// A read boundary lands mid-message routinely, and handing half a JSON object
/// to the peer would drop the message it belongs to — the frontend's transport
/// contract is whole lines.
pub(crate) fn take_lines(buffer: &mut String) -> Vec<String> {
    let mut out = Vec::new();
    while let Some(at) = buffer.find('\n') {
        let line: String = buffer.drain(..=at).collect();
        out.push(line.trim_end_matches(['\n', '\r']).to_string());
    }
    out
}

/// Start `command args…` as an ACP agent in the active workspace folder.
///
/// Idempotent per `agent_id`: a second call while one is running is a no-op, so
/// a double click cannot leave an orphan child holding a model session.
///
/// Async because starting as an account first asks the agent who is signed in
/// (about a second): a sync command would hold the main thread meanwhile.
#[tauri::command]
pub async fn acp_start(
    app: AppHandle,
    agent_id: String,
    command: String,
    args: Vec<String>,
    account: Option<AccountRef>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        start_blocking(app, agent_id, command, args, account)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn start_blocking(
    app: AppHandle,
    agent_id: String,
    command: String,
    args: Vec<String>,
    account: Option<AccountRef>,
) -> Result<(), String> {
    if command.trim().is_empty() {
        return Err("an ACP agent needs a command to run".into());
    }
    {
        let state = app.state::<AcpState>();
        let mut agents = state.agents.lock().unwrap();
        if let Some(existing) = agents.get_mut(&agent_id) {
            // Still alive? Then this call has nothing to do. A child that has
            // exited is cleared so the next start really starts one.
            match existing.child.try_wait() {
                Ok(None) => return Ok(()),
                _ => {
                    agents.remove(&agent_id);
                }
            }
        }
    }
    let cwd = crate::runtime::workspace_dir(&app)?;
    // Run as the conversation's account, checked before anything starts.
    let account_env = match &account {
        Some(a) => Some(crate::agent_accounts::launch_env(
            &app,
            osd_core::agent_accounts::AgentKind::parse(&a.kind)?,
            &a.id,
        )?),
        None => None,
    };
    // GUI-launched apps get a minimal PATH; an ACP agent is usually a node or
    // cargo binary the user installed, so give it the real one. Resolved once
    // and used for both the lookup and the child, so "found" and "started"
    // cannot disagree about which PATH they meant.
    let path_env = crate::runtime::enriched_path();
    // Resolve the name the way this machine's shell would BEFORE spawning.
    // `std::process::Command` does not expand PATHEXT on Windows, so `npx` —
    // which npm installs as `npx.cmd` — would be found by the picker (which
    // does expand it) and then fail to start (#172).
    let program = osd_core::which::resolve_program(&command, Some(&path_env));
    // quiet_command: an ACP agent is a console-subsystem binary, and a console
    // window opening beside the app for it is noise the user never asked for.
    let mut command_line = crate::runtime::quiet_command(&program);
    let redactions = Arc::new(Mutex::new(SecretRedactions::default()));
    command_line
        .args(&args)
        .current_dir(&cwd)
        .env("PATH", &path_env);
    // The app's proxy setting, the same a terminal gets: Claude Code or Codex
    // run here must reach their API the way they do in the app's terminal.
    for (k, v) in crate::runtime::sidecar_proxy_env(&app) {
        command_line.env(k, v);
    }
    if let Some((set, unset)) = account_env {
        for (k, v) in set {
            command_line.env(k, v);
        }
        for k in unset {
            command_line.env_remove(k);
        }
    } else if let Some((var, key)) =
        osd_core::agent_keys::launch_key(&crate::env_of(&app), &agent_id, &cwd)
    {
        // The API key the user already gave OpenCode, for an agent with none.
        redactions.lock().unwrap().remember(vec![key.clone()]);
        command_line.env(var, key);
    }
    let mut child = command_line
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => format!(
                "{command} is not installed, or not on your shell's PATH. Install it, or give its full path in Settings → Agents."
            ),
            _ => format!("could not start {command}: {e}"),
        })?;

    let stdout = child.stdout.take().ok_or("the agent has no stdout")?;
    let stderr = child.stderr.take().ok_or("the agent has no stderr")?;
    let stdin = child.stdin.take().ok_or("the agent has no stdin")?;
    let pid = child.id();

    // Reader: relay whole lines. stdout is the protocol; nothing is interpreted
    // here, which is the point — the wire format belongs to the SDK.
    {
        let app = app.clone();
        let id = agent_id.clone();
        let redactions = redactions.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut buffer = String::new();
            let mut saw_output = false;
            loop {
                let mut chunk = Vec::new();
                match reader.read_until(b'\n', &mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        buffer.push_str(&String::from_utf8_lossy(&chunk));
                        for line in take_lines(&mut buffer) {
                            if line.is_empty() {
                                continue;
                            }
                            if !saw_output {
                                crate::debug_log::append(
                                    &app,
                                    &format!(
                                        "[acp] first stdout line pid={pid} bytes={}",
                                        line.len()
                                    ),
                                );
                                saw_output = true;
                            }
                            let _ = app.emit(
                                LINE_EVENT,
                                AcpLine {
                                    agent_id: id.clone(),
                                    line: redactions.lock().unwrap().line(&line),
                                },
                            );
                        }
                    }
                }
            }
        });
    }
    // stderr is NOT protocol — agents log to it freely — so it is kept only as
    // the reason the child ended, which is where it is actually diagnostic.
    let last_error = std::sync::Arc::new(Mutex::new(String::new()));
    {
        let sink = last_error.clone();
        let redactions = redactions.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let mut held = sink.lock().unwrap();
                held.push_str(&redactions.lock().unwrap().text(&line));
                held.push('\n');
                // Keep the tail only: a chatty agent must not grow this forever.
                if held.len() > 2000 {
                    let cut = held.len() - 1000;
                    let at = (cut..=held.len())
                        .find(|i| held.is_char_boundary(*i))
                        .unwrap_or(held.len());
                    *held = held.split_off(at);
                }
            }
        });
    }
    // Publish the child before its waiter starts. A process can exit immediately;
    // starting the waiter first would let it observe a missing map entry and leave
    // the frontend waiting for a response that can never arrive.
    app.state::<AcpState>().agents.lock().unwrap().insert(
        agent_id.clone(),
        Agent {
            child,
            stdin,
            logged_stdin: false,
            redactions,
            cwd,
        },
    );
    crate::debug_log::append(&app, &format!("[acp] child started pid={pid}"));

    // Waiter: one exit event, so the frontend can fail pending requests instead
    // of hanging on a process that is gone.
    {
        let app = app.clone();
        let id = agent_id.clone();
        let command = command.clone();
        std::thread::spawn(move || {
            let Some(how) = app.state::<AcpState>().wait_for_exit(&id) else {
                return;
            };
            let detail = last_error.lock().unwrap().trim().to_string();
            crate::debug_log::append(&app, &format!("[acp] child exited pid={pid} status={how}"));
            let reason = exit_reason(&command, &how, &detail);
            let _ = app.emit(
                EXIT_EVENT,
                AcpExit {
                    agent_id: id,
                    reason,
                },
            );
        });
    }
    Ok(())
}

/// Write one already-framed line to the agent's stdin.
#[tauri::command]
pub fn acp_send(app: AppHandle, agent_id: String, line: String) -> Result<(), String> {
    let env = crate::env_of(&app);
    let state = app.state::<AcpState>();
    let mut agents = state.agents.lock().unwrap();
    let agent = agents
        .get_mut(&agent_id)
        .ok_or("that agent is not running")?;
    let prepared = prepare_mcp_line(
        &line,
        |request| {
            let active = crate::runtime::workspace_dir(&app).map_err(|_| MCP_PROJECT_ERROR)?;
            let cwd = session_directory(&env, request, &agent.cwd, &active)?;
            project_connectors(&cwd)
        },
        || osd_core::agent_config::read(&env),
        |value| resolve_credential(&env, value),
    )?;
    let pid = agent.child.id();
    // Register before writing: a fast agent can echo credentials immediately.
    agent
        .redactions
        .lock()
        .unwrap()
        .remember(prepared.redactions);
    // The frontend frames its own messages; a missing newline would merge two
    // JSON-RPC messages into one unparseable line.
    let payload = if prepared.payload.ends_with('\n') {
        prepared.payload
    } else {
        format!("{}\n", prepared.payload)
    };
    agent
        .stdin
        .write_all(payload.as_bytes())
        .map_err(|_| "Could not write to the ACP agent.".to_string())?;
    agent
        .stdin
        .flush()
        .map_err(|_| "Could not flush the ACP message.".to_string())?;
    if !agent.logged_stdin {
        crate::debug_log::append(
            &app,
            &format!("[acp] first stdin write pid={pid} bytes={}", payload.len()),
        );
        agent.logged_stdin = true;
    }
    Ok(())
}

/// Stop one agent. The next start gets a fresh process.
#[tauri::command]
pub fn acp_stop(app: AppHandle, agent_id: String) -> Result<(), String> {
    let state = app.state::<AcpState>();
    let removed = state.agents.lock().unwrap().remove(&agent_id);
    if let Some(mut agent) = removed {
        let _ = agent.child.kill();
        let _ = agent.child.wait();
    }
    Ok(())
}

/// Which agents are running right now — the truth after a webview reload, which
/// loses every JS-side handle while the children keep running.
#[tauri::command]
pub fn acp_running(app: AppHandle) -> Vec<String> {
    let state = app.state::<AcpState>();
    let mut agents = state.agents.lock().unwrap();
    let mut live = Vec::new();
    for (id, agent) in agents.iter_mut() {
        if matches!(agent.child.try_wait(), Ok(None)) {
            live.push(id.clone());
        }
    }
    live
}

/// Kill every agent. Called on app exit: an agent process that outlives the
/// window keeps model access the user believes they closed.
pub fn shutdown(app: &AppHandle) {
    let ids: Vec<String> = {
        let state = app.state::<AcpState>();
        let agents = state.agents.lock().unwrap();
        agents.keys().cloned().collect()
    };
    for id in ids {
        let _ = acp_stop(app.clone(), id);
    }
}

#[cfg(test)]
mod tests {
    use std::io::{BufReader, Read};
    use std::process::{Command, Stdio};

    use super::{exit_reason, take_lines, AcpState, Agent};
    use super::{
        prepare_mcp_line, project_connectors, resolve_credential, resolve_credential_with,
        session_directory, SecretRedactions, MAX_CREDENTIAL_BYTES, MCP_CONFIG_ERROR,
        MCP_CREDENTIAL_ERROR, MCP_PROJECT_ERROR,
    };
    use serde_json::{json, Value};

    fn unrestricted_project(_: &Value) -> Result<Option<Vec<String>>, String> {
        Ok(None)
    }

    fn connector_fixture() -> (Value, Value) {
        let reference = format!("{{env:OSD_SECRET_{}}}", "a".repeat(64));
        let config = json!({"schemaVersion":1,"provider":{"unused":{"options":{"apiKey":"{env:UNRELATED_PROVIDER}"}}},"mcp":{
            "local":{"type":"local","command":["node","science-mcp"],"environment":{"API_KEY":reference,"MODE":"research"}},
            "remote":{"type":"remote","url":"https://api.example.test/mcp","headers":{"Authorization":"Bearer {env:LAB_TOKEN}"}}
        }});
        let message = json!({"jsonrpc":"2.0","id":7,"method":"session/new","params":{"cwd":"/workspace","mcpServers":[
            {"name":"local","command":"node","args":["science-mcp"],"env":[{"name":"API_KEY","value":reference},{"name":"MODE","value":"research"}]},
            {"name":"remote","type":"http","url":"https://api.example.test/mcp","headers":[{"name":"Authorization","value":"Bearer {env:LAB_TOKEN}"}]}
        ]}});
        (config, message)
    }

    struct ProjectRoot(std::path::PathBuf);

    impl ProjectRoot {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "osd-acp-project-{}",
                osd_core::runtime::random_hex(8)
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn write(&self, directory: &str, config: &Value) -> std::path::PathBuf {
            let cwd = self.0.join(directory);
            std::fs::create_dir_all(cwd.join(".agents")).unwrap();
            std::fs::write(cwd.join(".agents/agent.json"), config.to_string()).unwrap();
            cwd
        }
    }

    impl Drop for ProjectRoot {
        fn drop(&mut self) {
            let path = self.0.canonicalize().unwrap();
            assert_eq!(
                path.parent().unwrap(),
                std::env::temp_dir().canonicalize().unwrap()
            );
            assert!(path
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("osd-acp-project-"));
            std::fs::remove_dir_all(path).unwrap();
        }
    }

    #[test]
    fn project_allowlists_filter_plain_and_credential_connectors_before_any_lookup() {
        let (mut config, mut message) = connector_fixture();
        config["mcp"]["plain"] = json!({"type":"local","command":["plain-tool"]});
        message["params"]["mcpServers"]
            .as_array_mut()
            .unwrap()
            .push(json!({"name":"plain","command":"plain-tool","args":[],"env":[]}));
        let prepared = prepare_mcp_line(
            &message.to_string(),
            |_| Ok(Some(vec!["plain".into()])),
            || Ok(config),
            |_| panic!("disallowed connectors must not read credentials"),
        )
        .unwrap();
        let wire: Value = serde_json::from_str(&prepared.payload).unwrap();
        assert_eq!(
            wire["params"]["mcpServers"],
            json!([{"name":"plain","command":"plain-tool","args":[],"env":[]}])
        );
        assert!(prepared.redactions.is_empty());
        let prepared = prepare_mcp_line(
            &message.to_string(),
            |_| Ok(Some(vec![])),
            || panic!("empty allowlist needs no global credentials"),
            |_| panic!(),
        )
        .unwrap();
        let wire: Value = serde_json::from_str(&prepared.payload).unwrap();
        assert_eq!(wire["params"]["mcpServers"], json!([]));
        let result = prepare_mcp_line(
            &message.to_string(),
            |_| Err("private config contents".into()),
            || panic!(),
            |_| panic!(),
        );
        assert!(result.is_err_and(|error| error == MCP_PROJECT_ERROR));
    }

    #[test]
    fn each_session_uses_its_host_validated_directory_instead_of_process_cwd() {
        let root = ProjectRoot::new();
        let a = root.write("a", &json!({"schemaVersion":1,"connectors":["local"]}));
        let b = root.write("b", &json!({"schemaVersion":1,"connectors":["remote"]}));
        let env = osd_core::Env::new(
            root.0.clone(),
            root.0.clone(),
            Some(root.0.join("docs")),
            "test".into(),
        );
        for (cwd, expected) in [(&a, "local"), (&b, "remote")] {
            let (config, mut message) = connector_fixture();
            message["params"]["cwd"] = json!(cwd.to_string_lossy());
            let prepared = prepare_mcp_line(
                &message.to_string(),
                |request| {
                    let directory = session_directory(&env, request, &a, &b)?;
                    project_connectors(&directory)
                },
                || Ok(config),
                |original| {
                    resolve_credential_with(original, |_, _| Ok("synthetic-session-token".into()))
                },
            )
            .unwrap();
            let wire: Value = serde_json::from_str(&prepared.payload).unwrap();
            assert_eq!(wire["params"]["mcpServers"].as_array().unwrap().len(), 1);
            assert_eq!(wire["params"]["mcpServers"][0]["name"], expected);
        }
        let outside = root.0.join("unregistered");
        std::fs::create_dir(&outside).unwrap();
        assert!(session_directory(&env, &json!({"params":{"cwd":outside}}), &a, &b).is_err());
        assert!(
            session_directory(&env, &json!({"params":{"cwd":"relative/path"}}), &a, &b).is_err()
        );
    }

    #[test]
    fn project_configuration_is_validated_and_invalid_input_fails_closed() {
        let root = ProjectRoot::new();
        assert_eq!(project_connectors(&root.0).unwrap(), None);
        std::fs::create_dir(root.0.join(".agents")).unwrap();
        assert_eq!(project_connectors(&root.0).unwrap(), None);
        let file = root.0.join(".agents/agent.json");
        for valid in [
            json!({"schemaVersion":1}),
            json!({"schemaVersion":1,"connectors":[]}),
            json!({"schemaVersion":1,"connectors":["local"]}),
        ] {
            std::fs::write(&file, valid.to_string()).unwrap();
            let expected = valid["connectors"].as_array().map(|values| {
                values
                    .iter()
                    .map(|value| value.as_str().unwrap().to_string())
                    .collect()
            });
            assert_eq!(project_connectors(&root.0).unwrap(), expected);
        }
        for invalid in [
            "{ invalid private data".into(),
            json!({"schemaVersion":2}).to_string(),
            json!({"schemaVersion":1,"provider":{"private":"secret"}}).to_string(),
            json!({"schemaVersion":1,"connectors":"all"}).to_string(),
            json!({"schemaVersion":1,"connectors":["../outside"]}).to_string(),
            "x".repeat(256 * 1024 + 1),
        ] {
            std::fs::write(&file, invalid).unwrap();
            assert!(project_connectors(&root.0).is_err_and(|error| error == MCP_PROJECT_ERROR));
        }
    }

    #[test]
    fn project_profile_links_and_windows_junctions_are_rejected_before_reading_children() {
        let root = ProjectRoot::new();
        let target = root.0.join("outside");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(
            target.join("agent.json"),
            r#"{"schemaVersion":1,"connectors":[]}"#,
        )
        .unwrap();
        let link = root.0.join(".agents");
        #[cfg(windows)]
        {
            let shell = std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap())
                .join("System32/WindowsPowerShell/v1.0/powershell.exe");
            let result = osd_core::runtime::quiet_command(shell)
                .args([
                    "-NoProfile", "-NonInteractive", "-Command",
                    "New-Item -ItemType Junction -Path $env:OSD_TEST_PROFILE_LINK -Target $env:OSD_TEST_PROFILE_TARGET -ErrorAction Stop | Out-Null",
                ])
                .env("OSD_TEST_PROFILE_LINK", link.to_string_lossy().trim_start_matches(r"\\?\"))
                .env("OSD_TEST_PROFILE_TARGET", target.to_string_lossy().trim_start_matches(r"\\?\"))
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "the test junction must be created: {}",
                String::from_utf8_lossy(&result.stderr)
            );
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(project_connectors(&root.0).is_err_and(|error| error == MCP_PROJECT_ERROR));
        #[cfg(windows)]
        std::fs::remove_dir(&link).unwrap();
        #[cfg(unix)]
        std::fs::remove_file(&link).unwrap();
    }

    #[test]
    fn session_requests_expand_only_configured_mcp_credentials_on_the_host() {
        for method in [
            "session/new",
            "session/load",
            "session/fork",
            "session/resume",
        ] {
            let (config, mut message) = connector_fixture();
            message["method"] = json!(method);
            let frontend = message.to_string();
            let mut requested = Vec::new();
            let prepared = prepare_mcp_line(
                &frontend,
                unrestricted_project,
                || Ok(config),
                |original| {
                    resolve_credential_with(original, |kind, name| {
                        requested.push((kind.to_string(), name.to_string()));
                        Ok(if name.starts_with("OSD_SECRET_") {
                            "synthetic-os-key".into()
                        } else {
                            "synthetic-env-token".into()
                        })
                    })
                },
            )
            .unwrap();
            let wire: Value = serde_json::from_str(&prepared.payload).unwrap();
            assert_eq!(wire["id"], 7);
            assert_eq!(wire["params"]["cwd"], "/workspace");
            assert_eq!(
                wire["params"]["mcpServers"][0]["env"][0]["value"],
                "synthetic-os-key"
            );
            assert_eq!(
                wire["params"]["mcpServers"][0]["env"][1]["value"],
                "research"
            );
            assert_eq!(
                wire["params"]["mcpServers"][1]["headers"][0]["value"],
                "Bearer synthetic-env-token"
            );
            assert_eq!(requested.len(), 2);
            assert!(!requested
                .iter()
                .any(|(_, name)| name == "UNRELATED_PROVIDER"));
            assert!(!frontend.contains("synthetic"));
            assert!(frontend.contains("{env:OSD_SECRET_"));
        }
    }

    #[test]
    fn references_cannot_be_redirected_to_another_command_url_or_environment() {
        let (config, message) = connector_fixture();
        for (pointer, replacement) in [
            ("/params/mcpServers/0/command", json!("attacker")),
            ("/params/mcpServers/0/args", json!(["attacker-script"])),
            ("/params/mcpServers/0/name", json!("unknown")),
            (
                "/params/mcpServers/0/env/0/value",
                json!("{env:UNCONFIGURED_SECRET}"),
            ),
            (
                "/params/mcpServers/0/env/0/value",
                json!("{file:../../outside-private-config}"),
            ),
            (
                "/params/mcpServers/0/env/1/value",
                json!("--require attacker"),
            ),
            (
                "/params/mcpServers/0/env/1",
                message["params"]["mcpServers"][0]["env"][0].clone(),
            ),
            (
                "/params/mcpServers/1/url",
                json!("https://attacker.test/mcp"),
            ),
        ] {
            let mut changed = message.clone();
            *changed.pointer_mut(pointer).unwrap() = replacement;
            let error = prepare_mcp_line(
                &changed.to_string(),
                unrestricted_project,
                || Ok(config.clone()),
                |_| panic!("unauthorized references must not be read"),
            );
            assert!(error.is_err_and(|error| error == MCP_CONFIG_ERROR));
        }
        let mut changed = message.clone();
        changed["params"]["mcpServers"][0]["env"]
            .as_array_mut()
            .unwrap()
            .push(json!({"name":"NODE_OPTIONS","value":"--require attacker"}));
        assert!(prepare_mcp_line(
            &changed.to_string(),
            unrestricted_project,
            || Ok(config.clone()),
            |_| panic!("extra environment must be rejected")
        )
        .is_err());
        let mut disabled = config;
        disabled["mcp"]["local"]["enabled"] = json!(false);
        assert!(prepare_mcp_line(
            &message.to_string(),
            unrestricted_project,
            || Ok(disabled),
            |_| panic!("disabled connectors must not read credentials")
        )
        .is_err());
    }

    #[test]
    fn ordinary_acp_traffic_does_not_read_settings_or_change_framing() {
        for line in [
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}\n",
            "{\"method\":\"session/prompt\",\"params\":{\"text\":\"{file:private}\"}}\n",
            "{\"method\":\"session/new\",\"params\":{\"mcpServers\":[]}}\n",
            "{\"method\":\"session/load\",\"params\":false}\n",
        ] {
            let prepared = prepare_mcp_line(
                line,
                |_| panic!("no forwarded MCP connectors"),
                || panic!("no credential-bearing MCP payload"),
                |_| panic!("no reference to resolve"),
            )
            .unwrap();
            assert_eq!(prepared.payload, line);
            assert!(prepared.redactions.is_empty());
        }
        assert!(prepare_mcp_line("{}\n{}", |_| panic!(), || panic!(), |_| panic!()).is_err());
    }

    #[test]
    fn reference_expansion_preserves_prefixes_and_does_not_interpret_secret_contents() {
        let mut requested = Vec::new();
        let resolved =
            resolve_credential_with("Bearer {env:TOKEN}; {file:token.txt}", |kind, name| {
                requested.push((kind.to_string(), name.to_string()));
                Ok(if kind == "env" {
                    "synthetic-token".into()
                } else {
                    "literal-{env:NEVER_READ}".into()
                })
            })
            .unwrap();
        assert_eq!(
            resolved.value,
            "Bearer synthetic-token; literal-{env:NEVER_READ}"
        );
        assert_eq!(
            requested,
            vec![
                ("env".into(), "TOKEN".into()),
                ("file".into(), "token.txt".into())
            ]
        );
    }

    #[test]
    fn failed_lookups_and_invalid_headers_never_echo_values_or_store_errors() {
        let (config, message) = connector_fixture();
        let error = prepare_mcp_line(
            &message.to_string(),
            unrestricted_project,
            || Ok(config.clone()),
            |_| Err("private-path secret-value".into()),
        );
        assert!(error.is_err_and(|error| error == MCP_CREDENTIAL_ERROR));
        let mut remote = message;
        remote["params"]["mcpServers"]
            .as_array_mut()
            .unwrap()
            .remove(0);
        let error = prepare_mcp_line(
            &remote.to_string(),
            unrestricted_project,
            || Ok(config),
            |original| {
                resolve_credential_with(original, |_, _| Ok("synthetic\r\nInjected: header".into()))
            },
        );
        assert!(error.is_err_and(|error| error == MCP_CREDENTIAL_ERROR));
        for reference in ["{env:}", "{file:}", "{env:UNCLOSED"] {
            assert!(
                resolve_credential_with(reference, |_, _| panic!("malformed reference")).is_err()
            );
        }
    }

    #[test]
    fn generic_files_are_relative_to_host_config_and_reads_are_bounded() {
        let root = std::env::temp_dir().join(format!(
            "osd-acp-credentials-{}",
            osd_core::runtime::random_hex(8)
        ));
        let env = osd_core::Env::new(root.clone(), root.clone(), None, "test".into());
        let profile = osd_core::agent_config::profile_dir(&env);
        std::fs::create_dir_all(&profile).unwrap();
        std::fs::write(profile.join("token.txt"), "  synthetic-file-token\n").unwrap();
        assert_eq!(
            resolve_credential(&env, "Bearer {file:token.txt}")
                .unwrap()
                .value,
            "Bearer synthetic-file-token"
        );
        std::fs::write(
            profile.join("token.txt"),
            vec![b'x'; MAX_CREDENTIAL_BYTES as usize + 1],
        )
        .unwrap();
        assert!(resolve_credential(&env, "{file:token.txt}")
            .is_err_and(|error| error == MCP_CREDENTIAL_ERROR));
        assert!(resolve_credential(&env, "{file:missing-private-file}")
            .is_err_and(|error| error == MCP_CREDENTIAL_ERROR));
        assert_eq!(
            resolve_credential(&env, "{env:OSD_ACP_MISSING_VARIABLE_13F7A9C2}")
                .unwrap()
                .value,
            ""
        );
        assert!(resolve_credential(&env, "{env:OSD_SECRET_malformed}")
            .is_err_and(|error| error == MCP_CREDENTIAL_ERROR));
        std::fs::remove_file(profile.join("token.txt")).unwrap();
        std::fs::remove_dir(&profile).unwrap();
        std::fs::remove_dir(root.join("runtime")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn child_echoes_are_redacted_before_reaching_the_frontend() {
        let (config, message) = connector_fixture();
        let prepared = prepare_mcp_line(
            &message.to_string(),
            unrestricted_project,
            || Ok(config),
            |original| {
                resolve_credential_with(original, |_, _| Ok("synthetic-\"private\"-value".into()))
            },
        )
        .unwrap();
        let mut redactions = SecretRedactions::default();
        redactions.remember(prepared.redactions);
        let response = json!({"jsonrpc":"2.0","id":7,"error":{"code":-32603,"message":"Rejected synthetic-\"private\"-value","data":{"request":serde_json::from_str::<Value>(&prepared.payload).unwrap()}}});
        let safe = redactions.line(&response.to_string());
        let parsed: Value = serde_json::from_str(&safe).unwrap();
        assert_eq!(parsed["id"], 7);
        assert_eq!(parsed["error"]["message"], "Rejected [redacted]");
        assert!(!safe.contains("synthetic"));
        assert_eq!(
            redactions.text("failed: synthetic-\"private\"-value"),
            "failed: [redacted]"
        );
    }

    #[test]
    fn ordinary_mcp_parameters_do_not_scrub_scientific_output_or_mime_types() {
        let (mut config, mut message) = connector_fixture();
        config["mcp"]["local"]["environment"]["PORT"] = json!("{env:PUBLIC_PORT}");
        message["params"]["mcpServers"][0]["env"]
            .as_array_mut()
            .unwrap()
            .push(json!({"name":"PORT","value":"{env:PUBLIC_PORT}"}));
        config["mcp"]["remote"]["headers"]["Accept"] = json!("{env:PUBLIC_MIME}");
        message["params"]["mcpServers"][1]["headers"]
            .as_array_mut()
            .unwrap()
            .push(json!({"name":"Accept","value":"{env:PUBLIC_MIME}"}));
        let prepared = prepare_mcp_line(
            &message.to_string(),
            unrestricted_project,
            || Ok(config),
            |original| {
                resolve_credential_with(original, |_, name| {
                    Ok(match name {
                        "PUBLIC_PORT" => "1",
                        "PUBLIC_MIME" => "application/json",
                        _ => "synthetic-private-key",
                    }
                    .into())
                })
            },
        )
        .unwrap();
        let mut redactions = SecretRedactions::default();
        redactions.remember(prepared.redactions);
        let safe = redactions.line(&json!({"jsonrpc":"2.0","id":"rpc1","result":{"content":{"mimeType":"application/json","text":"Energy -1.5; key synthetic-private-key"}}}).to_string());
        let parsed: Value = serde_json::from_str(&safe).unwrap();
        assert_eq!(parsed["id"], "rpc1");
        assert_eq!(parsed["result"]["content"]["mimeType"], "application/json");
        assert_eq!(
            parsed["result"]["content"]["text"],
            "Energy -1.5; key [redacted]"
        );
    }

    #[test]
    fn credential_redaction_preserves_protocol_identifiers_and_enums() {
        let mut redactions = SecretRedactions::default();
        redactions.remember(vec!["1".into(), "text".into()]);
        let safe = redactions.line(&json!({"jsonrpc":"2.0","id":"rpc1","params":{"sessionId":"session1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"key 1"}}}}).to_string());
        let parsed: Value = serde_json::from_str(&safe).unwrap();
        assert_eq!(parsed["id"], "rpc1");
        assert_eq!(parsed["params"]["sessionId"], "session1");
        assert_eq!(parsed["params"]["update"]["content"]["type"], "text");
        assert_eq!(
            parsed["params"]["update"]["content"]["text"],
            "key [redacted]"
        );
    }

    #[test]
    fn an_immediately_exiting_registered_child_reports_its_stderr() {
        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg("--definitely-invalid-acp-test-flag")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stderr = child.stderr.take().unwrap();
        let stdin = child.stdin.take().unwrap();
        let stderr_reader = std::thread::spawn(move || {
            let mut detail = String::new();
            BufReader::new(stderr).read_to_string(&mut detail).unwrap();
            detail
        });

        let state = AcpState::default();
        state.agents.lock().unwrap().insert(
            "instant".into(),
            Agent {
                child,
                stdin,
                logged_stdin: false,
                redactions: Default::default(),
                cwd: std::env::temp_dir(),
            },
        );

        let how = state.wait_for_exit("instant").unwrap();
        let detail = stderr_reader.join().unwrap();
        let reason = exit_reason("test-agent", &how, detail.trim());

        assert!(reason.starts_with("test-agent exited (code "));
        assert!(!detail.trim().is_empty());
        assert!(reason.contains(detail.trim()));
        assert!(!state.agents.lock().unwrap().contains_key("instant"));
    }

    #[test]
    fn whole_lines_are_taken_and_a_partial_one_is_kept() {
        // The read boundary lands mid-message routinely; handing half a JSON
        // object to the peer would drop the message it belongs to.
        let mut buf = String::from("{\"a\":1}\n{\"b\":2}\n{\"c\":");
        assert_eq!(take_lines(&mut buf), vec!["{\"a\":1}", "{\"b\":2}"]);
        assert_eq!(buf, "{\"c\":");
        // The rest arrives and completes it.
        buf.push_str("3}\n");
        assert_eq!(take_lines(&mut buf), vec!["{\"c\":3}"]);
        assert!(buf.is_empty());
    }

    #[test]
    fn carriage_returns_are_stripped_and_nothing_is_taken_without_a_newline() {
        let mut buf = String::from("{\"a\":1}\r\n");
        assert_eq!(take_lines(&mut buf), vec!["{\"a\":1}"]);
        let mut partial = String::from("no newline yet");
        assert!(take_lines(&mut partial).is_empty());
        assert_eq!(partial, "no newline yet");
    }
}
