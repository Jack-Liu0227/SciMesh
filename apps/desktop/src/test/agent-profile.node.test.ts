// @vitest-environment node
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgentProfile, type AgentProfileContext, type AgentProfileDiagnostic } from "../../../../runtime/osd-plugin/agent-profile";

type Editor<Key extends "agent" | "skill" | "mcp" | "command"> = Parameters<Parameters<AgentProfileContext[Key]["transform"]>[0]>[0];
type Agent = ReturnType<Editor<"agent">["list"]>[number];
type Skill = Parameters<Editor<"skill">["add"]>[0];
type StoredSkill = Partial<Skill> & { id: string };
type Command = Parameters<Editor<"command">["add"]>[0];

// ESLint already depends on js-yaml. This parser is injected into the Node tests;
// the shipped loader imports only node built-ins and uses Bun.YAML at runtime.
const yaml: unknown = createRequire(createRequire(import.meta.url).resolve("eslint/package.json"))("js-yaml");
function parseYaml(source: string): unknown {
  if (!yaml || typeof yaml !== "object" || !("load" in yaml) || typeof yaml.load !== "function" || !("JSON_SCHEMA" in yaml)) {
    throw new Error("The test YAML parser is unavailable");
  }
  return yaml.load(source, { schema: yaml.JSON_SCHEMA });
}

const temporary: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
let homeDirectory: string;
beforeEach(async () => { homeDirectory = await root(); });
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const path of temporary.splice(0)) {
    // Each recursive removal is restricted to a directory created by this suite.
    if (!isAbsolute(path) || dirname(resolve(path)) !== resolve(tmpdir()) || !basename(path).startsWith("osd-agent-profile-test-")) {
      throw new Error("Unsafe temporary cleanup target");
    }
    await rm(path, { recursive: true, force: true });
  }
});

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "osd-agent-profile-test-"));
  temporary.push(path);
  return path;
}

async function put(root: string, path: string, content: string): Promise<string> {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
  return target;
}

function frontmatter(data: unknown, body: string): string {
  return `---\n${JSON.stringify(data)}\n---\n${body}`;
}

function domain<State, DomainEditor>(initial: () => State, edit: (state: State) => DomainEditor) {
  const callbacks = new Set<(editor: DomainEditor) => void>();
  let state = initial();
  const rebuild = () => {
    state = initial();
    for (const callback of callbacks) callback(edit(state));
  };
  return {
    read: () => state,
    reload: vi.fn(async () => { rebuild(); }),
    async transform(callback: (editor: DomainEditor) => void) {
      callbacks.add(callback);
      rebuild();
      return { async dispose() { callbacks.delete(callback); rebuild(); } };
    },
  };
}

function nativeAgent(id: string, mode: Agent["mode"]): Agent {
  return {
    id, name: id, mode, hidden: false, system: `Native ${id} instructions`,
    model: { providerID: "native", id: "default" },
    permissions: [
      { action: "*", resource: "*", effect: "ask" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "skill", resource: "private-denied", effect: "deny" },
      { action: "private_*", resource: "*", effect: "deny" },
    ],
  };
}

