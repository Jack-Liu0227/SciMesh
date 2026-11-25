# Agent profile

This bundle contains the application's reviewer, research specialists, and slash
commands. They are deployed into the private `runtime/agent` profile as `agents/`
and `commands/`. Scientific skills are deployed from `runtime/skills/core` and
the separately fetched skill packs into the same profile's `skills/` directory.

Application settings use the versioned `agent.json` in that private profile.
Workspace extensions use `.agents/agent.json`, `.agents/agents/`,
`.agents/skills/`, and `.agents/commands/`. `AGENTS.md` remains the workspace rules
file. The runtime adapter disables automatic project configuration discovery and
loads the current workspace's `.agents` explicitly through the application plugin.
Project settings select models and restrict configured connectors; application
Settings owns providers, credentials, connector installation, and approval policy.

The profile is versioned with the application. User credentials and conversations
are never bundled or copied into a project.
