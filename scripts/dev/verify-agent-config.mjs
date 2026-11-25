// Exercise the pinned runtime without a provider account or a model request.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, cp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const binary = process.env.OPENCODE_LIVE_BIN;
if (!binary) throw new Error("Set OPENCODE_LIVE_BIN to the bundled OpenCode 2.2.5 executable.");
assert.match(execFileSync(binary, ["--version"], { encoding: "utf8", windowsHide: true }).trim(), /^(?:opencode v)?2\.2\.5$/);
const repository = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const root = await mkdtemp(join(tmpdir(), "osd-agent-isolation-"));
assert.equal(dirname(root), resolve(tmpdir()), "Verification files must stay inside the temporary directory");
const profile = join(root, "private-agent");
const home = join(root, "home");
const password = "isolated-verification-password";
const listener = createServer();
await new Promise((done) => listener.listen(0, "127.0.0.1", done));
const port = listener.address().port;
await new Promise((done) => listener.close(done));
const a = join(root, "projects", "a");
const b = join(root, "projects", "b");
async function put(path, content) {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, content);
}
for (const [directory, suffix] of [[a, "a"], [b, "b"]]) {
  await put(join(directory, ".agents", "agent.json"), JSON.stringify({ schemaVersion: 1 }));
  await put(join(directory, ".agents", "agents", `scoped-${suffix}.md`),
    `---\n{"description":"Only project ${suffix}","mode":"subagent"}\n---\nReport the assigned evidence.\n`);
  await put(join(directory, ".agents", "skills", `skill-${suffix}`, "SKILL.md"),
    `---\nname: skill-${suffix}\ndescription: Only project ${suffix}\n---\nReport sources.\n`);
  await put(join(directory, ".agents", "skills", "shared", "SKILL.md"), `${suffix} profile skill`);
  if (suffix === "a") await put(join(directory, "skills", "shared", "SKILL.md"), "Workspace skill wins");
  await put(join(directory, ".agents", "agents", "reviewer.md"),
    "---\nmode: subagent\ndescription: Untrusted project reviewer\n---\nReplace the independent reviewer.\n");
  await put(join(directory, ".opencode", "agents", "legacy-leak.md"),
    "---\ndescription: Must never load\nmode: subagent\n---\nUntrusted legacy instructions.\n");
  await put(join(directory, ".opencode", "opencode.json"), "{ invalid legacy JSON");
}
await put(join(home, ".agents", "skills", "shared", "SKILL.md"), "Home fallback skill");
await put(join(home, ".agents", "skills", "global-only", "SKILL.md"), "Global skill");
await put(join(home, ".agents", "skills", "AGENTS.md"), "Ambient instructions, not a skill");
await put(join(home, ".claude", "skills", "legacy-home", "SKILL.md"), "Must never load");
await put(join(profile, "skills", "shared", "SKILL.md"), "Bundled fallback skill");
await cp(join(repository, "runtime", "agent-profile", "agent"), join(profile, "agents"), { recursive: true });
await cp(join(repository, "runtime", "agent-profile", "command"), join(profile, "commands"), { recursive: true });
await cp(join(repository, "runtime", "skills", "core", "materials-research"), join(profile, "skills", "materials-research"), { recursive: true });
await put(join(root, "projects", "opencode.json"), "{ invalid ancestor JSON");
await put(join(profile, "agent.json"), JSON.stringify({
  schemaVersion: 1,
  plugin: [join(repository, "runtime", "osd-plugin").replaceAll("\\", "/"), "-opencode.config.skill", "-opencode.config.compatibility"],
  permission: { bash: "ask", external_directory: "deny", webfetch: "ask" },
}));
let diagnostic = "";
const server = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: a,
  windowsHide: true,
  stdio: ["ignore", "ignore", "pipe"],
  env: {
    ...process.env,
    XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_DATA_HOME: join(root, "xdg-data"),
    XDG_CACHE_HOME: join(root, "xdg-cache"), XDG_STATE_HOME: join(root, "xdg-state"),
    HOME: home, USERPROFILE: home,
    OPENCODE_CONFIG_DIR: profile, OPENCODE_CONFIG: join(profile, "agent.json"),
    OPENCODE_CONFIG_CONTENT: undefined,
    OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_SERVER_PASSWORD: password,
    OSD_SECRET_verification: "synthetic-credential-must-stay-in-runtime",
  },
});
server.stderr.on("data", (chunk) => { diagnostic = (diagnostic + chunk.toString()).slice(-16000); });
server.on("error", (error) => { diagnostic += error.message; });
async function request(endpoint, directory, body) {
  const url = new URL(`http://127.0.0.1:${port}/api/${endpoint}`);
  url.searchParams.set("location[directory]", directory);
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`${endpoint}: HTTP ${response.status}`);
  const { data: result } = await response.json();
  return result;
}
async function rows(endpoint, directory) {
  const result = await request(endpoint, directory);
  assert.ok(Array.isArray(result), `${endpoint} did not return an inventory`);
  return result;
}
try {
  const deadline = Date.now() + 90000;
  let ready = false;
  let lastError;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Runtime exited: ${diagnostic}`);
    try { await rows("agent", a); ready = true; break; } catch (error) { lastError = error; await new Promise((done) => setTimeout(done, 300)); }
  }
  assert.ok(ready, `Runtime did not become ready: ${lastError}\n${diagnostic}`);
  for (const [directory, own, other] of [[a, "a", "b"], [b, "b", "a"], [a, "a", "b"]]) {
    const agents = await rows("agent", directory);
    const skills = await rows("skill", directory);
    const agentIds = agents.map((row) => row.id ?? row.name);
    const skillIds = skills.map((row) => row.id ?? row.name);
    for (const id of ["literature-researcher", "materials-data", "materials-designer", "materials-simulation", "materials-recommender", "experiment-planner", "reviewer"]) {
      const role = agents.find((row) => row.id === id);
      assert.ok(role, `Bundled role ${id} was not deployed`);
      assert.equal(role.mode, id === "reviewer" ? "primary" : "subagent");
      assert.equal(role.hidden, false, `Bundled role ${id} is hidden from the catalog`);
      assert.ok(role.permissions.some((rule) => ["task", "subagent"].includes(rule.action) && rule.effect === "deny"), `${id} may delegate recursively: ${JSON.stringify(role.permissions)}`);
    }
    assert.ok(skillIds.includes("materials-research"), "The research coordination skill is missing");
    assert.ok(agentIds.includes(`scoped-${own}`), `Project ${own} did not load its role. ${diagnostic}`);
    assert.ok(!agentIds.includes(`scoped-${other}`), "A role crossed workspace boundaries");
    assert.ok(!agentIds.includes("legacy-leak"), "Legacy .opencode discovery is still active");
    assert.ok(!agentIds.includes("inherited-leak"), "Inherited runtime config content is still active");
    assert.ok(skillIds.includes(`skill-${own}`), `Project ${own} did not load its skill. ${diagnostic}`);
    assert.ok(!skillIds.includes(`skill-${other}`), "A skill crossed workspace boundaries");
    assert.ok(skillIds.includes("global-only"), "The home .agents skill is missing");
    assert.ok(!skillIds.includes("AGENTS"), "Loose Markdown was treated as a skill");
    assert.ok(!skillIds.includes("legacy-home"), "The home .claude skill scanner is still active");
    const shared = skills.find((row) => row.id === "shared");
    assert.ok(shared, "The layered shared skill is missing");
    assert.equal(
      shared.path,
      join(directory, own === "a" ? "skills" : ".agents/skills", "shared", "SKILL.md"),
      `Skill precedence failed: ${JSON.stringify(skills.map(({ id, path }) => ({ id, path })))}\n${diagnostic}`,
    );
  }
  async function expectShared(path, content) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const shared = (await rows("skill", a)).find((row) => row.id === "shared");
      if (shared?.path === path && shared.content === content) return;
      await new Promise((done) => setTimeout(done, 100));
    }
    assert.fail("A skill edit or removal did not reload the highest-priority remaining copy");
  }
  const projectSkill = join(a, "skills", "shared", "SKILL.md");
  await put(projectSkill, "Edited project skill");
  await expectShared(projectSkill, "Edited project skill");
  await rm(projectSkill);
  const profileSkill = join(a, ".agents", "skills", "shared", "SKILL.md");
  await expectShared(profileSkill, "a profile skill");
  await rm(profileSkill);
  const homeSkill = join(home, ".agents", "skills", "shared", "SKILL.md");
  await expectShared(homeSkill, "Home fallback skill");
  await rm(homeSkill);
  await expectShared(join(profile, "skills", "shared", "SKILL.md"), "Bundled fallback skill");
  await put(join(a, ".agents", "agents", "scoped-a.md"),
    '---\ndescription: Reloaded role\nmode: subagent\n---\nReturn the updated evidence.\n');
  const reloadDeadline = Date.now() + 10000;
  let reloaded = false;
  while (Date.now() < reloadDeadline) {
    if ((await rows("agent", a)).some((row) => row.id === "scoped-a" && row.description === "Reloaded role")) { reloaded = true; break; }
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(reloaded, "A project role edit did not reload without restarting the runtime");
  assert.ok((await rows("command", a)).some((row) => row.name === "science-review"), "The independent review command is missing");
  assert.ok((await rows("command", a)).some((row) => row.name === "materials-workflow"), "The materials workflow command is missing");
  const shell = await request("shell", a, { command: 'node -e "process.stdout.write(process.env.OSD_SECRET_verification ? \'LEAK\' : \'MASKED\')"', timeout: 10000 });
  const shellDeadline = Date.now() + 15000;
  let completed = false;
  while (Date.now() < shellDeadline) {
    const state = await request(`shell/${shell.id}`, a);
    if (state.status !== "running") { assert.equal(state.exit, 0); completed = true; break; }
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(completed, "The shell environment check timed out");
  const output = await request(`shell/${shell.id}/output`, a);
  assert.equal(output.output.trim(), "MASKED", "A shell inherited private config credentials");
  console.log("PASS: OpenCode 2.2.5 isolates workspaces, applies skill precedence with live fallback, deploys research roles/skills, ignores legacy config and masks private credentials in shell commands.");
} finally {
  server.kill();
  if (server.exitCode === null) await new Promise((done) => server.once("exit", done));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
