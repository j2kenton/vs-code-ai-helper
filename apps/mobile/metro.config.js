// Metro config for a pnpm monorepo. pnpm keeps dependencies in isolated,
// symlinked stores rather than a hoisted node_modules, so Metro must be told
// explicitly where modules live and to watch the whole workspace — it must not
// rely on symlink hoisting.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..', '..');

const config = getDefaultConfig(projectRoot);

// Watch the whole monorepo so edits to workspace packages (e.g.
// packages/ensemble-core) trigger rebuilds.
config.watchFolders = [workspaceRoot];

// Resolve modules from the app's own node_modules first, then the workspace
// root's, in addition to Metro's normal upward walk from each requiring
// file's (symlink-resolved) directory.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// pnpm nests each package's own dependencies as siblings inside its
// `.pnpm/<pkg>@<version>/node_modules/` store entry (not hoisted to the
// workspace root), so a package can only resolve ITS OWN transitive deps
// (e.g. `expo` requiring `expo-modules-core`) via Metro's normal upward
// walk from the requiring file's real, symlink-resolved location — that
// walk lands exactly on the store entry's node_modules, where pnpm places
// those sibling symlinks. `disableHierarchicalLookup` would skip that walk
// entirely and break every such transitive resolution (nodeModulesPaths
// above lists only the app's and workspace's OWN node_modules, neither of
// which pnpm hoists transitive deps into) — so hierarchical lookup must
// stay enabled here; only `unstable_enableSymlinks` is needed to make
// Metro follow pnpm's symlinks in the first place.
config.resolver.unstable_enableSymlinks = true;

module.exports = config;
