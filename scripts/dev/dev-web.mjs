import { join } from "node:path";
import "../sync-brand.mjs";
import {
  ensureOsdSidecar,
  executableSuffix,
  hostTriple,
  run,
  stageGatewayRuntime,
} from "./sidecars.mjs";

try {
  const triple = hostTriple();
  ensureOsdSidecar(triple);
  const stage = stageGatewayRuntime(triple);
  const osd = join(stage.binaries, `osd${executableSuffix}`);
  run(osd, ["server", "--resources", stage.resources]);
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
