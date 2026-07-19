"use strict";
// Minimal stand-in for the 'vscode' module so files that import it can be
// loaded (and their pure, non-VS-Code-dependent exports exercised) under
// plain `node --test`, outside the extension host. Only the surface actually
// referenced by tested modules is implemented; anything else throws so a gap
// is obvious rather than silently wrong. Extend as test:unit grows to cover
// more vscode-importing modules.

const path = require("node:path");
const fs = require("node:fs");

function normalizeFsPath(p) {
  return p.split("/").join(path.sep);
}

class Uri {
  constructor(fsPath) {
    this.fsPath = fsPath;
    this.scheme = "file";
    this.path = fsPath.split(path.sep).join("/");
  }

  toString() {
    return this.scheme === "file" ? `file://${this.path}` : `${this.scheme}:${this.path}`;
  }

  static file(fsPath) {
    return new Uri(normalizeFsPath(fsPath));
  }

  static parse(value) {
    // Support non-file URIs by preserving scheme and authority
    if (!value.startsWith("file://")) {
      const colonIdx = value.indexOf(":");
      if (colonIdx !== -1) {
        const scheme = value.slice(0, colonIdx);
        const rest = value.slice(colonIdx + 1);
        const u = new Uri(rest);
        u.scheme = scheme;
        u.path = rest;
        return u;
      }
    }
    let fsPath = value.replace(/^file:\/\//, "");
    if (process.platform === "win32" && fsPath.startsWith("/") && /^[a-zA-Z]:/.test(fsPath.slice(1))) {
      fsPath = fsPath.slice(1);
    }
    return new Uri(normalizeFsPath(fsPath));
  }

  static joinPath(base, ...segments) {
    return new Uri(path.join(base.fsPath, ...segments));
  }
}

const FileType = {
  Unknown: 0,
  File: 1,
  Directory: 2,
  SymbolicLink: 64,
};

const TreeItemCollapsibleState = {
  None: 0,
  Collapsed: 1,
  Expanded: 2,
};

class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

class MarkdownString {
  constructor(value, supportThemeIcons) {
    this.value = value;
    this.supportThemeIcons = supportThemeIcons;
  }
}

class ThemeIcon {
  constructor(id, color) {
    this.id = id;
    this.color = color;
  }
}

class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}

class EventEmitter {
  constructor() { this._listeners = new Set(); this.event = (listener) => { this._listeners.add(listener); return { dispose: () => this._listeners.delete(listener) }; }; }
  fire(value) { for (const listener of this._listeners) listener(value); }
  dispose() { this._listeners.clear(); }
}

class CancellationToken {
  constructor() {
    this.isCancellationRequested = false;
    this._listeners = [];
  }

  onCancellationRequested(listener) {
    if (typeof listener !== "function") {
      return { dispose() { } };
    }
    this._listeners.push(listener);
    return {
      dispose: () => {
        this._listeners = this._listeners.filter((l) => l !== listener);
      },
    };
  }

  _cancel() {
    if (this.isCancellationRequested) {
      return;
    }
    this.isCancellationRequested = true;
    for (const listener of [...this._listeners]) {
      try {
        listener();
      } catch {
        // Ignore listener errors in test stub.
      }
    }
  }
}

class CancellationTokenSource {
  constructor() {
    this.token = new CancellationToken();
  }

  cancel() {
    this.token._cancel();
  }

  dispose() { }
}

class CancellationError extends Error {
  constructor() {
    super("Canceled");
    this.name = "CancellationError";
  }
}

class LanguageModelError extends Error {
  constructor(message) {
    super(message);
    this.name = "LanguageModelError";
  }
}

const LanguageModelChatMessage = {
  User(content) {
    return { role: "user", content };
  },
  Assistant(content) {
    return { role: "assistant", content };
  },
};

class LanguageModelTextPart {
  constructor(value) {
    this.value = value;
  }
}

class LanguageModelToolCallPart {
  constructor(callId, name, input) {
    this.callId = callId;
    this.name = name;
    this.input = input;
  }
}

