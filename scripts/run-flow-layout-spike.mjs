import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const workspace = path.resolve(process.cwd());
const temporaryDirectory = await mkdtemp(
  path.join(workspace, ".flow-layout-spike-"),
);

if (!temporaryDirectory.startsWith(`${workspace}${path.sep}`)) {
  throw new Error("Refusing to use a spike directory outside the workspace.");
}

const outputFile = path.join(temporaryDirectory, "spike.mjs");

try {
  await build({
    entryPoints: [
      path.join(workspace, "src/features/process-flow/flow-layout-spike.ts"),
    ],
    outfile: outputFile,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    sourcemap: false,
    logLevel: "silent",
  });

  const { compareLayoutEngines, LAYOUT_SPIKE_FIXTURES } = await import(
    pathToFileURL(outputFile).href
  );
  const metrics = await compareLayoutEngines(LAYOUT_SPIKE_FIXTURES);
  console.log("FLOW_LAYOUT_SPIKE", JSON.stringify(metrics));
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
