import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
export const binariesDir = join(repoRoot, "apps", "desktop", "src-tauri", "binaries");
export const executableSuffix = process.platform === "win32" ? ".exe" : "";
export const sidecarNames = ["opencode", "uv", "agent-browser", "osd"];

function quoteCommandArg(value) {
  return /^[A-Za-z0-9@_.:/=+,-]+$/.test(value)
    ? value
    : `"${value.replaceAll("%", "%%").replaceAll('"', '\\"')}"`;
}

export function run(command, args, options = {}) {
  const common = {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
    ...options,
  };
  const result =
    process.platform === "win32" && command === "pnpm"
      ? spawnSync(
          process.env.ComSpec ?? "cmd.exe",
          ["/d", "/s", "/c", [command, ...args].map(quoteCommandArg).join(" ")],
          common,
        )
      : spawnSync(command, args, common);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with status ${result.status}`);
  }
}

export function hostTriple() {
  const result = spawnSync("rustc", ["-Vv"], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || "rustc -Vv failed");
  const triple = result.stdout.match(/^host:\s*(.+)$/m)?.[1]?.trim();
  if (!triple) throw new Error("could not determine the Rust host target");
  return triple;
}

export function sidecarPath(name, triple) {
  return join(binariesDir, `${name}-${triple}${executableSuffix}`);
}

export function missingSidecars(triple) {
  return sidecarNames.filter((name) => !existsSync(sidecarPath(name, triple)));
}

function latestMtime(path) {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  return readdirSync(path, { withFileTypes: true }).reduce((latest, entry) => {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "target") {
      return latest;
    }
    return Math.max(latest, latestMtime(join(path, entry.name)));
  }, stat.mtimeMs);
}

export function osdNeedsBuild(triple) {
  const output = sidecarPath("osd", triple);
  if (!existsSync(output)) return true;
  const builtAt = statSync(output).mtimeMs;
  const inputs = [
    "brand.json",
    "Cargo.toml",
    "Cargo.lock",
    "apps/desktop/index.html",
    "apps/desktop/package.json",
    "apps/desktop/tsconfig.json",
    "apps/desktop/vite.config.ts",
    "apps/desktop/src",
    "crates/osd-cli",
    "crates/osd-core",
    "packages/sdk/src",
    "packages/shared/src",
    "runtime/harness",
    "scripts/build-acp-server.mjs",
  ].map((path) => join(repoRoot, path));
  return inputs.some(
    (path) => existsSync(path) && latestMtime(path) > builtAt,
  );
}

export function assertDevRuntime(triple) {
  const missing = missingSidecars(triple);
  if (missing.length === 0) return;
  const rows = missing.map((name) => `  ${sidecarPath(name, triple)}`).join("\n");
  throw new Error(
    `Development runtime files are missing for ${triple}:\n${rows}\n\n` +
      "Run `pnpm setup:dev` once, then start the desktop app again.",
  );
}

export function buildOsdSidecar(triple) {
  run("pnpm", ["--filter", "@ai4s/desktop", "build"]);
  run("cargo", [
    "build",
    "--release",
    "--target",
    triple,
    "--package",
    "osd-cli",
    "--manifest-path",
    join(repoRoot, "Cargo.toml"),
  ]);
  const built = join(
    repoRoot,
    "target",
    triple,
    "release",
    `osd${executableSuffix}`,
  );
  if (!existsSync(built)) throw new Error(`osd build did not produce ${built}`);
  mkdirSync(dirname(sidecarPath("osd", triple)), { recursive: true });
  copyFileSync(built, sidecarPath("osd", triple));
  console.log(`Staged osd for ${triple} at ${sidecarPath("osd", triple)}`);
}

export function ensureOsdSidecar(triple) {
  if (osdNeedsBuild(triple)) {
    buildOsdSidecar(triple);
  } else {
    console.log(`Reusing current osd sidecar at ${sidecarPath("osd", triple)}`);
  }
}

export function stageGatewayRuntime(triple) {
  assertDevRuntime(triple);
  const stage = join(binariesDir, "dev-web");
  const binaries = join(stage, "binaries");
  const resources = join(stage, "resources");
  const resolvedStage = resolve(stage);
  if (!resolvedStage.startsWith(`${resolve(binariesDir)}${sep}`)) {
    throw new Error(`refusing to stage outside ${binariesDir}: ${stage}`);
  }
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(binaries, { recursive: true });
  for (const name of sidecarNames) {
    copyFileSync(
      sidecarPath(name, triple),
      join(binaries, `${name}${executableSuffix}`),
    );
  }
  for (const [source, destination] of [
    ["runtime/osd-plugin", "osd-plugin"],
    ["runtime/computer", "computer"],
    ["runtime/skills/external/ai4s-skills", "skills"],
    ["runtime/skills/external/anthropic-skills", "skills-office"],
    ["runtime/skills/external/agent-browser", "skills-agent-browser"],
    ["runtime/skills/core", "skills-core"],
    ["runtime/agent-profile/agent", "profile/agent"],
    ["runtime/agent-profile/command", "profile/command"],
    ["runtime/harness", "harness"],
    ["runtime/acp-server", "acp-server"],
    ["examples/climate-trends", "examples/climate-trends"],
  ]) {
    const from = join(repoRoot, source);
    if (!existsSync(from)) {
      throw new Error(`development resource is missing: ${from}`);
    }
    cpSync(from, join(resources, destination), { recursive: true });
  }
  return { binaries, resources };
}
