/// <reference lib="es2021.string" />
// Trusted OSD discovery, scoped to this location. Native project discovery is disabled.
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { ProfileFiles, ProfileWatch, resourceID, skillBoundary, type Diagnostic, type Report } from "./agent-profile/files";
import {
  parseCommand, parseProject, parseRole, parseSkill, runtimeYaml,
  type Command, type ModelRef, type ParseYaml, type Project, type Role, type Selection, type Skill,
} from "./agent-profile/schema";

export type AgentProfileDiagnostic = Diagnostic;
export type AgentProfileOptions = { parseYaml?: ParseYaml; onDiagnostic?: Report; watch?: boolean; debounceMs?: number; homeDirectory?: string };
type Rule = { action: string; resource: string; effect: "allow" | "ask" | "deny" };
type Agent = {
  id: string; name: string; model?: ModelRef; description?: string; system?: string;
  mode: "primary" | "subagent" | "all"; hidden: boolean; permissions: Rule[];
};
type Registration = { dispose(): Promise<void> };
type Domain<Editor> = { transform(callback: (editor: Editor) => void): Promise<Registration>; reload(): Promise<void> };
type Prompt = { readonly text: string };
type Invocation = { readonly sessionID: string; readonly prompt: Prompt; readonly delivery: "queue" | "steer" };
type Definition = { name: string; description?: string; execute(input: Invocation): Promise<void> };

/** Only the pinned plugin interfaces used here; no runtime dependency on the SDK. */
export type AgentProfileContext = {
  readonly location: { readonly directory: string };
  readonly agent: Domain<{
    list(): readonly Agent[];
    get(id: string): Agent | undefined;
    update(id: string, update: (agent: Agent) => void): void;
  }>;
  readonly skill: Domain<{ list(): readonly { id: string; path?: string }[]; add(skill: Skill): void; remove(id: string): void }>;
  readonly command: Domain<{ add(command: Definition): void }>;
  readonly mcp: Domain<{ list(): readonly (readonly [string, unknown])[]; remove(name: string): void }>;
  readonly session: { prompt(input: Prompt & { sessionID: string; delivery: "queue" | "steer" }): Promise<unknown> };
};

const reserved = new Set(["build", "plan", "general", "explore", "title", "summary", "compaction", "reviewer"]);
type Snapshot = { project: Project; roles: Role[]; skills: Skill[]; commands: Command[]; files: ProfileFiles[] };

async function load(
  directory: string,
  homeDirectory: string,
  privateDirectory: string | undefined,
  parseYaml: ParseYaml,
  report: Report,
): Promise<Snapshot> {
  const files = await ProfileFiles.create(directory, report);
  const projectSkills = await ProfileFiles.create(directory, report, "skills");
  const roots = [
    { files: projectSkills, root: projectSkills.root },
    { files, root: join(files.root, "skills") },
  ];
  const home = await ProfileFiles.create(homeDirectory, report);
  if (home.root !== files.root) roots.push({ files: home, root: join(home.root, "skills") });
  if (privateDirectory) {
    const privateSkills = await ProfileFiles.create(privateDirectory, report, "skills");
    roots.push({ files: privateSkills, root: privateSkills.root });
  }
  let project: Project = { agents: new Map() };
  try {
    const source = await files.read(join(files.root, "agent.json"));
    if (source !== undefined) project = parseProject(source);
  } catch {
    // A malformed connector restriction must not restore all global servers.
    project = { agents: new Map(), connectors: [] };
    report({ code: "invalid-config", resource: "agent.json" });
  }
  const roles = new Map<string, Role>();
  try {
    const paths = await files.scan(join(files.root, "agents"), 0, (path) => path.endsWith(".md"));
    if (paths.length > 100) report({ code: "limit-exceeded", resource: "role" });
    else {
      for (const path of paths) {
        try {
          const id = basename(path, ".md");
          if (reserved.has(id.toLowerCase()) || roles.has(id)) {
            report({ code: "reserved-agent", resource: "role" });
            continue;
          }
          const source = await files.read(path);
          if (source !== undefined) roles.set(id, parseRole(id, source, parseYaml));
        } catch { report({ code: "invalid-role", resource: "role" }); }
      }
    }
  } catch { report({ code: "unsafe-path", resource: "role" }); }
  const skills: Skill[] = [];
  // Highest priority first. Lower layers only contribute IDs not yet loaded.
  const selected = new Set<string>();
  for (const { files: profile, root: skillRoot } of roots) try {
    const paths = await profile.scan(skillRoot, 6, (path) => basename(path) === "SKILL.md" && dirname(path) !== skillRoot);
    const seen = new Set<string>();
    if (paths.length > 1000) report({ code: "limit-exceeded", resource: "skill" });
    for (const path of paths.sort().slice(0, 1000)) {
      try {
        const source = await profile.read(path);
        const id = resourceID(skillRoot, path, true);
        if (seen.has(id)) throw new Error("Duplicate skill id");
        if (source === undefined) continue;
        const skill = parseSkill(id, path, source, parseYaml);
        seen.add(id);
        if (!selected.has(id)) { skills.push(skill); selected.add(id); }
      } catch { report({ code: "invalid-skill", resource: "skill" }); }
    }
  } catch { report({ code: "unsafe-path", resource: "skill" }); }
  const commands: Command[] = [];
  const commandRoot = join(files.root, "commands");
  try {
    const paths = await files.scan(commandRoot, 0, (path) => path.endsWith(".md"));
    if (paths.length > 100) report({ code: "limit-exceeded", resource: "command" });
    for (const path of paths.slice(0, 100)) {
      try {
        const source = await files.read(path);
        if (source !== undefined) commands.push(parseCommand(resourceID(commandRoot, path), source, parseYaml));
      } catch { report({ code: "invalid-command", resource: "command" }); }
    }
  } catch { report({ code: "unsafe-path", resource: "command" }); }
  return { project, roles: [...roles.values()], skills, commands, files: roots.map((root) => root.files) };
}

