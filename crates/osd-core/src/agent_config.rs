//! Application-owned agent configuration. Runtime-specific discovery is disabled.
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::env::Env;
use crate::runtime::{tighten_private, write_atomic};

pub const SCHEMA_VERSION: u64 = 1;

pub fn profile_dir(env: &Env) -> PathBuf {
    env.data_dir().join("runtime").join("agent")
}

pub fn config_file(env: &Env) -> PathBuf {
    profile_dir(env).join("agent.json")
}

/// Import the previous private profile once. User resources are copied, never moved.
pub fn initialize(env: &Env) -> Result<PathBuf, String> {
    let destination = profile_dir(env);
    let target = config_file(env);
    let legacy = env.data_dir().join("runtime/xdg-config/opencode");
    if target.exists() {
        finish_legacy_credentials(env, &legacy, &destination)?;
        return Ok(target);
    }
    std::fs::create_dir_all(&destination).map_err(|e| e.to_string())?;
    tighten_private(&destination);
    let mut config = json!({ "schemaVersion": SCHEMA_VERSION });
    for name in ["opencode.json", "opencode.jsonc"] {
        let source = legacy.join(name);
        if !source.is_file() {
            continue;
        }
        let text = std::fs::read_to_string(&source).map_err(|e| e.to_string())?;
        let parsed = crate::opencode_config::read_config(&text)
            .ok_or_else(|| format!("legacy configuration is unreadable: {}", source.display()))?;
        let merged = crate::opencode_config::patch_config(&config.to_string(), &parsed)?;
        config = serde_json::from_str(&merged).map_err(|e| e.to_string())?;
    }
    config["schemaVersion"] = json!(SCHEMA_VERSION);
    protect_secrets(env, &mut config)?;
    for (old, new) in [
        ("agent", "agents"),
        ("agents", "agents"),
        ("command", "commands"),
        ("commands", "commands"),
        ("skills", "skills"),
        ("MEMORY.md", "MEMORY.md"),
    ] {
        copy_missing(&legacy.join(old), &destination.join(new), &mut Vec::new())?;
    }
    write_atomic(
        &target,
        &serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?,
    )?;
    tighten_private(&target);
    // Only redact the old files after the new profile has committed. If a
    // cleanup write fails, the next read retries it without importing again.
    finish_legacy_credentials(env, &legacy, &destination)?;
    Ok(target)
}

fn finish_legacy_credentials(env: &Env, legacy: &Path, destination: &Path) -> Result<(), String> {
    let marker = destination.join("credential-migration.json");
    if marker.exists() {
        return Ok(());
    }
    redact_legacy_credentials(legacy, &mut |id, value| {
        crate::secrets::write(env, id, value).map_err(|e| e.to_string())
    })?;
    write_atomic(
        &marker,
        &json!({"schemaVersion":1,"legacyCredentialsProtected":true}).to_string(),
    )?;
    tighten_private(&marker);
    Ok(())
}

fn redact_legacy_credentials(
    legacy: &Path,
    store: &mut impl FnMut(&str, &str) -> Result<(), String>,
) -> Result<(), String> {
    for name in ["opencode.json", "opencode.jsonc"] {
        let path = legacy.join(name);
        if !path.is_file() {
            continue;
        }
        reject_link(&path)?;
        let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let mut config = crate::opencode_config::read_config(&text)
            .ok_or("legacy configuration could not be protected")?;
        let before = config.clone();
        protect_secrets_with(&mut config, store)?;
        if config != before {
            write_atomic(
                &path,
                &serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?,
            )?;
            tighten_private(&path);
        }
    }
    Ok(())
}

pub fn read(env: &Env) -> Result<Value, String> {
    let path = initialize(env)?;
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let config =
        crate::opencode_config::read_config(&text).ok_or("agent configuration is invalid JSON")?;
    if config.get("schemaVersion").and_then(Value::as_u64) != Some(SCHEMA_VERSION) {
        return Err("unsupported agent configuration schemaVersion".into());
    }
    Ok(config)
}

