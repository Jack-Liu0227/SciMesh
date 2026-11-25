export type ModelRef = { providerID: string; id: string; variant?: string };
export type Selection = { model?: ModelRef; variant?: string };
export type Project = {
  model?: ModelRef;
  agents: Map<string, Selection>;
  connectors?: string[];
};
export type Role = {
  id: string;
  description?: string;
  mode: "primary" | "subagent";
  model?: ModelRef;
  skills?: string[];
  blockedConnectors: string[];
  system: string;
};
export type Skill = { id: string; name: string; path: string; description?: string; content: string; autoinvoke?: boolean };
export type Command = { name: string; description?: string; template: string };
export type ParseYaml = (source: string) => unknown;

const forbidden = new Set(["__proto__", "constructor", "prototype"]);
const segment = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,127}$/u;
const secret = /(?:\b(?:sk[-_]|gh[pousr]_|github_pat_|xox[baprs]-|AKIA)[a-z0-9_-]{8,}|\bBearer\s+\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----|\{(?:env|file):|\$\{|:\/\/[^\s/]*@)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected an object");
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Error("Invalid object prototype");
  for (const key of Object.keys(value)) if (forbidden.has(key)) throw new Error("Unsafe key");
  return value;
}

function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  const result = record(value);
  if (Object.keys(result).some((key) => !allowed.includes(key))) throw new Error("Unsupported field");
  return result;
}

function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max || value.includes("\0") || secret.test(value)) {
    throw new Error("Invalid text");
  }
  return value;
}

export function identifier(value: unknown): string {
  const id = text(value, 192);
  if (!id.split("/").every((part) => segment.test(part) && !forbidden.has(part.toLowerCase()))) {
    throw new Error("Invalid identifier");
  }
  return id;
}

function atom(value: unknown): string {
  const id = identifier(value);
  if (id.includes("/")) throw new Error("Invalid name");
  return id;
}

function configName(value: unknown): string {
  const id = text(value, 128);
  if (!/^[\p{L}\p{N}_-]+$/u.test(id) || forbidden.has(id.toLowerCase())) throw new Error("Invalid configuration name");
  return id;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("Invalid list");
  return [...new Set(value.map(identifier))];
}

function model(value: unknown): ModelRef {
  const source = text(value, 256);
  const slash = source.indexOf("/");
  if (slash < 1 || !/^[a-zA-Z0-9._-]+$/.test(source.slice(0, slash))) throw new Error("Invalid provider");
  if (forbidden.has(source.slice(0, slash).toLowerCase())) throw new Error("Invalid provider");
  const id = source.slice(slash + 1);
  if (!id || !/^[a-zA-Z0-9._:/-]+$/.test(id) || id.includes("..") || secret.test(id)) {
    throw new Error("Invalid model");
  }
  return { providerID: source.slice(0, slash), id };
}

export function parseProject(source: string): Project {
  const project = fields(JSON.parse(source), ["schemaVersion", "model", "agent", "connectors"]);
  if (project.schemaVersion !== 1) throw new Error("Unsupported version");
  const agents = new Map<string, Selection>();
  if (project.agent !== undefined) {
    const values = record(project.agent);
    if (Object.keys(values).length > 100) throw new Error("Too many overrides");
    for (const [key, value] of Object.entries(values)) {
      const id = configName(key);
      const selection = fields(value, ["model", "variant"]);
      agents.set(id, {
        ...(selection.model === undefined ? {} : { model: model(selection.model) }),
        ...(selection.variant === undefined ? {} : { variant: atom(selection.variant) }),
      });
    }
  }
  return {
    agents,
    ...(project.model === undefined ? {} : { model: model(project.model) }),
    ...(project.connectors === undefined ? {} : { connectors: stringList(project.connectors).map(configName) }),
  };
}

export function runtimeYaml(source: string): unknown {
  if ("Bun" in globalThis) {
    const bun: unknown = Reflect.get(globalThis, "Bun");
    if (bun && typeof bun === "object" && "YAML" in bun) {
      const yaml: unknown = bun.YAML;
      if (yaml && typeof yaml === "object" && "parse" in yaml && typeof yaml.parse === "function") {
        return yaml.parse(source);
      }
    }
  }
  // JSON frontmatter remains usable in a Node host. Never approximate YAML.
  return JSON.parse(source);
}