function selectedModel(selection: Selection | undefined, fallback: ModelRef | undefined): ModelRef | undefined {
  const model = selection?.model ?? fallback;
  return model ? { ...model, ...(selection?.variant === undefined ? {} : { variant: selection.variant }) } : undefined;
}

export async function registerAgentProfile(ctx: AgentProfileContext, options: AgentProfileOptions = {}): Promise<() => Promise<void>> {
  const report: Report = options.onDiagnostic ?? ((diagnostic) => console.warn("[agent-profile]", diagnostic));
  const parseYaml = options.parseYaml ?? runtimeYaml;
  const privateDirectory = process.env.OPENCODE_CONFIG_DIR;
  const homeDirectory = options.homeDirectory ?? homedir();
  let snapshot = await load(ctx.location.directory, homeDirectory, privateDirectory, parseYaml, report);
  let skillIDs: string[] = [];
  let agentReady = false;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = Promise.resolve();
  const registrations: Registration[] = [];
  const reload = () => {
    pending = pending.then(async () => {
      if (closed) return;
      const next = await load(ctx.location.directory, homeDirectory, privateDirectory, parseYaml, report);
      if (closed) return;
      snapshot = next;
      syncWatch();
      await ctx.skill.reload();
      await ctx.mcp.reload();
      await ctx.agent.reload();
      await ctx.command.reload();
    }).catch(() => { report({ code: "reload-failed", resource: "profile" }); });
  };
  const watcher = new ProfileWatch(() => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(reload, Math.max(20, options.debounceMs ?? 100));
    timer.unref();
  }, report);
  const syncWatch = () => {
    if (options.watch !== false) watcher.sync(snapshot.files);
  };
  const cleanup = async () => {
    closed = true;
    if (timer) clearTimeout(timer);
    watcher.close();
    await pending;
    for (const registration of registrations.splice(0).reverse()) await registration.dispose();
  };
  try {
    registrations.push(await ctx.skill.transform((editor) => {
      const allowed = skillBoundary(privateDirectory, ctx.location.directory, homeDirectory);
      for (const skill of editor.list()) {
        if (!allowed(skill)) {
          editor.remove(skill.id);
          report({ code: "untrusted-skill", resource: "skill" });
        }
      }
      for (const skill of snapshot.skills) editor.add(skill);
      const next = editor.list().map((skill) => skill.id).sort();
      if (next.join("\0") !== skillIDs.join("\0")) {
        skillIDs = next;
        if (agentReady && !closed) queueMicrotask(() => {
          if (!closed) void ctx.agent.reload().catch(() => report({ code: "reload-failed", resource: "profile" }));
        });
      }
    }));
    registrations.push(await ctx.mcp.transform((editor) => {
      const allowed = snapshot.project.connectors;
      if (allowed === undefined) return;
      for (const [name] of editor.list()) if (!allowed.includes(name)) editor.remove(name);
    }));
    registrations.push(await ctx.agent.transform((editor) => {
      const project = snapshot.project;
      for (const current of editor.list()) {
        const model = selectedModel(project.agents.get(current.id), project.model ?? current.model);
        if (model) editor.update(current.id, (agent) => { agent.model = model; });
      }
      for (const role of snapshot.roles) {
        const existing = editor.get(role.id);
        const parent = role.mode === "primary"
          ? editor.get("build") ?? editor.get("general")
          : editor.get("general") ?? editor.get("build");
        const permissions: Rule[] = parent?.permissions.map((rule) => ({ ...rule })) ?? [{ action: "*", resource: "*", effect: "deny" }];
        for (const rule of existing?.permissions ?? []) if (rule.effect === "deny") permissions.push({ ...rule });
        if (role.mode === "subagent") {
          permissions.push({ action: "task", resource: "*", effect: "deny" }, { action: "subagent", resource: "*", effect: "deny" });
        }
        if (role.skills !== undefined) {
          if (role.skills.length === 0) permissions.push({ action: "skill", resource: "*", effect: "deny" });
          else for (const id of skillIDs) if (!role.skills.includes(id)) permissions.push({ action: "skill", resource: id, effect: "deny" });
        }
        for (const connector of role.blockedConnectors) {
          permissions.push({ action: `${connector.replace(/[^a-zA-Z0-9_-]/g, "_")}_*`, resource: "*", effect: "deny" });
        }
        const model = selectedModel(project.agents.get(role.id), role.model ?? project.model ?? parent?.model);
        editor.update(role.id, (agent) => {
          agent.name = role.id;
          agent.system = role.system;
          agent.description = role.description ?? role.id;
          agent.mode = role.mode;
          agent.hidden = false;
          agent.permissions = permissions;
          agent.model = model;
        });
      }
    }));
    agentReady = true;
    registrations.push(await ctx.command.transform((editor) => {
      for (const command of snapshot.commands) editor.add({
        name: command.name,
        description: command.description,
        async execute(input) {
          await ctx.session.prompt({
            ...input.prompt,
            sessionID: input.sessionID,
            text: command.template.replaceAll("$ARGUMENTS", () => input.prompt.text),
            delivery: input.delivery,
          });
        },
      });
    }));
    syncWatch();
    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