class LanguageModelToolResultPart {
  constructor(callId, content) {
    this.callId = callId;
    this.content = content;
  }
}

/**
 * Minimal StatusBarItem stub. Tracks show/hide calls and stores text so tests
 * can assert on the status bar's visible state without a real VS Code window.
 */
class StatusBarItem {
  constructor() {
    this.text = undefined;
    this.tooltip = undefined;
    this.command = undefined;
    this.color = undefined;
    this.visible = false;
  }
  show() {
    this.visible = true;
  }
  hide() {
    this.visible = false;
  }
  dispose() { this.disposed = true; }
}

class QuickPick {
  constructor() { this.items = []; this.selectedItems = []; this.value = ""; this.visible = false; }
  show() { this.visible = true; }
  hide() { this.visible = false; }
  dispose() { this.hide(); }
}

class InputBox extends QuickPick { }

/** Minimal OutputChannel stub: records lines so tests can assert on them. */
class OutputChannel {
  constructor(name) {
    this.name = name;
    this.lines = [];
  }
  appendLine(value) { this.lines.push(value); }
  append(value) { this.lines.push(value); }
  clear() { this.lines = []; }
  show() { /* no-op in tests */ }
  hide() { /* no-op in tests */ }
  dispose() { /* no-op in tests */ }
}

class FileSystemWatcher {
  constructor() { this._onDidChange = new EventEmitter(); this._onDidCreate = new EventEmitter(); this._onDidDelete = new EventEmitter(); }
  get onDidChange() { return this._onDidChange.event; }
  get onDidCreate() { return this._onDidCreate.event; }
  get onDidDelete() { return this._onDidDelete.event; }
  fireChange(uri) { this._onDidChange.fire(uri); }
  fireCreate(uri) { this._onDidCreate.fire(uri); }
  fireDelete(uri) { this._onDidDelete.fire(uri); }
  dispose() { this._onDidChange.dispose(); this._onDidCreate.dispose(); this._onDidDelete.dispose(); }
}

const StatusBarAlignment = {
  Left: 1,
  Right: 2,
};

const ConfigurationTarget = {
  Global: 1,
  Workspace: 2,
  WorkspaceFolder: 3,
};

const ProgressLocation = {
  SourceControl: 1,
  Window: 10,
  Notification: 15,
};

function notImplemented(name) {
  return () => {
    throw new Error(
      `vscode test stub: '${name}' is not implemented. Add it to test-stubs/vscode/index.js if a unit test needs it.`
    );
  };
}

/**
 * Minimal RelativePattern: only stores base/pattern so modules can construct
 * one and tests can inspect what was asked for (findFiles below is
 * test-overridable and defaults to no matches).
 */
class RelativePattern {
  constructor(base, pattern) {
    this.base = typeof base === "string"
      ? base
      : base && base.uri ? base.uri.fsPath : base ? base.fsPath : "";
    this.pattern = pattern;
  }
}

