/**
 * Push to the user's phone when a round needs them, finishes, complains, or
 * the runner goes quiet. Reads ONLY what the runner already publishes under
 * each workspace's `.ensemble/relay-v1/` — it starts nothing and changes
 * nothing about any task.
 *
 * Target: a single line in ~/.devbox-notify-url (an ntfy topic URL, or any
 * endpoint that accepts a POST body). No file means no pushes — nothing
 * leaves this box unless that file exists. That is the off switch.
 *
 * What leaves the box: the workspace name, the task name, the stage, and the
 * first 180 characters of notification text the extension had already written
 * for the user. Never file contents, diffs, prompts or model output.
 *
 *   node notify-watch.mjs            # loop every 30s
 *   node notify-watch.mjs --once     # one pass, for testing
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const HOME = os.homedir();
const URL_FILE = path.join(HOME, ".devbox-notify-url");
const STATE_FILE = path.join(HOME, ".devbox-logs", "notify-state.json");
const LOG_FILE = path.join(HOME, ".devbox-logs", "notify-watch.log");
const WORKSPACES_GLOB_ROOT = "/workspace";
const POLL_MS = 30_000;
/** A mirror older than this, with work in flight, means the runner is gone. */
const SILENT_MS = 3 * 60_000;
/** Matches the runner's own staleness limit for the decisions mirror. */
const DECISIONS_FRESH_MS = 90_000;

function log(line) {
  const stamped = `${new Date().toISOString()} ${line}\n`;
  try {
    fs.appendFileSync(LOG_FILE, stamped);
  } catch {
    process.stdout.write(stamped);
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function loadState() {
  return readJson(STATE_FILE) ?? {};
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
  } catch (error) {
    log(`could not save state: ${String(error)}`);
  }
}

function pushUrl() {
  try {
    const url = fs.readFileSync(URL_FILE, "utf8").trim();
    return url.length > 0 ? url : undefined;
  } catch {
    return undefined;
  }
}

async function push(event) {
  const url = pushUrl();
  if (url === undefined) {
    log(`no ${URL_FILE}; would have sent: ${event.title} — ${event.body}`);
    return;
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Title: event.title,
        Priority: event.urgent ? "high" : "default",
        Tags: event.tags ?? "robot",
      },
      body: event.body,
    });
    if (!response.ok) {
      log(`push refused (${response.status}) for: ${event.title}`);
      return;
    }
    log(`pushed: ${event.title} — ${event.body}`);
  } catch (error) {
    // A failed push must never end the watch: the next pass tries again.
    log(`push failed (${String(error)}) for: ${event.title}`);
  }
}

/** The last `count` notification records, oldest first. */
function tailNotifications(file, count) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return lines
    .slice(-count)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined; // a torn final line; the next pass sees it whole
      }
    })
    .filter((entry) => entry !== undefined && typeof entry.at === "string");
}

function shorten(text, limit = 180) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function workspaceRelays() {
  let entries;
  try {
    entries = fs.readdirSync(WORKSPACES_GLOB_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      relay: path.join(WORKSPACES_GLOB_ROOT, entry.name, ".ensemble", "relay-v1"),
    }))
    .filter((candidate) => fs.existsSync(path.join(candidate.relay, "operations-v1.json")));
}

async function pass(state) {
  const now = Date.now();
  for (const { name, relay } of workspaceRelays()) {
    const previous = state[name] ?? {};
    const next = { ...previous };
    const snapshot = readJson(path.join(relay, "operations-v1.json"));
    if (snapshot === undefined) {
      // Unreadable or a torn write: say nothing rather than guess.
      continue;
    }
    const roots = (snapshot.operations ?? []).filter((op) => op.parentId === undefined);
    const age = now - snapshot.writtenAt;
    const running = roots.length > 0;
    const label = roots[0]?.taskName ?? name;

    // 1. The runner went quiet with work in flight — the overnight case.
    if (age > SILENT_MS && previous.running === true) {
      if (previous.silentSince === undefined) {
        next.silentSince = snapshot.writtenAt;
        await push({
          title: `${label}: the runner went quiet`,
          body: `No report for ${Math.round(age / 60_000)} min while "${shorten(previous.runningLabel ?? "a round", 60)}" was running. Its outcome is unknown.`,
          urgent: true,
          tags: "warning",
        });
      }
    } else if (age <= SILENT_MS) {
      next.silentSince = undefined;
    }

    // 2. A round finished (roots went away while the runner kept reporting).
    if (previous.running === true && !running && age <= SILENT_MS) {
      const last = tailNotifications(path.join(relay, "notifications-v1.jsonl"), 1)[0];
      await push({
        title: `${label}: finished`,
        body: shorten(last?.message ?? `"${previous.runningLabel ?? "the round"}" is no longer running.`),
        urgent: true,
        tags: "white_check_mark",
      });
    }
    next.running = running;
    next.runningLabel = roots[0]?.label;

    // 3. It is waiting for an answer.
    const decisions = readJson(path.join(relay, "decisions-v1.json"));
    const pending =
      decisions !== undefined && now - decisions.writtenAt <= DECISIONS_FRESH_MS
        ? (decisions.decisions ?? []).length
        : 0;
    const blocked = roots.some((op) => op.waitingForUser === true);
    const needsYou = pending > 0 || blocked;
    if (needsYou && previous.needsYou !== true) {
      await push({
        title: `${label}: needs you`,
        body: blocked
          ? `A running round is paused waiting for your answer.`
          : `${pending} question${pending === 1 ? "" : "s"} waiting in the chat.`,
        urgent: true,
        tags: "question",
      });
    }
    next.needsYou = needsYou;

    // 4. New warnings and errors, exactly as the extension worded them.
    const notes = tailNotifications(path.join(relay, "notifications-v1.jsonl"), 40);
    const since = previous.lastNoteAt ?? new Date(now - 60_000).toISOString();
    const fresh = notes.filter((note) => note.at > since);
    if (notes.length > 0) {
      next.lastNoteAt = notes[notes.length - 1].at;
    }
    const problems = fresh.filter((note) => note.level === "warning" || note.level === "error");
    // One push for a burst, not one per line.
    if (problems.length === 1) {
      await push({
        title: `${label}: ${problems[0].level}`,
        body: shorten(problems[0].message),
        tags: problems[0].level === "error" ? "rotating_light" : "warning",
      });
    } else if (problems.length > 1) {
      await push({
        title: `${label}: ${problems.length} problems reported`,
        body: shorten(problems.map((p) => p.message).join(" // ")),
        tags: "warning",
      });
    }

    state[name] = next;
  }
  saveState(state);
}

const once = process.argv.includes("--once");
const state = loadState();
log(`notify-watch starting (${once ? "one pass" : `every ${POLL_MS / 1000}s`}); target ${pushUrl() ?? "NOT CONFIGURED"}`);
await pass(state);
if (!once) {
  setInterval(() => {
    pass(state).catch((error) => log(`pass failed: ${String(error)}`));
  }, POLL_MS);
}
