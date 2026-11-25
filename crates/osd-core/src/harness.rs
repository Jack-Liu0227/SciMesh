// Seed workspace rules and memory from the bundled runtime/harness resource.
// Upgrade only byte-identical known legacy templates; preserve all user edits.
use std::io::{self, Write};
use std::path::Path;

use sha2::{Digest, Sha256};

use crate::env::Env;

// SHA-256 of the bundled single-agent templates before the research role
// upgrade, in LF and CRLF form respectively. Do not normalize user content:
// even a whitespace edit makes a file user-owned. Keep hashes scoped by path.
const LEGACY_TEMPLATES: &[(&str, [&str; 2])] = &[
    (
        "AGENTS.md",
        [
            "b38f036ce89f21d294566a97e812c4b608663cf99a5f29d2262dd7b317622ebe",
            "0e6ad0536f92dc8c3f338ccc603b915713a77a3c74693a662f410a5b9f5ef446",
        ],
    ),
    (
        "README.md",
        [
            "6aa566acaa7c02b716bc31ae15e09fd05f2221aa98224f1563f9ee89d4da47bc",
            "062092b8c70fd31719ce63443ad1cc0354b3d8caef0bdc80050a8991787a0ea7",
        ],
    ),
    (
        "KNOWLEDGE.md",
        [
            "792b5dc129b121f8515eb37b06c5dc57966a3457b3a4b8b27391eee5d3a0112e",
            "182cdbb4bb976c790075dbb60cf7f3c48c81d5909d27eeb11f3e68f82644627e",
        ],
    ),
    (
        "knowledge/system.md",
        [
            "ba720eaabba40a2d41306c12313ad2c49b5617f4772f2d05aa53403636c9e82c",
            "efa35065f2b2d46d15521b48910896c23fee512979f7346891d8d7c47682679d",
        ],
    ),
];

/// Seed missing harness files and upgrade untouched legacy templates in `dir`.
///
/// User-edited files and symlinks are left alone. A missing/unbundled harness or
/// an I/O failure is logged to stderr so a session can still open.
pub fn seed_harness(env: &Env, dir: &Path) {
    let Some(src) = env.resource("harness").filter(|p| p.is_dir()) else {
        eprintln!("harness not bundled in this build");
        return;
    };
    if let Err(e) = seed_directory(&src, dir, Path::new("")) {
        eprintln!("harness seed failed: {e}");
    }
}

/// Existing imported projects only receive exact, known template upgrades.
/// Missing files belong to the project and are not seeded during a switch.
pub fn upgrade_harness(env: &Env, dir: &Path) {
    let Some(src) = env.resource("harness").filter(|p| p.is_dir()) else {
        return;
    };
    for (relative, _) in LEGACY_TEMPLATES {
        let target = dir.join(relative);
        if target.is_file() {
            if let Err(error) = seed_file(&src.join(relative), &target, Path::new(relative)) {
                eprintln!("harness upgrade failed: {error}");
            }
        }
    }
}

fn seed_directory(src: &Path, dst: &Path, relative: &Path) -> io::Result<()> {
    match std::fs::symlink_metadata(dst) {
        Ok(meta) if meta.is_symlink() || !meta.is_dir() => return Ok(()),
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => std::fs::create_dir_all(dst)?,
        Err(e) => return Err(e),
    }
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let to = dst.join(entry.file_name());
        let rel = relative.join(entry.file_name());
        if kind.is_dir() {
            seed_directory(&entry.path(), &to, &rel)?;
        } else if kind.is_file() {
            seed_file(&entry.path(), &to, &rel)?;
        }
    }
    Ok(())
}