const workspace = {
  fs: {
    readFile: notImplemented("workspace.fs.readFile"),
    writeFile: notImplemented("workspace.fs.writeFile"),
    createDirectory: notImplemented("workspace.fs.createDirectory"),
    readDirectory: notImplemented("workspace.fs.readDirectory"),
    // Real implementation (not notImplemented): several modules use a plain
    // existence/kind check before deciding whether to migrate/create a file,
    // and that's cheap enough to back with real fs rather than require every
    // such test to stub it individually.
    stat: async (uri) => {
      const stats = fs.statSync(uri.fsPath);
      return {
        type: stats.isDirectory() ? FileType.Directory : FileType.File,
        ctime: stats.ctimeMs,
        mtime: stats.mtimeMs,
        size: stats.size,
      };
    },
  },
  asRelativePath: (uri) => (uri && uri.path ? uri.path : String(uri)),
  workspaceFolders: undefined,
  // Real implementation over the test-settable `workspaceFolders` above:
  // returns the deepest workspace folder containing the uri (case-insensitive
  // on Windows, like real VS Code), or undefined when none contains it.
  getWorkspaceFolder: (uri) => {
    const folders = workspace.workspaceFolders;
    if (!folders || !uri || !uri.fsPath) return undefined;
    const normalize = (p) => {
      const unified = String(p).split("\\").join("/").replace(/\/+$/, "");
      return process.platform === "win32" ? unified.toLowerCase() : unified;
    };
    const target = normalize(uri.fsPath);
    let best;
    let bestLength = -1;
    for (const folder of folders) {
      const root = normalize(folder.uri.fsPath);
      if ((target === root || target.startsWith(root + "/")) && root.length > bestLength) {
        best = folder;
        bestLength = root.length;
      }
    }
    return best;
  },
  // Overridable per test (assign a new async function); the default reports
  // no matches rather than throwing so commands that merely enumerate
  // optional candidates (e.g. nested package.json pickers) degrade the same
  // way an empty workspace would.
  findFiles: async () => [],
  textDocuments: [],
  // Untitled documents (openTextDocument({ language, content })) are minted
  // with an untitled: uri and tracked in textDocuments until closed via
  // _closeTextDocument, which also fires onDidCloseTextDocument — enough for
  // editor-lifetime session surfaces (pendingCommitSession) to be exercised
  // under plain node --test. The uri-argument form keeps its minimal shape.
  openTextDocument: async (uriOrOptions) => {
    if (uriOrOptions && typeof uriOrOptions === "object" && !("fsPath" in uriOrOptions)) {
      workspace._untitledCounter += 1;
      const uri = Uri.parse(`untitled:Untitled-${workspace._untitledCounter}`);
      const content = uriOrOptions.content ?? "";
      const doc = { uri, languageId: uriOrOptions.language, getText: () => content, isDirty: false };
      workspace.textDocuments.push(doc);
      return doc;
    }
    return { uri: uriOrOptions, getText: () => "", isDirty: false };
  },
  _untitledCounter: 0,
  _documentCloses: new EventEmitter(),
  onDidCloseTextDocument: (listener) => workspace._documentCloses.event(listener),
  _closeTextDocument: (doc) => {
    const index = workspace.textDocuments.indexOf(doc);
    if (index !== -1) workspace.textDocuments.splice(index, 1);
    workspace._documentCloses.fire(doc);
  },
  createFileSystemWatcher: () => new FileSystemWatcher(),
  getConfiguration: () => ({
    get: (key, defaultValue) => {
      if (key === "enabledProviders") {
        return new Proxy({}, { get: () => true });
      }
      return defaultValue;
    },
    inspect: () => undefined,
  }),
  onDidChangeConfiguration: (listener) => workspace._configurationChanges.event(listener),
  _configurationChanges: new EventEmitter(),
  onDidChangeWorkspaceFolders: (listener) => workspace._workspaceFolderChanges.event(listener),
  _workspaceFolderChanges: new EventEmitter(),
};

class TreeView {
  constructor(id, options) {
    Object.assign(this, { id, ...options });
    this._onDidExpandElement = new EventEmitter();
    this._onDidCollapseElement = new EventEmitter();
    this.revealed = [];
  }
  get onDidExpandElement() { return this._onDidExpandElement.event; }
  get onDidCollapseElement() { return this._onDidCollapseElement.event; }
  reveal(element, options) { this.revealed.push({ element, options }); return Promise.resolve(); }
  fireExpand(element) { this._onDidExpandElement.fire({ element }); }
  fireCollapse(element) { this._onDidCollapseElement.fire({ element }); }
  dispose() { this._onDidExpandElement.dispose(); this._onDidCollapseElement.dispose(); }
}

