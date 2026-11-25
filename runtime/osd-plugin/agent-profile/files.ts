import { constants, realpathSync, statSync, watch, type FSWatcher } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type Diagnostic = {
  code: "invalid-config" | "invalid-role" | "invalid-skill" | "invalid-command" | "unsafe-path" | "untrusted-skill" | "limit-exceeded" | "reserved-agent" | "watch-unavailable" | "reload-failed";
  resource: "profile" | "agent.json" | "role" | "skill" | "command";
};
export type Report = (diagnostic: Diagnostic) => void;
const MAX_BYTES = 256 * 1024;

function missing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function contains(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Reject every linked component, including Windows junctions, before reading. */
export class ProfileFiles {
  readonly directories = new Set<string>();
  private entries = 0;

  constructor(readonly workspace: string, readonly root: string, private report: Report) {
    this.directories.add(workspace);
  }

  static async create(directory: string, report: Report, folder = ".agents"): Promise<ProfileFiles> {
    const workspace = await realpath(resolve(directory));
    return new ProfileFiles(workspace, join(workspace, folder), report);
  }

  async checked(path: string) {
    if (!contains(this.root, path)) throw new Error("Outside profile");
    const parts = relative(this.workspace, path).split(sep);
    let current = this.workspace;
    try {
      for (const part of parts) {
        current = join(current, part);
        const stat = await lstat(current);
        if (stat.isSymbolicLink() || !contains(this.workspace, await realpath(current))) {
          this.report({ code: "unsafe-path", resource: "profile" });
          throw new Error("Linked profile path");
        }
        if (stat.isDirectory()) this.directories.add(current);
      }
      return await lstat(path);
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }

  async read(path: string): Promise<string | undefined> {
    const stat = await this.checked(path);
    if (!stat) return undefined;
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Invalid file size or type");
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.size > MAX_BYTES || opened.dev !== stat.dev || opened.ino !== stat.ino) {
        throw new Error("File changed before opening");
      }
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > MAX_BYTES) throw new Error("File too large");
      const after = await this.checked(path);
      if (!after || after.dev !== opened.dev || after.ino !== opened.ino) throw new Error("File replaced during read");
      return buffer.subarray(0, length).toString("utf8");
    } finally {
      await file.close();
    }
  }

  async scan(directory: string, depth: number, accept: (path: string) => boolean): Promise<string[]> {
    const stat = await this.checked(directory);
    if (!stat?.isDirectory()) return [];
    const result: string[] = [];
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      if (++this.entries > 4000 || this.directories.size > 1000) {
        this.report({ code: "limit-exceeded", resource: "profile" });
        throw new Error("Profile scan limit");
      }
      const path = join(directory, name);
      try {
        const entry = await this.checked(path);
        if (entry?.isDirectory() && depth > 0) result.push(...await this.scan(path, depth - 1, accept));
        else if (entry?.isFile() && accept(path)) result.push(path);
      } catch {
        this.report({ code: "unsafe-path", resource: "profile" });
      }
    }
    return result;
  }
}

export class ProfileWatch {
  private watchers = new Map<string, FSWatcher>();

  constructor(private changed: () => void, private report: Report) {}

  sync(profiles: readonly ProfileFiles[]): void {
    const directories = new Set(profiles.flatMap((profile) => [...profile.directories]));
    const roots = new Map<string, Set<string>>();
    for (const profile of profiles) {
      const names = roots.get(profile.workspace) ?? new Set<string>();
      names.add(basename(profile.root));
      roots.set(profile.workspace, names);
    }
    for (const [path, watcher] of this.watchers) {
      if (!directories.has(path)) { watcher.close(); this.watchers.delete(path); }
    }
    for (const path of directories) {
      if (this.watchers.has(path)) continue;
      try {
        const watcher = watch(path, { persistent: false }, (_event, filename) => {
          const names = roots.get(path);
          if (names && filename !== null && !names.has(filename.toString())) return;
          this.changed();
        });
        watcher.on("error", () => {
          watcher.close();
          this.watchers.delete(path);
          this.report({ code: "watch-unavailable", resource: "profile" });
        });
        this.watchers.set(path, watcher);
      } catch {
        this.report({ code: "watch-unavailable", resource: "profile" });
      }
    }
  }

  close(): void {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }
}

export function resourceID(root: string, path: string, skill = false): string {
  if (skill) return basename(path) === "SKILL.md" ? basename(dirname(path)) : basename(path, ".md");
  return relative(root, path.slice(0, -3)).split(sep).join("/");
}

export function skillBoundary(
  privateDirectory: string | undefined,
  workspaceDirectory: string,
  homeDirectory: string,
) {
  // Environment is captured per registration, never written or read at transform time.
  const roots: Array<{ lexical: string; canonical: string }> = [];
  for (const directory of [
    privateDirectory && join(privateDirectory, "skills"),
    join(workspaceDirectory, "skills"),
    join(workspaceDirectory, ".agents", "skills"),
    join(homeDirectory, ".agents", "skills"),
  ]) {
    if (!directory) continue;
    try {
      const lexical = resolve(directory);
      const canonical = realpathSync(directory);
      if (!contains(lexical, canonical) || !contains(canonical, lexical)) continue;
      roots.push({ lexical, canonical });
    } catch { /* Missing roots grant no access. */ }
  }
  return (skill: { id: string; path?: string }): boolean => {
    if (["opencode", "report"].includes(skill.id) && (skill.path === undefined || skill.path === `/builtin/${skill.id}.md`)) return true;
    if (!skill.path || !isAbsolute(skill.path) || basename(skill.path) !== "SKILL.md") return false;
    try {
      const path = skill.path;
      const canonical = realpathSync(path);
      return statSync(path).isFile() && roots.some((root) => contains(root.lexical, path) && contains(root.canonical, canonical));
    } catch { return false; }
  };
}
