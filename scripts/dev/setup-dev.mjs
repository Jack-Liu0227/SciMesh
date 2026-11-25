import { existsSync } from "node:fs";
import { join } from "node:path";
import "../sync-brand.mjs";
import {
  ensureOsdSidecar,
  hostTriple,
  repoRoot,
  run,
  sidecarPath,
} from "./sidecars.mjs";

function requireBash() {
  run("bash", ["--version"]);
}

try {
  requireBash();
  const triple = hostTriple();
  const fetches = [
    ["opencode", "fetch-opencode.sh"],
    ["uv", "fetch-uv.sh"],
    ["agent-browser", "fetch-agent-browser.sh"],
  ];
  for (const [name, script] of fetches) {
    if (!existsSync(sidecarPath(name, triple))) {
      run("bash", [join(repoRoot, "scripts", "dev", script), triple]);
    }
  }

  const skillPacks = [
    "runtime/skills/external/ai4s-skills",
    "runtime/skills/external/anthropic-skills",
    "runtime/skills/external/agent-browser",
  ];
  if (skillPacks.some((path) => !existsSync(join(repoRoot, path)))) {
    run("bash", [join(repoRoot, "scripts", "dev", "fetch-skills.sh")]);
  }

  ensureOsdSidecar(triple);
  console.log(`SciMesh development runtime is ready for ${triple}.`);
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
