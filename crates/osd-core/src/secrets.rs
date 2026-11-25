//! Host credentials live only in the operating system credential store.
use crate::env::Env;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SecretErrorCode {
    InvalidId,
    CredentialStoreUnavailable,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct SecretError {
    pub code: SecretErrorCode,
}

impl std::fmt::Display for SecretError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self.code {
            SecretErrorCode::InvalidId => "The credential identifier is invalid.",
            SecretErrorCode::CredentialStoreUnavailable => {
                "The operating system credential store is unavailable."
            }
        })
    }
}
impl std::error::Error for SecretError {}

fn unavailable() -> SecretError {
    SecretError {
        code: SecretErrorCode::CredentialStoreUnavailable,
    }
}

// Keep independent --state-dir instances independent without putting a path or
// credential into the OS account label. Never derive Debug for secret values.
pub(crate) fn scope(env: &Env) -> String {
    use std::path::{Component, PathBuf};
    let absolute = if env.data_dir().is_absolute() {
        env.data_dir().to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_default()
            .join(env.data_dir())
    };
    let mut normalized = PathBuf::new();
    for part in absolute.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            _ => normalized.push(part.as_os_str()),
        }
    }
    // Resolve the existing parent as well, so a new profile below /tmp (a
    // symlink on macOS) keeps the same identity after its directory is created.
    let mut ancestor = normalized.clone();
    let mut tail = Vec::new();
    let resolved = loop {
        if let Ok(mut path) = ancestor.canonicalize() {
            for part in tail.iter().rev() {
                path.push(part);
            }
            break path;
        }
        if let Some(name) = ancestor.file_name() {
            tail.push(name.to_os_string());
        }
        if !ancestor.pop() {
            break normalized;
        }
    };
    #[cfg(windows)]
    let identity = {
        let raw = resolved.to_string_lossy();
        let path = raw
            .strip_prefix(r"\\?\UNC\")
            .map(|rest| format!(r"\\{rest}"))
            .unwrap_or_else(|| raw.strip_prefix(r"\\?\").unwrap_or(&raw).to_string());
        path.replace('\\', "/").to_lowercase()
    };
    #[cfg(not(windows))]
    let identity = resolved.to_string_lossy().into_owned();
    format!("{:x}", Sha256::digest(identity.as_bytes()))
}

fn account(env: &Env, id: &str) -> Result<String, SecretError> {
    if id.is_empty() || id.len() > 1024 || id.chars().any(char::is_control) {
        return Err(SecretError {
            code: SecretErrorCode::InvalidId,
        });
    }
    Ok(format!(
        "{}.{:x}",
        scope(env),
        Sha256::digest(id.as_bytes())
    ))
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
fn entry(env: &Env, id: &str) -> Result<keyring::Entry, SecretError> {
    keyring::Entry::new("com.ai4s.workbench.secrets", &account(env, id)?).map_err(|_| unavailable())
}

/// Read one credential in this host profile. A missing entry is not an error.
/// Callers must never log, serialize, or persist the returned secret.
pub fn read(env: &Env, id: &str) -> Result<Option<String>, SecretError> {
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
        match entry(env, id)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(unavailable()),
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        account(env, id)?;
        Err(unavailable())
    }
}

/// Write only to the OS credential store; there is no file fallback.
pub fn write(env: &Env, id: &str, secret: &str) -> Result<(), SecretError> {
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
        entry(env, id)?
            .set_password(secret)
            .map_err(|_| unavailable())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        account(env, id)?;
        let _ = secret;
        Err(unavailable())
    }
}

/// Deleting an absent credential succeeds, making migration retries idempotent.
pub fn delete(env: &Env, id: &str) -> Result<(), SecretError> {
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
        match entry(env, id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(unavailable()),
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        account(env, id)?;
        Err(unavailable())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires an unlocked host OS credential store"]
    fn host_store_round_trip_does_not_create_a_plaintext_file() {
        let root = std::env::temp_dir().join(format!(
            "osd-credential-check-{}",
            crate::runtime::random_hex(8)
        ));
        let env = Env::new(root.clone(), root.clone(), None, "test".into());
        let id = "verification.temporary";
        let value = crate::runtime::random_hex(32);
        struct Cleanup(Env);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = delete(&self.0, "verification.temporary");
            }
        }
        let _cleanup = Cleanup(env.clone());
        assert!(read(&env, id).unwrap().is_none());
        write(&env, id, &value).unwrap();
        assert!(read(&env, id).unwrap().as_deref() == Some(value.as_str()));
        delete(&env, id).unwrap();
        assert!(read(&env, id).unwrap().is_none());
        assert!(!root.exists());
    }
    #[test]
    fn credential_scopes_are_stable_and_isolated() {
        let env = |path: &str| Env::new(path.into(), ".".into(), None, "test".into());
        assert_eq!(scope(&env("instance-a")), scope(&env("instance-a")));
        assert_ne!(scope(&env("instance-a")), scope(&env("instance-b")));
        assert!(!scope(&env("instance-a")).contains("instance-a"));
        assert_eq!(
            account(&env("instance-a"), "provider.one").unwrap(),
            account(&env("instance-a"), "provider.one").unwrap()
        );
        assert_ne!(
            account(&env("instance-a"), "provider.one").unwrap(),
            account(&env("instance-a"), "provider.two").unwrap()
        );
        assert_ne!(
            account(&env("instance-a"), "provider.one").unwrap(),
            account(&env("instance-b"), "provider.one").unwrap()
        );
        assert!(!account(&env("instance-a"), "provider.one")
            .unwrap()
            .contains("provider.one"));
    }

    #[test]
    fn equivalent_profile_paths_use_the_same_credential_namespace() {
        let root =
            std::env::temp_dir().join(format!("osd-scope-{}", crate::runtime::random_hex(8)));
        let env = |path| Env::new(path, ".".into(), None, "test".into());
        let expected = scope(&env(root.clone()));
        std::fs::create_dir_all(&root).unwrap();
        assert_eq!(expected, scope(&env(root.clone())));
        assert_eq!(
            expected,
            scope(&env(root.join(".").join("child").join("..")))
        );
        #[cfg(windows)]
        {
            assert_eq!(
                expected,
                scope(&env(root.to_string_lossy().replace('\\', "/").into()))
            );
            assert_eq!(
                expected,
                scope(&env(root.to_string_lossy().to_uppercase().into()))
            );
        }
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn invalid_ids_fail_before_accessing_the_store_without_echoing_values() {
        let env = Env::new("instance".into(), ".".into(), None, "test".into());
        for id in ["", "secret\nprivate"] {
            let error = read(&env, id).unwrap_err();
            assert_eq!(error.code, SecretErrorCode::InvalidId);
            assert_eq!(write(&env, id, "test-only-secret").unwrap_err(), error);
            assert_eq!(delete(&env, id).unwrap_err(), error);
            assert!(!format!("{error:?} {error}").contains("private"));
            assert_eq!(
                serde_json::to_string(&error).unwrap(),
                "{\"code\":\"invalid_id\"}"
            );
        }
    }
}
