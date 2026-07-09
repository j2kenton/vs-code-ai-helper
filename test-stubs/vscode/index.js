"use strict";
// Minimal stand-in for the 'vscode' module so files that import it can be
// loaded (and their pure, non-VS-Code-dependent exports exercised) under
// plain `node --test`, outside the extension host. Only the surface actually
// referenced by tested modules is implemented; anything else throws so a gap
// is obvious rather than silently wrong. Extend as test:unit grows to cover
// more vscode-importing modules.

const path = require("node:path");

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
    return `file://${this.path}`;
  }

  static file(fsPath) {
    return new Uri(normalizeFsPath(fsPath));
  }

  static parse(value) {
    return new Uri(normalizeFsPath(value.replace(/^file:\/\//, "")));
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
  constructor() {
    this.event = () => ({ dispose() {} });
  }
  fire() {}
  dispose() {}
}

function notImplemented(name) {
  return () => {
    throw new Error(
      `vscode test stub: '${name}' is not implemented. Add it to test-stubs/vscode/index.js if a unit test needs it.`
    );
  };
}

const workspace = {
  fs: {
    readFile: notImplemented("workspace.fs.readFile"),
    writeFile: notImplemented("workspace.fs.writeFile"),
    readDirectory: notImplemented("workspace.fs.readDirectory"),
  },
  asRelativePath: (uri) => (uri && uri.path ? uri.path : String(uri)),
  workspaceFolders: undefined,
};

// Minimal window stub: show* methods are overridable by individual tests via
// installMessageCapture(). The defaults throw so any test that forgets to
// install capture will fail loudly rather than silently swallowing messages.
const window = {
  showInformationMessage: notImplemented("window.showInformationMessage"),
  showErrorMessage: notImplemented("window.showErrorMessage"),
  showWarningMessage: notImplemented("window.showWarningMessage"),
  showQuickPick: notImplemented("window.showQuickPick"),
  withProgress: notImplemented("window.withProgress"),
};

// Minimal commands stub: executeCommand is overridable by individual tests
// via installExecuteCommandStub(). Default throws so forgotten stubs are
// caught immediately.
const commands = {
  executeCommand: notImplemented("commands.executeCommand"),
};

// Minimal lm stub: selectChatModels is overridable by individual tests via
// installRunnerStubs() in commandArgNormalization.test.ts. The default
// returns [] (no models) so CopilotLanguageModelRunner.isAvailable() returns
// { available: false } without throwing. Tests that need actual Copilot
// behaviour should override this.
const lm = {
  selectChatModels: async () => [],
};

module.exports = {
  Uri,
  FileType,
  TreeItemCollapsibleState,
  TreeItem,
  MarkdownString,
  ThemeIcon,
  ThemeColor,
  EventEmitter,
  workspace,
  window,
  commands,
  lm,
};
