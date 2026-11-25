import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");
const { name } = JSON.parse(read("brand.json"));
if (typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9]*(?: [A-Za-z0-9]+)*$/.test(name)) {
  throw new Error("brand.json name must contain letters, digits and single spaces, starting with a letter.");
}

const slug = (value) => value.toLowerCase().replaceAll(" ", "-");
const configPath = "apps/desktop/src-tauri/tauri.conf.json";
const config = JSON.parse(read(configPath));
// The checked-in Tauri config records the last applied name. Keep it until
// every other file is written, so an interrupted sync can be run again.
const previousNames = new Set([
  config.productName,
  config.app.windows[0].title,
  "ResearchMesh Desktop",
  "ResearchMesh",
]);
const replacements = [...previousNames].flatMap((previous) => [
  [previous, name],
  ...(previous.includes(" ") ? [[previous.replaceAll(" ", "."), name.replaceAll(" ", ".")]] : []),
  // The original Rust binary, package and installed Linux paths stay stable.
  ...(previous !== "ResearchMesh" ? [[slug(previous), slug(name)]] : []),
]).filter(([previous, next]) => previous !== next)
  .sort(([a], [b]) => b.length - a.length);
const replacementMap = new Map(replacements);
const pattern = replacements.length > 0
  ? new RegExp([...replacementMap.keys()].map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g")
  : null;

const extensions = new Set([
  ".md", ".json", ".ts", ".tsx", ".rs", ".toml", ".html", ".cff",
  ".yml", ".yaml", ".plist", ".sh", ".mjs", ".py", ".R", ".ps1",
  ".swift", ".mplstyle", ".svg",
]);
const extensionless = new Set(["LICENSE", "bash-rcfile", ".zshenv", ".zshrc"]);
const excluded = new Set([
  "brand.json", "scripts/sync-brand.mjs", "scripts/sync-brand.test.mjs",
  "PROGRESS.md", "CLAUDE.md",
]);
// A source archive has no .git directory; it must still be buildable.
function sourceFiles(dir = "") {
  const ignored = new Set([
    ".git", "node_modules", "target", "dist", "dist-ssr", "dist-osd", "dist-desktop",
    ".agents", ".codex", ".openscience", ".worktrees", ".cache", ".venv",
    ".build", "binaries", "external", "__pycache__", "gen", "videos",
  ]);
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) return [];
    if (path === "apps/desktop/src-tauri/computer-use" || path === "runtime/acp-server") return [];
    if (entry.isDirectory()) return ignored.has(entry.name) ? [] : sourceFiles(path);
    return [path];
  });
}

const files = (existsSync(join(root, ".git"))
  ? execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root, encoding: "utf8",
  }).split("\0").filter(Boolean)
  : sourceFiles()).sort((a, b) => {
  if (a === configPath) return 1;
  if (b === configPath) return -1;
  return a.localeCompare(b);
});

const changed = [];
for (const path of files) {
  if (excluded.has(path) || (!extensions.has(extname(path)) && !extensionless.has(path.split("/").at(-1)))) continue;
  if (!existsSync(join(root, path))) continue;
  if (lstatSync(join(root, path)).isSymbolicLink()) continue;
  const before = read(path);
  // Existing workspace paths and on-disk ownership markers are compatibility
  // identifiers, not branding. Their source lines explicitly opt out.
  const after = before.split(/(?<=\n)/).map((line) => {
    if (line.includes("brand:keep") || !pattern) return line;
    return line.replace(pattern, (value) => replacementMap.get(value));
  }).join("");
  if (after === before) continue;
  changed.push(path);
  if (!process.argv.includes("--check")) writeFileSync(join(root, path), after, "utf8");
}

if (process.argv.includes("--check") && changed.length > 0) {
  console.error(`Branding is out of date. Run pnpm brand:sync:\n${changed.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`${name}: ${changed.length === 0 ? "branding is up to date" : `updated ${changed.length} files`}.`);
}
