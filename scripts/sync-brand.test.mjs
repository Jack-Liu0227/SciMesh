import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const syncScript = fileURLToPath(new URL("./sync-brand.mjs", import.meta.url));

for (const git of [true, false]) {
  test(`brand sync updates all surfaces and preserves installed identities (${git ? "git checkout" : "source archive"})`, () => {
    const root = mkdtempSync(join(tmpdir(), "scimesh-brand-"));
    const put = (path, text) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    const read = (path) => readFileSync(join(root, path), "utf8");
    const sync = (...args) => spawnSync(process.execPath, [join(root, "scripts/sync-brand.mjs"), ...args], {
      cwd: root, encoding: "utf8",
    });
    try {
      if (git) assert.equal(spawnSync("git", ["init", "--quiet", root]).status, 0);
      put("brand.json", '{"name":"SciMesh"}\n');
      put("scripts/sync-brand.mjs", "");
      cpSync(syncScript, join(root, "scripts/sync-brand.mjs"));
      put("apps/desktop/src-tauri/tauri.conf.json", JSON.stringify({
        productName: "ResearchMesh Desktop", identifier: "com.ai4s.workbench",
        app: { windows: [{ title: "ResearchMesh" }] },
      }));
      put("README.md", "ResearchMesh Desktop and ResearchMesh\nresearchmesh-desktop\n");
      put("runtime/provider.ts", 'const helper = "ResearchMesh Computer Use.app";\n');
      put("runtime/skills/core/computer-use/SKILL.md", "Use ResearchMesh Computer Use.\n");
      put("native/helper.swift", 'let title = "ResearchMesh Computer Use"\n');
      put("compatibility.rs", 'let dir = "ResearchMesh"; // brand:keep\nlet crate_name = "researchmesh_lib";\n');
      put("PROGRESS.md", "ResearchMesh Desktop was released yesterday.\n");
      const beforeCheck = sync("--check");
      assert.equal(beforeCheck.status, 1, beforeCheck.stderr);
      assert.equal(read("README.md"), "ResearchMesh Desktop and ResearchMesh\nresearchmesh-desktop\n");
      const first = sync();
      assert.equal(first.status, 0, first.stderr);
      assert.equal(read("README.md"), "SciMesh and SciMesh\nscimesh\n");
      assert.equal(read("runtime/provider.ts"), 'const helper = "SciMesh Computer Use.app";\n');
      assert.equal(read("runtime/skills/core/computer-use/SKILL.md"), "Use SciMesh Computer Use.\n");
      assert.equal(read("native/helper.swift"), 'let title = "SciMesh Computer Use"\n');
      assert.equal(read("compatibility.rs"), 'let dir = "ResearchMesh"; // brand:keep\nlet crate_name = "researchmesh_lib";\n');
      assert.equal(read("PROGRESS.md"), "ResearchMesh Desktop was released yesterday.\n");
      assert.equal(JSON.parse(read("apps/desktop/src-tauri/tauri.conf.json")).identifier, "com.ai4s.workbench");
      assert.equal(sync("--check").status, 0);
      assert.match(sync().stdout, /branding is up to date/);

      // A later name containing the previous name must be replaced once only.
      put("brand.json", '{"name":"SciMesh Lab"}\n');
      const renamed = sync();
      assert.equal(renamed.status, 0, renamed.stderr);
      assert.equal(read("README.md"), "SciMesh Lab and SciMesh Lab\nscimesh-lab\n");
      assert.equal(read("runtime/provider.ts"), 'const helper = "SciMesh Lab Computer Use.app";\n');
      assert.equal(sync("--check").status, 0);

      put("brand.json", '{"name":"bad/path"}\n');
      assert.notEqual(sync().status, 0);
      assert.equal(read("README.md"), "SciMesh Lab and SciMesh Lab\nscimesh-lab\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