/// Public connector options remain plain settings and must not censor tool output.
pub fn public_connector_parameter(field: &str, name: &str) -> bool {
    if field == "headers" {
        return matches!(
            name.to_ascii_lowercase().as_str(),
            "accept" | "accept-encoding" | "accept-language" | "content-type" | "user-agent"
        );
    }
    let name = name.to_ascii_uppercase();
    if [
        "KEY",
        "TOKEN",
        "SECRET",
        "PASS",
        "AUTH",
        "CREDENTIAL",
        "COOKIE",
    ]
    .iter()
    .any(|part| name.contains(part))
    {
        return false;
    }
    matches!(
        name.as_str(),
        "PATH"
            | "PYTHONPATH"
            | "NODE_PATH"
            | "HOME"
            | "USERPROFILE"
            | "TEMP"
            | "TMP"
            | "TMPDIR"
            | "LANG"
            | "LC_ALL"
            | "TZ"
            | "MODE"
            | "NODE_ENV"
            | "DEBUG"
            | "PORT"
            | "HOST"
    ) || [
        "_PORT",
        "_HOST",
        "_PATH",
        "_DIR",
        "_LEVEL",
        "_MODE",
        "_TIMEOUT",
        "_TIMEOUT_MS",
        "_SECONDS",
        "_THREADS",
        "_BYTES",
        "_ENABLED",
    ]
    .iter()
    .any(|suffix| name.ends_with(suffix))
}

/// Replace private credentials with OS-store references before writing settings.
/// Environment references already supplied by the user remain references.
pub fn protect_secrets(env: &Env, config: &mut Value) -> Result<(), String> {
    protect_secrets_with(config, &mut |id, value| {
        crate::secrets::write(env, id, value).map_err(|e| e.to_string())
    })
}

