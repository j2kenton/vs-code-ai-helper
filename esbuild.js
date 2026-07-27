const esbuild = require("esbuild");
const fs = require("fs");
const { createProductionBuildOptions, createEsbuildProblemMatcherPlugin } = require("./esbuild.config.js");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

// Console chatter ("[watch] build started/finished") is only useful for the
// long-running `watch:esbuild` task; the one-shot production build stays
// quiet, matching its previous behavior before this plugin was factored out.
const esbuildProblemMatcherPlugin = createEsbuildProblemMatcherPlugin({ quiet: !watch });

async function main() {
  // dist/ has no outDir of its own in this build — it only exists because
  // tsconfig.json's default outDir happens to be "dist", so a bare `tsc`
  // (no --noEmit, no -p tsconfig.test.json override) silently mirrors all of
  // src/ into it, tests included. Nothing here regenerates or prunes that
  // tree, so a single stray invocation leaves it there indefinitely — which
  // is how dist/test-host/extensionHost.test.js ended up shipped in the
  // package despite .vscodeignore excluding dist/test/**, and why the same
  // gap can reopen under any other directory name next time. This build only
  // ever needs to produce extension.js, so clearing dist/ first each run
  // guarantees nothing else can silently accumulate in it.
  fs.rmSync("dist", { recursive: true, force: true });

  const ctx = await esbuild.context({
    ...createProductionBuildOptions({ production }),
    plugins: [esbuildProblemMatcherPlugin],
  });

  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
