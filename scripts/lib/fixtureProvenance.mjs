/**
 * Shared fixture-provenance gate (plan §3.10's checked-in evidence-base
 * discipline, generalized from the task-progress tree per the implementation
 * review). Every fixture tree carries a README.md whose table rows (FIRST
 * cell, backticked filename) record what each fixture reproduces — the
 * production writer whose persisted output it mirrors, or the extractor /
 * digest rule it pins. The match is bidirectional and the walk fails closed
 * at its edges: a fixture with no row, a row naming no fixture, and any
 * entry the walk could not match against a row (stray file, nested
 * directory, unexpected extension) are all failures, never skips — so a
 * fixture cannot be added or dropped without its provenance record moving
 * with it.
 *
 * Layouts:
 *  - "subdirectories" (test-fixtures/task-progress): fixtures live at
 *    <tree>/<dir>/<name> and rows live under the matching "## <dir>/" README
 *    section, so identical names in different subdirectories stay
 *    distinguishable. Later cells may mention other fixtures in prose
 *    without registering a row for them.
 *  - "flat" (test-fixtures/workflow-routes, workflow-path-consumers,
 *    workflow-production-sources): fixtures live at <tree>/<name> and rows
 *    may sit in any README table — there is no name collision to scope by
 *    section. This is deliberate: flat trees have NO section scoping, so a
 *    fixture filename backticked in the FIRST cell of ANY table in the
 *    README registers as a provenance row. If a flat tree's README ever
 *    gains a second, unrelated table, do not backtick fixture filenames in
 *    its first column (or migrate that tree to the "subdirectories"
 *    layout).
 */
import fs from "node:fs";
import path from "node:path";

function toPosix(p) {
  return p.split(path.sep).join("/");
}