fn protect_secrets_with(
    config: &mut Value,
    store: &mut impl FnMut(&str, &str) -> Result<(), String>,
) -> Result<(), String> {
    fn walk(
        value: &mut Value,
        sensitive: bool,
        store: &mut impl FnMut(&str, &str) -> Result<(), String>,
    ) -> Result<(), String> {
        match value {
            Value::String(secret) if sensitive && !secret.is_empty() => {
                if secret.contains("{env:") || secret.contains("{file:") {
                    return Ok(());
                }
                // A fresh account keeps the previously saved reference valid
                // if a later credential or the config write fails.
                let variable = format!("OSD_SECRET_{}", crate::runtime::random_hex(32));
                store(&variable, secret)?;
                *secret = format!("{{env:{variable}}}");
            }
            Value::Object(object) => {
                for (key, value) in object {
                    let label: String = key
                        .chars()
                        .filter(|c| c.is_ascii_alphanumeric())
                        .map(|c| c.to_ascii_lowercase())
                        .collect();
                    if !sensitive && matches!(label.as_str(), "environment" | "headers") {
                        if let Some(parameters) = value.as_object_mut() {
                            for (name, value) in parameters {
                                walk(value, !public_connector_parameter(&label, name), store)?;
                            }
                            continue;
                        }
                    }
                    let private = sensitive
                        || [
                            "apikey",
                            "secretkey",
                            "secretaccesskey",
                            "accesskeyid",
                            "accesstoken",
                            "refreshtoken",
                            "sessiontoken",
                            "apitoken",
                            "clientsecret",
                            "privatekey",
                            "passphrase",
                            "credentials",
                            "password",
                            "token",
                            "authorization",
                            "environment",
                            "headers",
                        ]
                        .contains(&label.as_str());
                    walk(value, private, store)?;
                }
            }
            Value::Array(array) => {
                for value in array {
                    walk(value, sensitive, store)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    walk(config, false, store)
}

pub fn secret_environment(env: &Env, config: &Value) -> Result<Vec<(String, String)>, String> {
    fn collect(value: &Value, variables: &mut std::collections::BTreeSet<String>) {
        match value {
            Value::String(value) => {
                if let Some(name) = value
                    .strip_prefix("{env:OSD_SECRET_")
                    .and_then(|v| v.strip_suffix('}'))
                {
                    if name.len() == 64 && name.bytes().all(|b| b.is_ascii_hexdigit()) {
                        variables.insert(format!("OSD_SECRET_{name}"));
                    }
                }
            }
            Value::Object(object) => {
                for value in object.values() {
                    collect(value, variables);
                }
            }
            Value::Array(array) => {
                for value in array {
                    collect(value, variables);
                }
            }
            _ => {}
        }
    }
    let mut variables = std::collections::BTreeSet::new();
    collect(config, &mut variables);
    variables
        .into_iter()
        .map(|name| {
            let secret = crate::secrets::read(env, &name)
                .map_err(|e| e.to_string())?
                .ok_or("a configured credential is missing from the OS credential store")?;
            Ok((name, secret))
        })
        .collect()
}

/// Settings writes and startup both converge existing private settings on references.
pub fn protect_existing(env: &Env) -> Result<(), String> {
    let path = initialize(env)?;
    let mut config = read(env)?;
    let before = config.clone();
    protect_secrets(env, &mut config)?;
    if config != before {
        write_atomic(
            &path,
            &serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?,
        )?;
        tighten_private(&path);
    }
    Ok(())
}

/// Projects may select models and restrict configured connectors, never install tools.
pub fn validate_project(config: &Value) -> Result<(), String> {
    let object = config
        .as_object()
        .ok_or("agent configuration must be an object")?;
    if config.get("schemaVersion").and_then(Value::as_u64) != Some(SCHEMA_VERSION) {
        return Err("project agent configuration needs schemaVersion 1".into());
    }
    for key in object.keys() {
        if !["schemaVersion", "model", "agent", "connectors"].contains(&key.as_str()) {
            return Err(format!(
                "project setting {key} is managed in application Settings"
            ));
        }
    }
    let valid_model = |v: &Value| {
        v.as_str().is_some_and(|s| {
            s.len() <= 256
                && s.split_once('/')
                    .is_some_and(|(p, m)| !p.is_empty() && !m.is_empty())
                && !s.chars().any(char::is_whitespace)
        })
    };
    if config.get("model").is_some_and(|v| !valid_model(v)) {
        return Err("model must be provider/model".into());
    }
    if let Some(agents) = config.get("agent") {
        for (id, settings) in agents.as_object().ok_or("agent must be an object")? {
            if !valid_name(id) {
                return Err("invalid project agent id".into());
            }
            for (key, value) in settings
                .as_object()
                .ok_or("agent settings must be an object")?
            {
                if key == "model" && valid_model(value) {
                    continue;
                }
                if key == "variant"
                    && value
                        .as_str()
                        .is_some_and(|s| !s.is_empty() && s.len() <= 128)
                {
                    continue;
                }
                return Err("project agents may only override model and variant".into());
            }
        }
    }
    if let Some(connectors) = config.get("connectors") {
        let list = connectors
            .as_array()
            .ok_or("connectors must be a list of configured connector ids")?;
        if list.len() > 100 || list.iter().any(|v| !v.as_str().is_some_and(valid_name)) {
            return Err("invalid connector ids".into());
        }
    }
    Ok(())
}

fn valid_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_'))
}

/// Legacy input is read only before the migration marker exists.
pub fn migrate_project(workspace: &Path) -> Result<(), String> {
    let legacy = workspace.join(".opencode");
    let destination = workspace.join(".agents");
    let marker = destination.join("migration.json");
    // Check roots before probing children: an ordinary child beneath a junction
    // is still outside this workspace even when the child itself is not a link.
    reject_link(&destination)?;
    reject_link(&marker)?;
    if marker.exists() {
        return Ok(());
    }
    for path in [
        &legacy,
        &workspace.join("opencode.json"),
        &workspace.join("opencode.jsonc"),
    ] {
        reject_link(path)?;
    }
    if !legacy.is_dir()
        && !workspace.join("opencode.json").is_file()
        && !workspace.join("opencode.jsonc").is_file()
    {
        return Ok(());
    }
    let mut conflicts = Vec::new();
    for (old, new) in [
        ("skills", "skills"),
        ("agent", "agents"),
        ("agents", "agents"),
        ("command", "commands"),
        ("commands", "commands"),
    ] {
        copy_missing(&legacy.join(old), &destination.join(new), &mut conflicts)?;
    }
    let mut project = json!({ "schemaVersion": SCHEMA_VERSION });
    let mut unsupported = Vec::new();
    for source in [
        workspace.join("opencode.json"),
        workspace.join("opencode.jsonc"),
        legacy.join("opencode.json"),
        legacy.join("opencode.jsonc"),
    ] {
        if !source.is_file() {
            continue;
        }
        let text = std::fs::read_to_string(&source).map_err(|e| e.to_string())?;
        let Some(config) = crate::opencode_config::read_config(&text).filter(Value::is_object)
        else {
            unsupported.push(format!(
                "unreadable:{}",
                source.strip_prefix(workspace).unwrap_or(&source).display()
            ));
            continue;
        };
        for (key, value) in config.as_object().expect("object checked above") {
            match key.as_str() {
                "model" => {
                    if validate_project(&json!({"schemaVersion": SCHEMA_VERSION, "model": value}))
                        .is_ok()
                    {
                        project["model"] = value.clone();
                    } else {
                        unsupported.push("model".into());
                    }
                }
                "agent" => {
                    if let Some(agents) = value.as_object() {
                        for (id, settings) in agents {
                            for field in ["model", "variant"] {
                                if let Some(v) = settings.get(field) {
                                    let mut candidate =
                                        json!({"schemaVersion": SCHEMA_VERSION, "agent": {}});
                                    candidate["agent"][id][field] = v.clone();
                                    if validate_project(&candidate).is_ok() {
                                        project["agent"][id][field] = v.clone();
                                    } else {
                                        unsupported.push(format!("agent.{id}.{field}"));
                                    }
                                }
                            }
                            if settings.as_object().is_some_and(|s| {
                                s.keys()
                                    .any(|k| !["model", "variant"].contains(&k.as_str()))
                            }) {
                                unsupported.push(format!("agent.{id}"));
                            }
                        }
                    }
                }
                "$schema" => {}
                _ => unsupported.push(key.clone()),
            }
        }
    }
    validate_project(&project)?;
    let target = destination.join("agent.json");
    reject_link(&target)?;
    if !target.exists() {
        write_atomic(
            &target,
            &serde_json::to_string_pretty(&project).map_err(|e| e.to_string())?,
        )?;
    } else {
        conflicts.push("agent.json".into());
    }
    write_atomic(&marker, &json!({"schemaVersion": SCHEMA_VERSION, "source": ".opencode", "conflicts": conflicts, "settingsToReview": unsupported}).to_string())
}

fn reject_link(path: &Path) -> Result<(), String> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    if metadata.file_type().is_symlink() {
        return Err("configuration migration does not follow symbolic links".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("configuration migration does not follow reparse points".into());
        }
    }
    Ok(())
}

fn copy_missing(source: &Path, target: &Path, conflicts: &mut Vec<String>) -> Result<(), String> {
    if let Ok(meta) = std::fs::symlink_metadata(target) {
        if meta.file_type().is_symlink() {
            return Err("configuration target must not be a symbolic link".into());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 {
                return Err("configuration target must not be a reparse point".into());
            }
        }
    }
    let metadata = match std::fs::symlink_metadata(source) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    };
    if metadata.file_type().is_symlink() {
        return Err("configuration migration does not follow symbolic links".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("configuration migration does not follow reparse points".into());
        }
    }
    if metadata.is_dir() {
        std::fs::create_dir_all(target).map_err(|e| e.to_string())?;
        for entry in std::fs::read_dir(source).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            copy_missing(&entry.path(), &target.join(entry.file_name()), conflicts)?;
        }
    } else if metadata.is_file() {
        if target.exists() {
            conflicts.push(
                target
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
            );
        } else {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::copy(source, target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "osd-agent-config-{}",
            crate::runtime::random_hex(8)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn private_profile_imports_both_configs_once_and_preserves_user_resources() {
        let root = root();
        let legacy = root.join("runtime/xdg-config/opencode");
        std::fs::create_dir_all(legacy.join("agent")).unwrap();
        std::fs::write(
            legacy.join("opencode.json"),
            r#"{"model":"a/old","mcp":{"local":{}}}"#,
        )
        .unwrap();
        std::fs::write(
            legacy.join("opencode.jsonc"),
            "{ // comment\n \"model\":\"b/new\" }",
        )
        .unwrap();
        std::fs::write(legacy.join("agent/custom.md"), "User's role").unwrap();
        let env = Env::new(
            root.clone(),
            root.clone(),
            Some(root.clone()),
            "test".into(),
        );
        assert_eq!(read(&env).unwrap()["model"], "b/new");
        assert_eq!(
            std::fs::read_to_string(profile_dir(&env).join("agents/custom.md")).unwrap(),
            "User's role"
        );
        std::fs::write(legacy.join("opencode.jsonc"), "invalid").unwrap();
        assert_eq!(read(&env).unwrap()["model"], "b/new");
        assert!(legacy.join("agent/custom.md").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn projects_cannot_enable_processes_or_expand_permissions() {
        for key in [
            "permission",
            "permissions",
            "mcp",
            "plugins",
            "provider",
            "apiKey",
        ] {
            let mut config = json!({"schemaVersion":1});
            config[key] = json!({});
            assert!(validate_project(&config).is_err(), "{key}");
        }
        assert!(validate_project(&json!({"schemaVersion":1,"model":"p/m","agent":{"research":{"model":"p/fast"}},"connectors":["paper-search"]})).is_ok());
    }

    #[test]
    fn credentials_become_references_and_repeated_writes_preserve_existing_accounts() {
        let mut config = json!({"schemaVersion":1,"provider":{"lab":{"options":{"apiKey":"synthetic-key"}}},"mcp":{"lab":{"environment":{"TOKEN":"synthetic-token","FROM_ENV":"{env:LAB_KEY}"}}},"model":"lab/model"});
        let mut saved = std::collections::BTreeMap::new();
        protect_secrets_with(&mut config, &mut |id, value| {
            saved.insert(id.to_string(), value.to_string());
            Ok(())
        })
        .unwrap();
        let reference = config["provider"]["lab"]["options"]["apiKey"].clone();
        assert!(reference.as_str().unwrap().starts_with("{env:OSD_SECRET_"));
        assert!(!config.to_string().contains("synthetic"));
        assert_eq!(saved.len(), 2);
        assert_eq!(
            config["mcp"]["lab"]["environment"]["FROM_ENV"],
            "{env:LAB_KEY}"
        );
        protect_secrets_with(&mut config, &mut |_, _| {
            panic!("existing references must not be rewritten")
        })
        .unwrap();
        config["provider"]["lab"]["options"]["apiKey"] = json!("replacement-key");
        protect_secrets_with(&mut config, &mut |id, value| {
            assert!(!saved.contains_key(id));
            saved.insert(id.to_string(), value.to_string());
            Ok(())
        })
        .unwrap();
        assert_ne!(config["provider"]["lab"]["options"]["apiKey"], reference);
        assert!(saved.values().any(|value| value == "synthetic-key"));
    }

    #[test]
    fn supported_credential_fields_are_protected_including_provider_specific_names() {
        for field in [
            "apiKey",
            "api_key",
            "secretKey",
            "secret_key",
            "secretAccessKey",
            "accessKeyId",
            "accessToken",
            "refresh_token",
            "sessionToken",
            "apiToken",
            "clientSecret",
            "privateKey",
            "passphrase",
            "password",
            "token",
            "authorization",
        ] {
            let mut config = json!({"provider":{"lab":{"options":{}}}});
            config["provider"]["lab"]["options"][field] = json!("synthetic-private-value");
            let mut stored = false;
            protect_secrets_with(&mut config, &mut |_, value| {
                stored = value == "synthetic-private-value";
                Ok(())
            })
            .unwrap();
            assert!(stored, "{field}");
            assert!(
                !config.to_string().contains("synthetic-private-value"),
                "{field}"
            );
        }
        let mut template = json!({"headers":{"Authorization":"Bearer {env:LAB_TOKEN}"}});
        protect_secrets_with(&mut template, &mut |_, _| {
            panic!("explicit substitutions must stay templates")
        })
        .unwrap();
        assert_eq!(
            template["headers"]["Authorization"],
            "Bearer {env:LAB_TOKEN}"
        );
    }

    #[test]
    fn public_connector_options_do_not_require_a_credential_service() {
        let mut config = json!({"mcp":{"local":{"environment":{"PATH":"/tools","PORT":"1","LOG_LEVEL":"debug"}},"remote":{"headers":{"Accept":"application/json"}}}});
        let before = config.clone();
        protect_secrets_with(&mut config, &mut |_, _| {
            panic!("public options must not be stored as credentials")
        })
        .unwrap();
        assert_eq!(config, before);
        assert!(!public_connector_parameter("environment", "API_KEY"));
        assert!(!public_connector_parameter("headers", "Authorization"));
    }

    #[test]
    fn legacy_credential_cleanup_preserves_settings_and_retries_without_rewriting_references() {
        let root = root();
        let path = root.join("opencode.jsonc");
        std::fs::write(&path, r#"{"provider":{"lab":{"options":{"secretAccessKey":"legacy-private"}}},"model":"lab/m"}"#).unwrap();
        let mut saved = std::collections::BTreeMap::new();
        redact_legacy_credentials(&root, &mut |id, value| {
            saved.insert(id.to_string(), value.to_string());
            Ok(())
        })
        .unwrap();
        let result = std::fs::read_to_string(&path).unwrap();
        assert!(!result.contains("legacy-private"));
        assert_eq!(saved.len(), 1);
        assert_eq!(
            serde_json::from_str::<Value>(&result).unwrap()["model"],
            "lab/m"
        );
        redact_legacy_credentials(&root, &mut |_, _| {
            panic!("retry must not replace a stored credential")
        })
        .unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), result);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn project_migration_is_idempotent_and_reports_unsupported_settings() {
        let root = root();
        std::fs::create_dir_all(root.join(".opencode/skills/mine")).unwrap();
        std::fs::write(root.join(".opencode/skills/mine/SKILL.md"), "original").unwrap();
        std::fs::write(
            root.join(".opencode/opencode.json"),
            r#"{"model":"p/m","mcp":{"x":{"environment":{"KEY":"do-not-copy"}}}}"#,
        )
        .unwrap();
        migrate_project(&root).unwrap();
        std::fs::write(root.join(".agents/skills/mine/SKILL.md"), "my edits").unwrap();
        migrate_project(&root).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join(".agents/skills/mine/SKILL.md")).unwrap(),
            "my edits"
        );
        let config = std::fs::read_to_string(root.join(".agents/agent.json")).unwrap();
        assert!(!config.contains("do-not-copy"));
        assert_eq!(
            serde_json::from_str::<Value>(&config).unwrap()["model"],
            "p/m"
        );
        let report = std::fs::read_to_string(root.join(".agents/migration.json")).unwrap();
        assert!(report.contains("mcp"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn malformed_legacy_settings_do_not_block_the_new_profile() {
        let root = root();
        std::fs::create_dir_all(root.join(".opencode")).unwrap();
        std::fs::write(root.join("opencode.json"), "{ malformed").unwrap();
        std::fs::write(
            root.join(".opencode/opencode.json"),
            r#"{"model":false,"agent":{"x":{"model":"bad","variant":null}}}"#,
        )
        .unwrap();
        migrate_project(&root).unwrap();
        let project: Value = serde_json::from_str(
            &std::fs::read_to_string(root.join(".agents/agent.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(project, json!({"schemaVersion":1}));
        let report = std::fs::read_to_string(root.join(".agents/migration.json")).unwrap();
        assert!(report.contains("unreadable:opencode.json"));
        assert!(report.contains("agent.x.model"));
        std::fs::write(root.join("opencode.json"), "{ changed after migration").unwrap();
        migrate_project(&root).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join(".agents/migration.json")).unwrap(),
            report
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn migration_refuses_linked_roots_before_writing_outside_the_workspace() {
        let outside = root();
        let root = root();
        std::fs::create_dir_all(root.join(".opencode")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join(".agents")).unwrap();
        assert!(migrate_project(&root).is_err());
        assert!(!outside.join("agent.json").exists());
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
    }
}
