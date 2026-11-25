# runtime/skills

Scientific skills, layered:

```text
skills/
  core/      # first-party skills, including materials-research and traceability-review
  external/  # third-party skill packs, fetched by script — git-ignored
```

Core skills are bundled as the `skills-core/` app resource and deployed next to
the external pack on every sidecar start; directories without a `SKILL.md` are
skipped.

Custom skills are separate from these bundled sources:

| Scope | Location | Management |
| --- | --- | --- |
| Project | `<workspace>/skills/<name>/SKILL.md` | Edit the project files |
| Project fallback | `<workspace>/.agents/skills/<name>/SKILL.md` | Edit the project files |
| User | `~/.agents/skills/<name>/SKILL.md` | Edit the user's global files |
| Installed in the app | `<app-data>/runtime/agent/skills/user/<name>/SKILL.md` | Skills page installer |
| Bundled | `<app-data>/runtime/agent/skills/<name>/SKILL.md` | Replaced from app resources on startup |

The installer reserves bundled names and preserves the `user/` tree during
upgrades. A project copy or a home `.agents/skills` copy can override a bundled
skill by directory name. The page labels the effective file as `project`,
`user`, or `built-in`; it currently has no per-skill enable/disable switch or
source filter. All unique skills from the allowed roots remain in the catalog.

Invoke a loaded skill with `/<directory-name> <request>` in chat. The SDK merges
the skill IDs into the slash-command catalog and attaches the chosen skill to
the prompt. A same-named command takes precedence over a skill. The model can
also choose a skill from its description; set `disable-model-invocation: true`
in its YAML frontmatter to require explicit invocation. The Markdown body is
the instructions, and relative helper paths resolve from its skill directory.

Specialists are agents with their own instructions, model selection, and skill
and connector restrictions. The page lists and edits them separately from skill
files. Desktop installation can promote skills from an installation session to
the app's private `user/` tree; gateway installation stays workspace-scoped.

## Default pack: ai4s-skills (bundled into the installer)

The default scientific skills come from
[ai4s-research/ai4s-skills](https://github.com/ai4s-research/ai4s-skills)
(research-explorer, literature-survey, experiment-suite, paper-writer,
integrity-auditor, mindmap-render, ai4s-agent).

How they ship, end to end:

1. `scripts/dev/fetch-skills.sh` (run locally and in CI) downloads the pack at a
   pinned commit into `external/ai4s-skills/`.
2. `tauri.conf.json` bundles that directory as an app resource (`resources/skills/`).
3. On every sidecar start, `runtime.rs::deploy_bundled_skills` syncs the pack into
   the app-private profile's skill directory
   (`<app-data>/runtime/agent/skills/`, or `<state-dir>/runtime/agent/skills/`
   for an isolated server). Bundled skill directories are replaced on app
   upgrade. The trusted plugin loads skills in this order: `<workspace>/skills/`,
   `<workspace>/.agents/skills/`, `~/.agents/skills/`, then this private profile.
   The first skill with a given directory name wins. The app config disables
   `opencode.config.skill` and `opencode.config.compatibility` to prevent their
   later scans from overriding this order.
   Each root accepts `<name>/SKILL.md`; loose Markdown files are ignored. Listing is
   scoped to the active workspace through the SDK's directory option.

The application owns `runtime/agent/agent.json` under its data or state directory.
The project's `.agents/agent.json` requires `schemaVersion: 1` and accepts only
`model`, per-agent `model`/`variant` overrides under `agent`, and a `connectors`
allowlist. It cannot define MCP processes, plugins, credentials, or permissions.
MCP servers must first be configured globally in application Settings; a project
can only restrict that set. Project roles and commands live in `.agents/agents/`
and `.agents/commands/` and are also loaded by the trusted plugin.

To bump the pack version, update `AI4S_SKILLS_COMMIT` in `fetch-skills.sh`.

## Office pack: Anthropic document skills (bundled into the installer)

The docx / pdf / pptx / xlsx skills come from Anthropic's open-source
[anthropics/skills](https://github.com/anthropics/skills) repo (Apache-2.0;
each skill directory keeps its own `LICENSE.txt`). Same pipeline as above:
`fetch-skills.sh` pins them into `external/anthropic-skills/`, bundled as the
`skills-office/` app resource, deployed by `deploy_bundled_skills`. Bump via
`ANTHROPIC_SKILLS_COMMIT` in `fetch-skills.sh`.

## Browser skill: official agent-browser core guide

`scripts/dev/fetch-agent-browser.sh` fetches both the pinned sidecar and the
official `skill-data/core` directory from the same agent-browser tag. The build
adds only a small SciMesh MCP/lifecycle adapter, bundles the result
as `skills-agent-browser/`, and deploys it as `open-science-browser`. This keeps
the browser workflow version-matched without copying an upstream guide into git.
While the connector is configured, the runtime hides the unrelated legacy
`browser-control` user skill so OpenCode cannot select the wrong transport.

## Third-party skills

Do **not** enable large third-party collections (e.g. ~148 K-Dense skills) by
default. Use curated install, enable by domain, and always surface each skill's
license, dependencies, and risk.

Each skill directory must contain a `SKILL.md`.
