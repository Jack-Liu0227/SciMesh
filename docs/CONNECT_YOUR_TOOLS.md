# Connect your lab tools

SciMesh is a workbench: it aggregates tools, it doesn't replace them.
Anything the agent can reach is an **MCP server** (Model Context Protocol) or a
**skill**. Both are pluggable — you don't touch app code to add one.

## One-click science connectors

Settings → **MCP servers** lists curated open-source connectors. Click **Enable**
and the app provisions the server into an isolated environment (bundled `uv`,
managed Python — your system is untouched) and registers it. Today:

- **Literature search** (all fields) — arXiv, PubMed, Crossref, Semantic Scholar,
  bioRxiv/medRxiv ([paper-search-mcp](https://github.com/openags/paper-search-mcp)).
- **Biomedical databases** (biology) — PubMed, ClinicalTrials.gov, genomic variants
  ([biomcp](https://github.com/genomoncology/biomcp)).
- **Materials Project** (materials) — properties, structures, phase diagrams
  ([mcp-materials-project](https://github.com/luffysolution-svg/mcp-materials-project); free MP API key).
- **FRED economic data** (economics) — Federal Reserve time series
  ([fred-mcp](https://github.com/tosin2013/fred-mcp); free FRED API key).
- **Space weather** (physics) — solar wind, flares, Kp/Dst indices, radiation
  storms, aurora, from NOAA SWPC / NASA DONKI / USGS
  ([spaceweather-mcp](https://github.com/hoon1983/spaceweather-mcp); no key).
- **Weather & climate** (earth) — current & historical weather, air quality,
  timezones from Open-Meteo
  ([mcp-weather-server](https://github.com/isdaniel/mcp_weather_server); no key).
- **USGS water data** (earth) — streamflow, flood stages, peak events, sites
  ([usgs-mcp](https://github.com/mansurjisan/ocean-mcp); no key).

Literature and database results carry real identifiers (DOI / PMID / arXiv id),
so the `traceability-review` skill can audit them afterward.

## Bring your own MCP server

Any MCP server works — internal ELN, LIMS, a database gateway, an instrument
bridge. In Settings → **MCP servers**, use the add form:

- **local** — a command the app launches and talks to over stdio. Example:
  `npx -y @playwright/mcp` (browser), or `uvx your-lab-mcp` for a Python server.
- **remote** — a URL the app connects to over HTTP. Example:
  `https://mcp.your-lab.internal/sse`.

The entry is managed globally by the application in
`<app-data>/runtime/agent/agent.json`, or `<state-dir>/runtime/agent/agent.json`
for an isolated server. OpenCode remains the bundled execution engine. Its
native project configuration discovery is disabled; opening a repository cannot
install a server or start a process through project configuration. Check the
connector's live status in Settings after configuring it.

### Restrict connectors for a project

The trusted application plugin reads `<project>/.agents/agent.json` with
`schemaVersion: 1`. It accepts only a default `model`, per-agent `model` and
`variant` selections under `agent`, and a `connectors` allowlist of globally
configured connector IDs. For example:

```json
{
  "schemaVersion": 1,
  "model": "provider/model",
  "agent": { "literature-researcher": { "model": "provider/model", "variant": "high" } },
  "connectors": ["lab-tools"]
}
```

Omitting `connectors` retains the configured global set; `[]` disables all MCP
connectors for that project. The list cannot install or enable a server, define
a command or URL, supply credentials, or expand permissions. An invalid project
configuration exposes no MCP connectors. Providers, plugins, process definitions,
credentials, and approval policy remain application settings. The gateway can
read redacted configuration but cannot provision MCP servers.

Project role instructions live in `.agents/agents/`, slash commands in
`.agents/commands/`, and skills in `.agents/skills/`. The trusted plugin loads
these explicitly; they do not install runtime plugins or connector processes.
Legacy configuration is migration input only. The application copies supported
resources once and records conflicts or settings needing review in
`.agents/migration.json`; it does not activate old project MCP definitions.

### AstaBench adapter isolation

Run the Inspect controller on the OSD host against a dedicated benchmark
instance. The retained adapter uses the MCP Python v1 interfaces; transport
checks use `mcp==1.30.0`. Use a compatible MCP v1 environment with Inspect AI
and AstaBench installed. Configure one enabled remote MCP connector per
concurrently running sample in application Settings, each with a distinct URL of the form
`http://127.0.0.1:PORT/sse`. Use connector IDs such as `astabench-1` and
`astabench-2`. The adapter hosts these endpoints; do not configure a local
command, authentication, or a shared forwarding hub. Until the controller
starts its bridges, a connector may report that its endpoint is unavailable.

Set `OSD_GATEWAY` to the instance's loopback gateway, set `OSD_TOKEN` through the
controller's environment, and set
`ASTABENCH_OSD_CONNECTORS=astabench-1,astabench-2`. If the last variable is
omitted, the adapter requires one preconfigured connector named `astabench`.
Keep benchmark credentials out of project files and run artifacts.

The controller reads redacted global configuration from `/v1/agent-config`
without modifying it. Each sample leases one connector and port, starts its own
bridge, and writes only `{"schemaVersion":1,"connectors":["astabench-1"]}` to
its fresh project's `.agents/agent.json` before creating the session. The
trusted plugin exposes that sample's selected MCP connector. Sample prompts and
result metadata use the selected ID. Missing configuration, duplicate ports,
or an occupied port fail explicitly; the adapter never substitutes another
sample's tools. If all slots are leased, it waits up to
`ASTABENCH_OSD_CONNECTOR_WAIT` seconds (default 90), then fails with setup
guidance. Provision enough slots for the evaluation's concurrency.

Bridges are stopped after each sample. Successful samples release their slots
for reuse. A sample failure retires its slot for the rest of the controller
process because an interrupted OSD turn might still reconnect. Do not reuse
retired endpoints in a new controller until the old benchmark instance is
stopped or its turns are explicitly aborted. Global definitions remain
configured. Use separate connector pools and ports for separate controller
processes; leases are local to one process. Gateway access cannot install MCP
servers, so perform setup locally before the run instead of attempting a gateway
configuration write.

### Minimal local MCP server (Python)

```python
# lab_tools.py — run with: uvx --from fastmcp fastmcp run lab_tools.py
from fastmcp import FastMCP

mcp = FastMCP("lab-tools")

@mcp.tool()
def sample_metadata(sample_id: str) -> dict:
    """Look up a sample in the lab database."""
    return {"id": sample_id, "assay": "RNA-seq", "status": "passed_qc"}

if __name__ == "__main__":
    mcp.run()
```

Add it as a **local** server with the command that launches it. Restart-free.

## Bring your own skill

A skill is a folder with a `SKILL.md` (instructions the agent follows) plus any
scripts/templates it needs. Install one from the **Skills** page (paste a URL or
Markdown; the agent saves it under the workspace's `.agents/skills/`). The
app also bundles first-party skills (e.g. `traceability-review`) and the
`ai4s-skills` pack.

## Safety

- Every server you add can make its own network calls and run its own code —
  review the source before enabling. The curated list is vetted; your own
  entries are your responsibility.
- Command execution, file deletion, dependency installs, and remote connections
  still go through the agent's approval flow.
- Application-managed provider keys and connector secrets go to the OS
  credential store. The private configuration keeps references, never secrets
  in workspace files, provenance, logs, or exports.