/** Backticked names in a table line's FIRST cell that match fixtureFileRe. */
function rowNamesOf(line, fixtureFileRe) {
  if (!line.startsWith("|")) return [];
  const firstCell = line.split("|")[1] ?? "";
  const names = [];
  for (const match of firstCell.matchAll(/`([^`]+)`/g)) {
    if (fixtureFileRe.test(match[1])) names.push(match[1]);
  }
  return names;
}

/**
 * Verify one fixture tree against its provenance README. Records one failure
 * message per violation through `record` (never throws on tree content), so
 * callers accumulate them into their existing failure lists.
 *
 * @param {object} options
 * @param {string} options.repoRoot absolute repository root (for messages)
 * @param {string} options.fixturesDir absolute path of the fixture tree root
 * @param {RegExp} options.fixtureFileRe pattern a fixture FILENAME must match
 * @param {string} options.fixtureFileDescription suffix for messages, e.g. ".json"
 * @param {"subdirectories"|"flat"} options.layout tree shape (see module header)
 * @param {(message: string) => void} options.record failure recorder
 */
export function verifyFixtureProvenance({
  repoRoot,
  fixturesDir,
  fixtureFileRe,
  fixtureFileDescription,
  layout,
  record,
}) {
  if (layout !== "subdirectories" && layout !== "flat") {
    throw new Error(`Unknown fixture-provenance layout ${JSON.stringify(layout)}.`);
  }
  const relDir = toPosix(path.relative(repoRoot, fixturesDir));
  const readmePath = path.join(fixturesDir, "README.md");
  if (!fs.existsSync(readmePath)) {
    record(
      `${relDir}/README.md does not exist — the fixture-provenance record is required evidence (plan §3.10).`
    );
    return;
  }
  if (!fs.statSync(readmePath).isFile()) {
    record(
      `${relDir}/README.md is not a regular file — the fixture-provenance record is required evidence (plan §3.10).`
    );
    return;
  }
  const readmeLines = fs.readFileSync(readmePath, "utf8").split(/\r?\n/);

  if (layout === "flat") {
    const onDisk = new Set();
    for (const entry of fs.readdirSync(fixturesDir, { withFileTypes: true })) {
      if (entry.name === "README.md") continue; // proven a regular file above
      if (entry.isFile() && fixtureFileRe.test(entry.name)) {
        onDisk.add(entry.name);
      } else {
        record(
          `${relDir}/${entry.name} is not a top-level ${fixtureFileDescription} fixture — the provenance check ` +
            `matches only ${relDir}/<name>${fixtureFileDescription} against README rows, so this entry would ` +
            `escape it. Flatten or remove it.`
        );
      }
    }
    const inReadme = new Set();
    for (const line of readmeLines) {
      for (const name of rowNamesOf(line, fixtureFileRe)) inReadme.add(name);
    }
    for (const file of onDisk) {
      if (!inReadme.has(file)) {
        record(
          `${relDir}/${file} has no provenance row in ${relDir}/README.md — every fixture must record what it ` +
            `reproduces or pins (plan §3.10).`
        );
      }
    }
    for (const row of inReadme) {
      if (!onDisk.has(row)) {
        record(
          `README provenance row \`${row}\` in ${relDir}/README.md names a fixture that no longer exists — ` +
            `remove the stale row.`
        );
      }
    }
    return;
  }

  // "subdirectories" layout. Fixture files on disk, grouped by immediate
  // subdirectory. Fail closed at both edges of the walk: a root-level entry
  // other than the README has no "## <dir>/" section it could belong to, and
  // an entry inside a fixture directory that is not a plain fixture file
  // (nested directory or stray file) would never be matched against a
  // provenance row — both are errors, never skips.
  const onDisk = new Map();
  for (const entry of fs.readdirSync(fixturesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      if (entry.name !== "README.md") {
        record(
          `${relDir}/${entry.name} sits outside any fixture directory — fixtures must live at ` +
            `${relDir}/<dir>/<name>${fixtureFileDescription} so a "## <dir>/" README section can carry their ` +
            `provenance rows.`
        );
      }
      continue;
    }
    const names = new Set();
    for (const child of fs.readdirSync(path.join(fixturesDir, entry.name), { withFileTypes: true })) {
      if (child.isFile() && fixtureFileRe.test(child.name)) {
        names.add(child.name);
      } else {
        record(
          `${relDir}/${entry.name}/${child.name} is not a top-level ${fixtureFileDescription} fixture — the ` +
            `provenance check matches only <dir>/<name>${fixtureFileDescription} against README rows, so this ` +
            `entry would escape it. Flatten or remove it.`
        );
      }
    }
    onDisk.set(entry.name, names);
  }

  // README rows, grouped by "## <dir>/" section. The section name is
  // captured up to the slash without an alphabet restriction, so a fixture
  // directory whose name carries a dot or other filename character still
  // matches its section instead of failing as "no section".
  const inReadme = new Map();
  let section = null;
  for (const line of readmeLines) {
    const heading = /^##\s+([^\s/]+)\//.exec(line);
    if (heading) {
      section = heading[1];
      if (!inReadme.has(section)) inReadme.set(section, new Set());
      continue;
    }
    if (section === null) continue;
    for (const name of rowNamesOf(line, fixtureFileRe)) inReadme.get(section).add(name);
  }

  for (const [dir, files] of onDisk) {
    const rows = inReadme.get(dir);
    if (!rows) {
      record(
        `${relDir}/${dir}/ has no "## ${dir}/" section in the provenance README — every fixture directory needs ` +
          `provenance rows.`
      );
      continue;
    }
    for (const file of files) {
      if (!rows.has(file)) {
        record(
          `${relDir}/${dir}/${file} has no provenance row in the README — every fixture must name the production ` +
            `writer (or scenario) it reproduces (plan §3.10).`
        );
      }
    }
    for (const row of rows) {
      if (!files.has(row)) {
        record(
          `README provenance row \`${row}\` in section "## ${dir}/" names a fixture that no longer exists — ` +
            `remove the stale row.`
        );
      }
    }
  }
  for (const dir of inReadme.keys()) {
    if (!onDisk.has(dir)) {
      record(`README section "## ${dir}/" has no matching fixture directory ${relDir}/${dir}/.`);
    }
  }
}
