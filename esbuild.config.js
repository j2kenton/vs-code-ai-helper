"use strict";

// Shared production build option factory, consumed by `esbuild.js` (the
// shipping build) — entrypoints, platform, conditions, externals, defines,
// loaders, and plugins. Do not inline build options anywhere else; add new
// build options here instead.

/**
 * @param {{ production?: boolean }} [opts]
 * @returns {import('esbuild').BuildOptions}
 */
function createProductionBuildOptions(opts = {}) {
  const { production = false } = opts;
  return {
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
  };
}

// The problem-matcher plugin only reports build start/end to the console for
// `watch:esbuild`'s VS Code task integration; it never changes the metafile's
// input graph. It is still shared here (rather than left inlined in
// esbuild.js as before) so AC-BASE-03's "share plugins exactly" requirement
// holds literally, not just "in effect" — a future plugin that DOES touch
// build inputs/outputs (a loader hook, a define, an alias) must not be able
// to land in only one of the two consumers again. `quiet` suppresses the
// console output for non-watch invocations (the production build and the
// source-universe resolver), which never want build-tool chatter.
/**
 * @param {{ quiet?: boolean }} [opts]
 * @returns {import('esbuild').Plugin}
 */
function createEsbuildProblemMatcherPlugin(opts = {}) {
  const { quiet = false } = opts;
  return {
    name: "esbuild-problem-matcher",
    setup(build) {
      build.onStart(() => {
        if (!quiet) {
          console.log("[watch] build started");
        }
      });
      build.onEnd((result) => {
        result.errors.forEach(({ text, location }) => {
          console.error(`✘ [ERROR] ${text}`);
          if (location) {
            console.error(`    ${location.file}:${location.line}:${location.column}:`);
          }
        });
        if (!quiet) {
          console.log("[watch] build finished");
        }
      });
    },
  };
}

module.exports = { createProductionBuildOptions, createEsbuildProblemMatcherPlugin };