function harness(directory: string, existingSkills: StoredSkill[] = []) {
  const baseAgents = [nativeAgent("build", "primary"), nativeAgent("general", "subagent"), nativeAgent("explore", "subagent")];
  const baseSkills: StoredSkill[] = [
    { id: "opencode", name: "OpenCode", path: "/builtin/opencode.md", content: "Builtin" },
    { id: "report", name: "Report", content: "Builtin without a filesystem path" },
    ...existingSkills,
  ];
  const agent = domain(
    () => new Map(baseAgents.map((item) => [item.id, structuredClone(item)])),
    (state): Editor<"agent"> => ({
      list: () => [...state.values()], get: (id) => state.get(id),
      update(id, update) {
        let item = state.get(id);
        if (!item) {
          // This reproduces pinned OpenCode's permissive default record.
          item = { id, name: id, mode: "primary", hidden: false, permissions: [{ action: "*", resource: "*", effect: "allow" }] };
          state.set(id, item);
        }
        update(item);
      },
    }),
  );
  const skill = domain(
    () => new Map(baseSkills.map((item) => [item.id, structuredClone(item)])),
    (state): Editor<"skill"> => ({ list: () => [...state.values()], add: (value) => { state.set(value.id, value); }, remove: (id) => { state.delete(id); } }),
  );
  const mcp = domain(
    () => new Map<string, unknown>([["papers", { command: ["approved-papers"] }], ["private", { command: ["approved-private"] }]]),
    (state): Editor<"mcp"> => ({ list: () => [...state], remove: (name) => { state.delete(name); } }),
  );
  const command = domain(
    () => new Map<string, Command>(),
    (state): Editor<"command"> => ({ add: (value) => { state.set(value.name, value); } }),
  );
  const prompts: unknown[] = [];
  const diagnostics: AgentProfileDiagnostic[] = [];
  const ctx: AgentProfileContext = {
    location: { directory }, agent, skill, mcp, command,
    session: { async prompt(input) { prompts.push(input); } },
  };
  return {
    ctx, agent, skill, mcp, command, prompts, diagnostics, baseAgents, baseSkills,
    async start(watch = false) {
      const cleanup = await registerAgentProfile(ctx, { watch, debounceMs: 20, parseYaml, homeDirectory, onDiagnostic: (value) => { diagnostics.push(value); } });
      cleanups.push(cleanup);
      return cleanup;
    },
  };
}

