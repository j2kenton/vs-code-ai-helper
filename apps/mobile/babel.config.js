module.exports = function (api) {
  api.cache(true);
  return {
    // `unstable_transformImportMeta` because zustand/middleware (v5) reads
    // `import.meta.env.MODE` in its devtools path, and merely importing the
    // module pulls that syntax into the bundle. Metro's Hermes output is not a
    // module, so the browser refuses it outright — "Cannot use 'import.meta'
    // outside a module" — and the app renders a white screen. The transform
    // rewrites it to something Hermes accepts.
    presets: [['babel-preset-expo', { unstable_transformImportMeta: true }]],
  };
};