// Minimal window stub. Interactive methods use queues so command tests can
// exercise the real command path without replacing global window methods.
const quickPickResults = [];
const inputBoxResults = [];
const window = {
  showInformationMessage: notImplemented("window.showInformationMessage"),
  showErrorMessage: notImplemented("window.showErrorMessage"),
  showWarningMessage: notImplemented("window.showWarningMessage"),
  showQuickPick: async (_items) => {
    if (!quickPickResults.length) notImplemented("window.showQuickPick")();
    return quickPickResults.shift();
  },
  showInputBox: async () => {
    if (!inputBoxResults.length) notImplemented("window.showInputBox")();
    return inputBoxResults.shift();
  },
  withProgress: async (options, task) => {
    const progress = { report: () => {} };
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
    if (window._withProgressCalls) {
      window._withProgressCalls.push({ options, task });
    }
    return await task(progress, token);
  },
  // createStatusBarItem is needed by TaskStatusBar constructor.
  // Returns a minimal StatusBarItem stub so TaskStatusBar can be exercised
  // in unit tests without the real VS Code extension host.
  createStatusBarItem: (_alignment, _priority) => new StatusBarItem(),
  createQuickPick: () => new QuickPick(),
  createInputBox: () => new InputBox(),
  showTextDocument: async (document) => ({ document, viewColumn: undefined }),
  createTreeView: (id, options) => new TreeView(id, options),
  createOutputChannel: (name) => new OutputChannel(name),
  registerFileDecorationProvider: (provider) => ({ provider, dispose() { } }),
  // Real VS Code always has a WindowState; default to focused so tests that
  // don't care about desktop-notification focus-gating aren't surprised by
  // a suppressed call. Tests exercising that gating flip this directly.
  state: { focused: true },
};

window._queueQuickPickResult = (result) => { quickPickResults.push(result); };
window._queueInputBoxResult = (result) => { inputBoxResults.push(result); };
window._withProgressCalls = [];
window._clearInteractionQueues = () => { quickPickResults.length = 0; inputBoxResults.length = 0; window._withProgressCalls = []; };

// Minimal commands stub: executeCommand is overridable by individual tests
// via installExecuteCommandStub(). Default throws so forgotten stubs are
// caught immediately.
const commands = {
  executeCommand: async (id, ...args) => {
    if (commands._executeCommandOverride) return commands._executeCommandOverride(id, ...args);
    const handler = commands._handlers.get(id);
    if (!handler) throw new Error(`vscode test stub: command '${id}' is not registered.`);
    return handler(...args);
  },
  _handlers: new Map(),
  _executeCommandOverride: undefined,
  registerCommand: (id, handler) => { commands._handlers.set(id, handler); return { dispose: () => commands._handlers.delete(id) }; },
};

// Minimal lm stub: selectChatModels is overridable by individual tests via
// installRunnerStubs() in commandArgNormalization.test.ts. The default
// returns [] (no models) so CopilotLanguageModelRunner.isAvailable() returns
// { available: false } without throwing. Tests that need actual Copilot
// behaviour should override this.
const lm = {
  selectChatModels: async () => [],
};

// remoteName is undefined for a local window; Remote-SSH/WSL/Codespaces set
// it to e.g. "ssh-remote". Tests that care override it directly.
const env = {
  remoteName: undefined,
  sessionId: "test-session",
};

// Minimal languages stub: no tested module needs real editor diagnostics
// today, only an empty result so completionLint.ts's unconditional
// vscode.languages.getDiagnostics() call doesn't throw under plain node --test.
const languages = {
  getDiagnostics: () => [],
};

module.exports = {
  Uri,
  FileType,
  RelativePattern,
  StatusBarAlignment,
  ConfigurationTarget,
  ProgressLocation,
  StatusBarItem,
  QuickPick,
  InputBox,
  OutputChannel,
  FileSystemWatcher,
  TreeItemCollapsibleState,
  TreeItem,
  MarkdownString,
  ThemeIcon,
  ThemeColor,
  CancellationTokenSource,
  CancellationError,
  LanguageModelError,
  LanguageModelChatMessage,
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
  EventEmitter,
  workspace,
  window,
  commands,
  lm,
  env,
  languages,
  TreeView,
};
