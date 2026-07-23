const esbuild = require("esbuild");
const fs = require("fs");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: "esbuild-problem-matcher",
  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started");
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(
            `    ${location.file}:${location.line}:${location.column}:`
          );
        }
      });
      console.log("[watch] build finished");
    });
  },
};

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
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    outfile: "dist/extension.js",
    external: ["vscode"],
    logLevel: "silent",
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