export function markdown(source: string, parseYaml: ParseYaml): { data: Record<string, unknown>; body: string } {
  const normalized = source.replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(normalized);
  if (!match) {
    if (/^---(?:\r?\n|$)/.test(normalized)) throw new Error("Unclosed frontmatter");
    return { data: {}, body: normalized };
  }
  const header = match[1].trim();
  return { data: header ? record(header.startsWith("{") ? JSON.parse(header) : parseYaml(header)) : {}, body: normalized.slice(match[0].length) };
}

export function parseRole(id: string, source: string, parseYaml: ParseYaml): Role {
  atom(id);
  const parsed = markdown(source, parseYaml);
  const data = fields(parsed.data, ["description", "mode", "model", "skills", "blockedConnectors"]);
  if (data.mode !== undefined && data.mode !== "primary" && data.mode !== "subagent") throw new Error("Invalid mode");
  if (parsed.body.length > 50000 || secret.test(parsed.body)) throw new Error("Invalid instructions");
  return {
    id,
    mode: data.mode ?? "subagent",
    system: parsed.body,
    ...(data.description === undefined ? {} : { description: text(data.description, 1000) }),
    ...(data.model === undefined ? {} : { model: model(data.model) }),
    ...(data.skills === undefined ? {} : { skills: stringList(data.skills) }),
    blockedConnectors: data.blockedConnectors === undefined ? [] : stringList(data.blockedConnectors).map(atom),
  };
}

export function parseSkill(id: string, path: string, source: string, parseYaml: ParseYaml): Skill {
  identifier(id);
  const parsed = markdown(source, parseYaml);
  const { data } = parsed;
  const seen = new Set<object>();
  let count = 0;
  function metadata(value: unknown, depth: number): void {
    if (++count > 4096 || depth > 16) throw new Error("Metadata limit");
    if (typeof value === "string") { text(value, 256 * 1024); return; }
    if (value === null || typeof value === "number" || typeof value === "boolean") return;
    if (!value || typeof value !== "object" || seen.has(value)) throw new Error("Invalid metadata");
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) metadata(item, depth + 1);
    } else {
      for (const [key, item] of Object.entries(record(value))) {
        if (/^(?:api[-_]?key|password|secret|credentials?|access[-_]?token|authorization)$/i.test(key)) throw new Error("Secret metadata");
        metadata(item, depth + 1);
      }
    }
    seen.delete(value);
  }
  metadata(data, 0);
  if (secret.test(source)) throw new Error("Secret skill content");
  function boolean(value: unknown): boolean | undefined {
    if (typeof value === "boolean") return value;
    if (typeof value !== "string" && typeof value !== "number") return undefined;
    const normalized = String(value).trim().toLowerCase();
    if (["true", "yes", "on", "1"].includes(normalized)) return true;
    if (["false", "no", "off", "0"].includes(normalized)) return false;
    return undefined;
  }
  const settings = isRecord(data.metadata) ? record(data.metadata) : {};
  const autoinvoke = boolean(settings["opencode/autoinvoke"]) ?? (boolean(data["disable-model-invocation"]) ? false : undefined);
  // Match native Skill.Info: display and invocation metadata plus the full body.
  return {
    id,
    name: data.name === undefined ? id : text(data.name, 192),
    path,
    ...(data.description === undefined ? {} : { description: text(data.description, 8000) }),
    ...(autoinvoke === undefined ? {} : { autoinvoke }),
    content: parsed.body,
  };
}

export function parseCommand(name: string, source: string, parseYaml: ParseYaml): Command {
  identifier(name);
  const parsed = markdown(source, parseYaml);
  const data = fields(parsed.data, ["description"]);
  if (secret.test(parsed.body)) throw new Error("Invalid template");
  return {
    name,
    template: parsed.body,
    ...(data.description === undefined ? {} : { description: text(data.description, 1000) }),
  };
}
