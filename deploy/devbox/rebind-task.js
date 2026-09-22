// Rebind a task copied from another machine so it works on this one.
//   node rebind-task.js <task folder> <workspace root> [new folder name]
//
// Task state is gitignored, so moving a task between machines means copying
// `.ensemble/<task>/` by hand. Two things inside it name the machine it came
// from, and BOTH have to be rewritten. Missing either produces a task that
// lists normally and then refuses to do anything, which is a miserable way to
// find out.
//
// 1. `task-progress.json`'s `ownership` block. A mismatched
//    `ownership.workspaceRoot` makes `resolveTaskContext` fail closed for
//    every caller that cannot show a prompt - i.e. everything on a headless
//    runner - so the task lists and then refuses every action.
//
// 2. `chat-v1.json`'s `taskBindingId`. This one cost an hour on 2026-09-22.
//    The binding is a digest of the task's OWNERSHIP (chatHistoryStore.ts,
//    `resolveDefaultTaskBindingV1`), so rewriting ownership in (1) and
//    leaving the chat document alone leaves the two disagreeing, and every
//    stage action dies with:
//
//      Error: interaction binding conflicts with this document's
//      authoritative task binding
//
//    On the box that surfaced only as "Draft Task with AI: failed" ten
//    seconds in, with no run file, no provider output and nothing in the
//    Ensemble log - the CLI was never invoked at all. The binding cannot
//    safely be recomputed here (it belongs to the extension's registration
//    contract), so the document is rewritten into the reduced legacy shape
//    `{version: 1, messages}` that `decodeChatDocument` upgrades in place,
//    assigning this machine's correct binding and keeping the messages.
//    `documentId`, `interactions`, `resetEpoch` and `compaction` are dropped
//    with it: an interaction is a live question bound to the machine that
//    asked it, and carrying one to a machine that cannot answer it is worse
//    than losing it. A task with unanswered questions should be settled
//    before it is moved.
//
// A third thing is NOT rewritten, deliberately: the folder's
// `.ensemble-creation-sentinel-v1.json` records content hashes from the
// moment the task was created, and they are already stale on any task that
// has been edited since. It describes a completed creation, nothing reads it
// as authority over a task this old, and inventing fresh hashes would be
// asserting something untrue.
const fs = require("fs");
const path = require("path");

const [taskFolder, workspaceRoot, folderName] = process.argv.slice(2);
if (!taskFolder || !workspaceRoot) {
  console.error("usage: node rebind-task.js <task folder> <workspace root> [new folder name]");
  process.exit(2);
}

const progressPath = path.join(taskFolder, "task-progress.json");
if (!fs.existsSync(progressPath)) {
  console.error(`no task-progress.json in ${taskFolder}`);
  process.exit(1);
}

const progress = JSON.parse(fs.readFileSync(progressPath, "utf8"));

// The folder name is recorded inside the record as `taskFolder`, so a folder
// renamed to dodge a collision on the destination must have that field
// renamed with it - otherwise the record and the directory disagree about
// what the task is.
if (folderName) {
  console.log(`taskFolder: ${progress.taskFolder} -> ${folderName}`);
  progress.taskFolder = folderName;
}

const before = JSON.stringify(progress.ownership);
progress.ownership = {
  ...progress.ownership,
  metaRoot: `${workspaceRoot}/.ensemble`,
  projectRoot: workspaceRoot,
  workspaceRoot,
  boundAt: new Date().toISOString(),
  state: "resolved",
};
fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2) + "\n");
console.log(`ownership before: ${before}`);
console.log(`ownership after:  ${JSON.stringify(progress.ownership)}`);

const chatPath = path.join(taskFolder, "chat-v1.json");
if (fs.existsSync(chatPath)) {
  const chat = JSON.parse(fs.readFileSync(chatPath, "utf8"));
  const messages = Array.isArray(chat.messages) ? chat.messages : [];
  const interactions = Array.isArray(chat.interactions) ? chat.interactions : [];
  fs.copyFileSync(chatPath, `${chatPath}.bak-rebind`);
  fs.writeFileSync(chatPath, JSON.stringify({ version: 1, messages }, null, 2) + "\n");
  console.log(
    `chat: dropped binding ${String(chat.taskBindingId).slice(0, 16)}... ` +
      `(${chat.taskBindingSource}); kept ${messages.length} message(s); ` +
      `original saved as chat-v1.json.bak-rebind`
  );
  if (interactions.length > 0) {
    console.log(
      `chat: WARNING - dropped ${interactions.length} live interaction(s). ` +
        `Those were questions bound to the machine that asked them; whatever ` +
        `was waiting on an answer will need re-asking.`
    );
  }
} else {
  console.log("chat: no chat-v1.json, nothing to rebind");
}

console.log(
  `task: ${progress.displayName} | stage: ${progress.currentStage} | ` +
    `status: ${progress.status} | v${progress.progressVersion}`
);