fn seed_file(src: &Path, dst: &Path, relative: &Path) -> io::Result<()> {
    match std::fs::symlink_metadata(dst) {
        Ok(meta) if meta.is_file() && !meta.is_symlink() => {
            if let Some((_, hashes)) = LEGACY_TEMPLATES
                .iter()
                .find(|(p, _)| relative == Path::new(p))
            {
                let bytes = std::fs::read(dst)?;
                let hash = format!("{:x}", Sha256::digest(&bytes));
                if hashes.contains(&hash.as_str()) {
                    std::fs::copy(src, dst)?;
                }
            }
        }
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            // A concurrent creator must not lose its file between the existence
            // check and this write, including a newly created dangling symlink.
            let bytes = std::fs::read(src)?;
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(dst)
            {
                Ok(mut file) => file.write_all(&bytes)?,
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e),
            }
        }
        Err(e) => return Err(e),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const OLD_SYSTEM: &str = "# System\n\n\
        - Model: self-evolving single agent, with no coach or peers.\n\
        - Duty: complete its own goals and keep improving.\n\
        - Workspace: code, data, drafts, and results may all live in this repo.\n\
        - Memory: `AGENTS.md` stores rules, `knowledge/` stores current facts, and `notes/` stores daily logs.\n";
    const OLD_KNOWLEDGE: &str = "# Knowledge Index\n\n\
        - `knowledge/system.md`: `evolve-agent` model, duties, workspace, and memory structure.\n\
        - `knowledge/current-state.md`: current goal, stage, and task status.\n";

    struct TestWorkspace {
        root: PathBuf,
        bundle: PathBuf,
        workspace: PathBuf,
        env: Env,
    }

    impl TestWorkspace {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "osd-harness-{}-{}",
                std::process::id(),
                crate::runtime::random_hex(6)
            ));
            let resources = root.join("resources");
            let bundle = resources.join("harness");
            std::fs::create_dir_all(bundle.join("knowledge")).unwrap();
            for (name, bytes) in [
                (
                    "AGENTS.md",
                    include_bytes!("../../../runtime/harness/AGENTS.md").as_slice(),
                ),
                (
                    "README.md",
                    include_bytes!("../../../runtime/harness/README.md").as_slice(),
                ),
                (
                    "KNOWLEDGE.md",
                    include_bytes!("../../../runtime/harness/KNOWLEDGE.md").as_slice(),
                ),
                (
                    "knowledge/system.md",
                    include_bytes!("../../../runtime/harness/knowledge/system.md").as_slice(),
                ),
                (
                    "knowledge/current-state.md",
                    include_bytes!("../../../runtime/harness/knowledge/current-state.md")
                        .as_slice(),
                ),
            ] {
                std::fs::write(bundle.join(name), bytes).unwrap();
            }
            let workspace = root.join("workspace");
            let env = Env::new(root.join("data"), resources, None, "test".into());
            Self {
                root,
                bundle,
                workspace,
                env,
            }
        }

        fn write(&self, relative: &str, bytes: impl AsRef<[u8]>) {
            let path = self.workspace.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, bytes).unwrap();
        }

        fn seed(&self) {
            seed_harness(&self.env, &self.workspace);
        }

        fn assert_bundled(&self, relative: &str) {
            assert_eq!(
                std::fs::read(self.workspace.join(relative)).unwrap(),
                std::fs::read(self.bundle.join(relative)).unwrap(),
                "{relative} should match the current bundle"
            );
        }
    }

    impl Drop for TestWorkspace {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn seeds_new_workspace_from_current_bundle() {
        let test = TestWorkspace::new();
        test.seed();
        for relative in [
            "AGENTS.md",
            "README.md",
            "KNOWLEDGE.md",
            "knowledge/system.md",
            "knowledge/current-state.md",
        ] {
            test.assert_bundled(relative);
        }
    }

    #[test]
    fn upgrades_unchanged_legacy_templates_with_lf_or_crlf() {
        for crlf in [false, true] {
            let test = TestWorkspace::new();
            for (name, old) in [
                ("knowledge/system.md", OLD_SYSTEM),
                ("KNOWLEDGE.md", OLD_KNOWLEDGE),
            ] {
                let bytes = if crlf {
                    old.replace('\n', "\r\n")
                } else {
                    old.to_string()
                };
                test.write(name, bytes);
            }
            test.seed();
            test.assert_bundled("knowledge/system.md");
            test.assert_bundled("KNOWLEDGE.md");
            test.assert_bundled("AGENTS.md");
        }
    }

    #[test]
    fn preserves_edited_agents_memory_notes_and_unknown_files() {
        let test = TestWorkspace::new();
        let files = [
            (
                "AGENTS.md",
                format!(
                    "{}\nUser rule: preserve my working conventions.\n",
                    include_str!("../../../runtime/harness/AGENTS.md")
                ),
            ),
            ("knowledge/system.md", format!("{OLD_SYSTEM}\n")),
            ("KNOWLEDGE.md", format!("{OLD_KNOWLEDGE}User fact\n")),
            ("README.md", "My research project\n".into()),
            (
                "knowledge/current-state.md",
                "Current goal and results\n".into(),
            ),
            ("notes/today.md", "Verified lesson\n".into()),
            ("data/observations.csv", "x,y\n1,2\n".into()),
        ];
        for (name, content) in &files {
            test.write(name, content);
        }
        test.seed();
        for (name, content) in files {
            assert_eq!(
                std::fs::read(test.workspace.join(name)).unwrap(),
                content.as_bytes(),
                "{name}"
            );
        }
    }

    #[test]
    fn legacy_bytes_at_an_unmanaged_path_are_preserved() {
        let test = TestWorkspace::new();
        test.write("AGENTS.md", OLD_SYSTEM);
        test.seed();
        assert_eq!(
            std::fs::read_to_string(test.workspace.join("AGENTS.md")).unwrap(),
            OLD_SYSTEM
        );
    }

    #[test]
    fn repeated_seeding_preserves_current_files_and_later_edits() {
        let test = TestWorkspace::new();
        test.write("knowledge/system.md", OLD_SYSTEM);
        test.seed();
        let agents_path = test.workspace.join("AGENTS.md");
        let agents_bytes = std::fs::read(&agents_path).unwrap();
        let agents_modified = std::fs::metadata(&agents_path).unwrap().modified().unwrap();
        test.write("knowledge/system.md", "User updated the system facts.\n");
        test.seed();
        test.seed();
        assert_eq!(std::fs::read(&agents_path).unwrap(), agents_bytes);
        assert_eq!(
            std::fs::metadata(&agents_path).unwrap().modified().unwrap(),
            agents_modified
        );
        assert_eq!(
            std::fs::read_to_string(test.workspace.join("knowledge/system.md")).unwrap(),
            "User updated the system facts.\n"
        );
    }

    #[test]
    fn preserves_directory_conflicts() {
        let test = TestWorkspace::new();
        test.write("knowledge", "User file occupying the directory path.\n");
        test.write(
            "AGENTS.md/owned.txt",
            "User directory occupying the file path.\n",
        );
        test.seed();
        assert_eq!(
            std::fs::read_to_string(test.workspace.join("knowledge")).unwrap(),
            "User file occupying the directory path.\n"
        );
        assert_eq!(
            std::fs::read_to_string(test.workspace.join("AGENTS.md/owned.txt")).unwrap(),
            "User directory occupying the file path.\n"
        );
    }

    #[test]
    fn missing_bundle_is_a_soft_failure() {
        let test = TestWorkspace::new();
        let env = Env::new(
            test.root.join("data"),
            test.root.join("absent"),
            None,
            "test".into(),
        );
        seed_harness(&env, &test.workspace);
        assert!(!test.workspace.exists());
    }

    #[cfg(unix)]
    #[test]
    fn preserves_file_and_directory_symlinks() {
        let test = TestWorkspace::new();
        let outside = test.root.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::create_dir_all(&test.workspace).unwrap();
        std::fs::write(outside.join("system.md"), OLD_SYSTEM).unwrap();
        std::os::unix::fs::symlink(&outside, test.workspace.join("knowledge")).unwrap();
        std::os::unix::fs::symlink(outside.join("absent.md"), test.workspace.join("AGENTS.md"))
            .unwrap();
        test.seed();
        assert_eq!(
            std::fs::read_to_string(outside.join("system.md")).unwrap(),
            OLD_SYSTEM
        );
        assert!(!outside.join("current-state.md").exists());
        assert!(!outside.join("absent.md").exists());
        assert!(std::fs::symlink_metadata(test.workspace.join("AGENTS.md"))
            .unwrap()
            .is_symlink());
    }
}