describe("the trusted workspace agent profile", () => {
  it("loads only the exact location, keeps native configuration, and isolates two contexts", async () => {
    const parent = await root();
    const first = join(parent, "one");
    const second = join(parent, "two");
    await put(parent, ".agents/agents/ancestor.md", "Ancestor instructions");
    await put(first, ".opencode/agent/legacy.md", "Legacy instructions");
    await put(first, ".agents/agents/auditor.md", frontmatter({ description: "Check evidence" }, "Review the first workspace."));
    await put(second, ".agents/agents/auditor.md", frontmatter({ description: "Check methods" }, "Review the second workspace."));
    await put(first, ".agents/agent.json", JSON.stringify({ schemaVersion: 1, model: "provider/default", agent: { auditor: { model: "provider/review", variant: "high" }, build: { variant: "low" } }, connectors: ["papers", "unknown-unapproved"] }));
    const a = harness(first);
    const b = harness(second);
    await a.start();
    await b.start();
    expect([...a.agent.read().keys()]).toEqual(["build", "general", "explore", "auditor"]);
    expect(a.agent.read().get("auditor")).toMatchObject({ system: "Review the first workspace.", mode: "subagent", model: { providerID: "provider", id: "review", variant: "high" } });
    expect(b.agent.read().get("auditor")).toMatchObject({ system: "Review the second workspace.", model: { providerID: "native", id: "default" } });
    expect(a.agent.read().get("build")).toMatchObject({ model: { providerID: "provider", id: "default", variant: "low" }, system: "Native build instructions", mode: "primary" });
    expect([...a.mcp.read().keys()]).toEqual(["papers"]);
    expect([...b.mcp.read().keys()]).toEqual(["papers", "private"]);
  });

  it("inherits permissions verbatim and only adds denies for skills, connectors and delegation", async () => {
    const directory = await root();
    await put(directory, ".agents/skills/chosen/SKILL.md", "Chosen instructions");
    await put(directory, ".agents/skills/other/SKILL.md", "Other instructions");
    await put(directory, ".agents/skills/private-denied/SKILL.md", "Denied by parent");
    await put(directory, ".agents/agents/auditor.md", frontmatter({ skills: ["chosen", "private-denied"], blockedConnectors: ["papers"] }, "Review."));
    const app = harness(directory);
    await app.start();
    const rules = app.agent.read().get("auditor")?.permissions;
    expect(rules).toEqual([
      ...app.baseAgents[1].permissions,
      { action: "task", resource: "*", effect: "deny" },
      { action: "subagent", resource: "*", effect: "deny" },
      { action: "skill", resource: "opencode", effect: "deny" },
      { action: "skill", resource: "other", effect: "deny" },
      { action: "skill", resource: "report", effect: "deny" },
      { action: "papers_*", resource: "*", effect: "deny" },
    ]);
    expect(app.agent.read().get("general")?.permissions).toEqual(app.baseAgents[1].permissions);
    expect(rules?.filter((rule) => rule.effect === "allow")).toEqual([{ action: "read", resource: "*", effect: "allow" }]);
    app.baseSkills.push({ id: "later", path: await put(directory, ".agents/skills/later/SKILL.md", "Added later") });
    await app.skill.reload();
    await vi.waitFor(() => expect(app.agent.read().get("auditor")?.permissions).toContainEqual({ action: "skill", resource: "later", effect: "deny" }));
  });

  it("refuses reserved instructions and modes while accepting config model overrides", async () => {
    const directory = await root();
    for (const id of ["build", "general", "explore", "plan", "title", "summary", "compaction", "reviewer", "BUILD"]) {
      await put(directory, `.agents/agents/${id}.md`, frontmatter({ mode: "primary", model: "evil/model" }, "Replace native instructions"));
    }
    await put(directory, ".agents/agent.json", JSON.stringify({ schemaVersion: 1, agent: { build: { model: "approved/model" } } }));
    const app = harness(directory);
    app.baseAgents.push(nativeAgent("reviewer", "primary"));
    await app.start();
    expect(app.agent.read().get("build")).toMatchObject({ system: "Native build instructions", mode: "primary", model: { providerID: "approved", id: "model" } });
    expect(app.agent.read().get("general")).toMatchObject({ system: "Native general instructions", mode: "subagent" });
    expect(app.agent.read().get("reviewer")).toMatchObject({ system: "Native reviewer instructions", mode: "primary" });
    expect(app.diagnostics).toContainEqual({ code: "reserved-agent", resource: "role" });
  });

  it("retains scalar and multiline YAML skill metadata without flattening or losing source", async () => {
    const directory = await root();
    const content = "---\nname: Evidence review\ndescription: >-\n  Review experimental evidence\n  across multiple studies.\nmetadata:\n  author: A researcher\n  version: 1\nallowed-tools: Read\n---\n# Evidence\nKeep the full instructions.\n";
    const path = await put(directory, ".agents/skills/methods/evidence/SKILL.md", content);
    await put(directory, ".agents/agents/auditor.md", "---\ndescription: |\n  Review evidence.\n  Check uncertainty.\nskills:\n  - evidence\n---\nReview carefully.");
    const app = harness(directory);
    await app.start();
    expect(app.skill.read().get("evidence")).toEqual({ id: "evidence", name: "Evidence review", description: "Review experimental evidence across multiple studies.", path, content: "# Evidence\nKeep the full instructions.\n" });
    expect(app.agent.read().get("auditor")).toMatchObject({ description: "Review evidence.\nCheck uncertainty.\n", system: "Review carefully." });
  });

  it("uses Bun.YAML by default and still accepts JSON frontmatter without Bun", async () => {
    const directory = await root();
    await put(directory, ".agents/agents/auditor.md", "---\ndescription: >-\n  Review the\n  evidence.\n---\nCheck sources.");
    const parse = vi.fn(parseYaml);
    vi.stubGlobal("Bun", { YAML: { parse } });
    const app = harness(directory);
    cleanups.push(await registerAgentProfile(app.ctx, { watch: false, homeDirectory, onDiagnostic: (value) => { app.diagnostics.push(value); } }));
    expect(parse).toHaveBeenCalledTimes(1);
    expect(app.agent.read().get("auditor")?.description).toBe("Review the evidence.");
    vi.stubGlobal("Bun", undefined);
    await put(directory, ".agents/agents/auditor.md", frontmatter({ description: "JSON fallback" }, "JSON instructions"));
    const withoutBun = harness(directory);
    cleanups.push(await registerAgentProfile(withoutBun.ctx, { watch: false, homeDirectory, onDiagnostic: (value) => { withoutBun.diagnostics.push(value); } }));
    expect(withoutBun.agent.read().get("auditor")).toMatchObject({ description: "JSON fallback", system: "JSON instructions" });
  });

  it("prefers project skills, then project profile skills, then home skills", async () => {
    const directory = await root();
    await put(directory, "skills/shared/SKILL.md", frontmatter({ name: "Project override", "disable-model-invocation": true }, "Project instructions"));
    await put(directory, "skills/project-only/SKILL.md", "Project skill");
    await put(directory, ".agents/skills/shared/SKILL.md", frontmatter({ name: "Profile fallback" }, "Profile instructions"));
    await put(directory, ".agents/skills/profile-only/SKILL.md", "Profile skill");
    await put(directory, ".agents/skills/AGENTS.md", "Workspace instructions, not a skill");
    await put(homeDirectory, ".agents/skills/shared/SKILL.md", frontmatter({ name: "Home fallback" }, "Home instructions"));
    await put(homeDirectory, ".agents/skills/home-only/SKILL.md", "Home skill");
    const app = harness(directory);
    await app.start();
    expect(app.skill.read().get("shared")).toMatchObject({ id: "shared", name: "Project override", autoinvoke: false });
    expect(app.skill.read().get("shared")?.path?.replaceAll("\\", "/")).toContain("/skills/shared/SKILL.md");
    expect([...app.skill.read().keys()]).toEqual(expect.arrayContaining(["opencode", "report", "shared", "project-only", "profile-only", "home-only"]));
    expect(app.skill.read().size).toBe(6);
    expect(app.skill.read().has("AGENTS")).toBe(false);
  });

  it("fails closed without a parent and gives an empty skill selection a catch-all deny", async () => {
    const directory = await root();
    await put(directory, ".agents/agents/auditor.md", frontmatter({ skills: [] }, "Review."));
    const app = harness(directory);
    app.baseAgents.splice(0);
    await app.start();
    expect(app.agent.read().get("auditor")?.permissions).toEqual([
      { action: "*", resource: "*", effect: "deny" },
      { action: "task", resource: "*", effect: "deny" },
      { action: "subagent", resource: "*", effect: "deny" },
      { action: "skill", resource: "*", effect: "deny" },
    ]);
  });

  it("copies build permissions for primary roles and never inherits an existing role's broad allow", async () => {
    const directory = await root();
    await put(directory, ".agents/agents/auditor.md", "Review.");
    await put(directory, ".agents/agents/research.md", frontmatter({ mode: "primary" }, "Research."));
    const app = harness(directory);
    app.baseAgents[0].permissions.push({ action: "write", resource: "*", effect: "ask" });
    app.baseAgents.push({ ...nativeAgent("auditor", "subagent"), permissions: [
      { action: "*", resource: "*", effect: "allow" },
      { action: "private-tool", resource: "*", effect: "deny" },
    ] });
    await app.start();
    expect(app.agent.read().get("research")?.permissions).toEqual(app.baseAgents[0].permissions);
    expect(app.agent.read().get("auditor")?.permissions).toEqual([
      ...app.baseAgents[1].permissions,
      { action: "private-tool", resource: "*", effect: "deny" },
      { action: "task", resource: "*", effect: "deny" },
      { action: "subagent", resource: "*", effect: "deny" },
    ]);
  });

  it("rejects cyclic or prototype-bearing skill metadata without exposing parser input", async () => {
    const directory = await root();
    await put(directory, ".agents/skills/cyclic/SKILL.md", "---\nmetadata: &cycle\n  nested: *cycle\n---\nInstructions");
    await put(directory, ".agents/skills/prototype/SKILL.md", '---\n{"metadata":{"__proto__":{"polluted":true}}}\n---\nInstructions');
    await put(directory, ".agents/skills/secret/SKILL.md", '---\n{"metadata":{"apiKey":"DO_NOT_LEAK"}}\n---\nInstructions');
    const app = harness(directory);
    await app.start();
    expect([...app.skill.read().keys()]).toEqual(["opencode", "report"]);
    expect(app.diagnostics.filter((item) => item.code === "invalid-skill")).toHaveLength(3);
    expect(JSON.stringify(app.diagnostics)).not.toContain("DO_NOT_LEAK");
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("expands command arguments literally and preserves session, delivery and prompt attachments", async () => {
    const directory = await root();
    await put(directory, ".agents/commands/review.md", frontmatter({ description: "Review a result" }, "Review $ARGUMENTS, then repeat $ARGUMENTS."));
    const app = harness(directory);
    await app.start();
    const prompt = { text: "$& and $` and $'", files: [{ uri: "file:///evidence.csv" }], skills: [{ id: "chosen" }] };
    await app.command.read().get("review")?.execute({ sessionID: "session-one", delivery: "queue", prompt });
    expect(app.prompts).toEqual([{ ...prompt, sessionID: "session-one", delivery: "queue", text: "Review $& and $` and $', then repeat $& and $` and $'." }]);
  });

  it.each([
    { schemaVersion: 1, plugins: ["untrusted-plugin"] },
    { schemaVersion: 1, permissions: [{ effect: "allow" }] },
    { schemaVersion: 1, mcp: { evil: { command: ["spawn"] } } },
    { schemaVersion: 1, agent: { build: { system: "Replace native" } } },
    { schemaVersion: 1, model: "provider/sk-DO_NOT_LEAK_123456789" },
    { schemaVersion: 2 },
    { version: 1, project: { model: "p/m" } },
    JSON.parse('{"schemaVersion":1,"agent":{"__proto__":{"model":"p/m"}}}'),
  ])("rejects noncanonical, unknown or secret configuration safely: %#", async (config) => {
    const directory = await root();
    await put(directory, ".agents/agent.json", JSON.stringify(config));
    const app = harness(directory);
    await app.start();
    expect(app.agent.read().get("build")?.model).toEqual({ providerID: "native", id: "default" });
    expect([...app.mcp.read().keys()]).toEqual([]);
    expect(app.diagnostics).toContainEqual({ code: "invalid-config", resource: "agent.json" });
    expect(JSON.stringify(app.diagnostics)).not.toContain("DO_NOT_LEAK");
    expect(Object.prototype).not.toHaveProperty("model");
  });

  it.each([
    { permissions: [{ action: "*", resource: "*", effect: "allow" }] },
    { permission: "allow" }, { tools: ["shell"] }, { mode: "all" }, { temperature: 0.2 },
    { skills: ["*"] }, { blockedConnectors: ["papers*"] },
    { model: "provider/sk-DO_NOT_LEAK_123456789" },
    JSON.parse('{"__proto__":{"polluted":true}}'),
  ])("rejects unsupported or unsafe role frontmatter: %#", async (data) => {
    const directory = await root();
    await put(directory, ".agents/agents/auditor.md", frontmatter(data, "Instructions"));
    const app = harness(directory);
    await app.start();
    expect(app.agent.read().has("auditor")).toBe(false);
    expect(app.diagnostics).toContainEqual({ code: "invalid-role", resource: "role" });
    expect(JSON.stringify(app.diagnostics)).not.toContain("DO_NOT_LEAK");
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("filters home and other-project skills while retaining private, workspace and known builtin skills", async () => {
    const directory = await root();
    const elsewhere = await root();
    const privateRoot = join(elsewhere, "private");
    vi.stubEnv("OPENCODE_CONFIG_DIR", privateRoot);
    const privatePath = await put(privateRoot, "skills/approved/SKILL.md", "Private skill");
    const homePath = await put(elsewhere, "home/.agents/skills/home/SKILL.md", "Home skill");
    const siblingPath = await put(elsewhere, "other-project/.agents/skills/other/SKILL.md", "Other project");
    const workspacePath = await put(directory, ".agents/skills/local/SKILL.md", "Local skill");
    const app = harness(directory, [
      { id: "private", path: privatePath }, { id: "home", path: homePath },
      { id: "sibling", path: siblingPath }, { id: "local", path: workspacePath },
      { id: "missing-untrusted", path: join(privateRoot, "missing.md") },
      { id: "unknown-without-path" },
    ]);
    await app.start();
    expect([...app.skill.read().keys()]).toEqual(["opencode", "report", "private", "local", "approved"]);
    expect(app.diagnostics.filter((item) => item.code === "untrusted-skill")).toHaveLength(4);
  });

  it("reloads skills created in either project skill root or the home root", async () => {
    const directory = await root();
    const app = harness(directory);
    await app.start(true);
    await put(directory, "skills/project/SKILL.md", "Project skill");
    await vi.waitFor(() => expect(app.skill.read().has("project")).toBe(true), { timeout: 4000 });
    await put(homeDirectory, ".agents/skills/global/SKILL.md", "Global skill");
    await vi.waitFor(() => expect(app.skill.read().has("global")).toBe(true), { timeout: 4000 });
  });

  it("rejects directory junction escapes in project resources and inherited private skills", async () => {
    const directory = await root();
    const outside = await root();
    const privateRoot = join(directory, "private");
    await mkdir(join(directory, ".agents"), { recursive: true });
    await mkdir(privateRoot);
    await put(outside, "agents/escape.md", "Outside instructions");
    const escapedSkill = await put(outside, "skills/escape/SKILL.md", "Outside skill");
    await symlink(join(outside, "agents"), join(directory, ".agents/agents"), process.platform === "win32" ? "junction" : "dir");
    await symlink(join(outside, "skills"), join(privateRoot, "skills"), process.platform === "win32" ? "junction" : "dir");
    vi.stubEnv("OPENCODE_CONFIG_DIR", privateRoot);
    const app = harness(directory, [{ id: "escape", path: join(privateRoot, "skills/escape/SKILL.md") }, { id: "outside", path: escapedSkill }]);
    await app.start();
    expect(app.agent.read().has("escape")).toBe(false);
    expect([...app.skill.read().keys()]).toEqual(["opencode", "report"]);
    expect(app.diagnostics).toContainEqual({ code: "unsafe-path", resource: "profile" });
  });

  it("rejects a linked .agents root and does not trust native skills discovered through it", async () => {
    const directory = await root();
    const outside = await root();
    await put(outside, "agents/escape.md", "Outside instructions");
    await put(outside, "skills/escape/SKILL.md", "Outside skill");
    await symlink(outside, join(directory, ".agents"), process.platform === "win32" ? "junction" : "dir");
    const app = harness(directory, [{ id: "escape", path: join(directory, ".agents/skills/escape/SKILL.md") }]);
    await app.start();
    expect(app.agent.read().has("escape")).toBe(false);
    expect([...app.skill.read().keys()]).toEqual(["opencode", "report"]);
    expect([...app.mcp.read().keys()]).toEqual([]);
  });

  it("bounds file size, role count, connector count and skill depth", async () => {
    const directory = await root();
    await put(directory, ".agents/commands/huge.md", "x".repeat(256 * 1024 + 1));
    for (let i = 0; i < 101; i++) await put(directory, `.agents/agents/role-${i}.md`, "Instructions");
    await put(directory, ".agents/skills/a/b/c/d/e/f/SKILL.md", "Depth six");
    await put(directory, ".agents/skills/a/b/c/d/e/f/g/SKILL.md", "Depth seven");
    await put(directory, ".agents/agent.json", JSON.stringify({ schemaVersion: 1, connectors: Array.from({ length: 101 }, (_, i) => `server-${i}`) }));
    const app = harness(directory);
    await app.start();
    expect(app.command.read().size).toBe(0);
    expect(app.agent.read().size).toBe(3);
    expect(app.skill.read().has("f")).toBe(true);
    expect(app.skill.read().has("g")).toBe(false);
    expect(app.diagnostics).toContainEqual({ code: "limit-exceeded", resource: "role" });
    expect([...app.mcp.read().keys()]).toEqual([]);
  });

  it("reloads edits, removals and a newly created .agents directory, then disposes every registration", async () => {
    const directory = await root();
    const otherDirectory = await root();
    const app = harness(directory);
    const other = harness(otherDirectory);
    const cleanup = await app.start(true);
    await other.start(true);
    await put(directory, ".agents/agent.json", JSON.stringify({ schemaVersion: 1, connectors: ["papers"] }));
    const path = await put(directory, ".agents/agents/auditor.md", "First instructions");
    await put(directory, ".agents/commands/review.md", "Review $ARGUMENTS");
    await vi.waitFor(() => expect(app.agent.read().get("auditor")?.system).toBe("First instructions"), { timeout: 4000 });
    await writeFile(path, "Changed instructions");
    await vi.waitFor(() => expect(app.agent.read().get("auditor")?.system).toBe("Changed instructions"), { timeout: 4000 });
    expect(other.agent.read().has("auditor")).toBe(false);
    expect([...other.mcp.read().keys()]).toEqual(["papers", "private"]);
    await rm(path);
    await vi.waitFor(() => expect(app.agent.read().has("auditor")).toBe(false), { timeout: 4000 });
    await cleanup();
    expect(app.command.read().size).toBe(0);
    expect([...app.mcp.read().keys()]).toEqual(["papers", "private"]);
    const reloads = app.agent.reload.mock.calls.length;
    await put(directory, ".agents/agents/after-cleanup.md", "Should stay unloaded");
    await new Promise((done) => setTimeout(done, 80));
    expect(app.agent.reload).toHaveBeenCalledTimes(reloads);
    expect(app.agent.read().has("after-cleanup")).toBe(false);
  });
});
