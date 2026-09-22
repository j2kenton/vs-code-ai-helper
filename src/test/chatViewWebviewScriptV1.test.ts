/**
 * The chat panel's inline script must PARSE — and must survive the messages
 * the extension actually sends it.
 *
 * It is emitted from a TypeScript template literal, so nothing type-checks it
 * and no test exercised it: a stray line break inside a JS string literal
 * compiled cleanly, shipped, and stopped the whole panel script parsing. With
 * no listener installed, every conversation sat on "Loading chat…" for ever —
 * no error in the extension host log, nothing in the Notifications view, and
 * reloading did not help, because the panel was waiting for a state message
 * it could no longer receive (2026-09-18, in the cloud viewer).
 *
 * Parsing it is the cheapest guard against that whole class; RUNNING it (in a
 * `node:vm` context over a small DOM stub) is what proves the handlers behave
 * — in particular that a failed paint leaves the conversation on screen
 * instead of replacing it with an error (verification review, 2026-09-18).
 */
import * as assert from "node:assert/strict";
import * as vm from "node:vm";
import { describe, it } from "node:test";
import { ChatViewProvider } from "../views/chatView";

/** The provider builds its HTML privately; this is the one place that needs it. */
function panelHtml(): string {
  const provider = new ChatViewProvider({
    get: () => undefined,
    update: () => Promise.resolve(),
    keys: () => [],
  } as never);
  return (provider as unknown as { html(): string }).html();
}

function panelScripts(html: string): readonly string[] {
  return [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1] ?? "");
}

interface FakeElement {
  tagName: string;
  id: string;
  textContent: string;
  value: string;
  className: string;
  title: string;
  type: string;
  disabled: boolean;
  readonly style: Record<string, string>;
  readonly dataset: Record<string, string>;
  readonly children: FakeElement[];
  readonly classList: {
    add(name: string): void;
    remove(name: string): void;
    toggle(name: string, on?: boolean): void;
    has(name: string): boolean;
  };
  readonly listeners: Map<string, ((event: unknown) => void)[]>;
  appendChild(child: FakeElement): FakeElement;
  insertBefore(child: FakeElement): FakeElement;
  replaceChildren(...children: FakeElement[]): void;
  addEventListener(type: string, handler: (event: unknown) => void): void;
  removeEventListener(type: string, handler: (event: unknown) => void): void;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getAttribute(name: string): string | null;
  focus(): void;
  blur(): void;
  remove(): void;
  scrollIntoView(): void;
  querySelector(): FakeElement | null;
  querySelectorAll(): readonly FakeElement[];
  /** Every message/`textContent` painted anywhere under this element. */
  text(): string;
}

function makeElement(tagName: string, id = ""): FakeElement {
  const attributes = new Map<string, string>();
  const classes = new Set<string>();
  const element: FakeElement = {
    tagName,
    id,
    textContent: "",
    value: "",
    className: "",
    title: "",
    type: "",
    disabled: false,
    style: {},
    dataset: {},
    children: [],
    classList: {
      add: (name) => void classes.add(name),
      remove: (name) => void classes.delete(name),
      toggle: (name, on) => {
        if (on === undefined ? classes.has(name) : on === false) {
          classes.delete(name);
        } else {
          classes.add(name);
        }
      },
      has: (name) => classes.has(name),
    },
    listeners: new Map(),
    appendChild(child) {
      element.children.push(child);
      return child;
    },
    insertBefore(child) {
      element.children.unshift(child);
      return child;
    },
    replaceChildren(...children) {
      element.children.length = 0;
      element.children.push(...children);
    },
    addEventListener(type, handler) {
      const existing = element.listeners.get(type) ?? [];
      existing.push(handler);
      element.listeners.set(type, existing);
    },
    removeEventListener: () => undefined,
    setAttribute: (name, value) => void attributes.set(name, value),
    removeAttribute: (name) => void attributes.delete(name),
    getAttribute: (name) => attributes.get(name) ?? null,
    focus: () => undefined,
    blur: () => undefined,
    remove: () => undefined,
    scrollIntoView: () => undefined,
    querySelector: () => null,
    querySelectorAll: () => [],
    text() {
      return [element.textContent, ...element.children.map((child) => child.text())].join(" ").trim();
    },
  };
  return element;
}

interface PanelHarness {
  /** Deliver a message to the panel exactly as the extension posts it. */
  post(message: unknown): void;
  byId(id: string): FakeElement;
  /** What the panel sent back to the extension. */
  readonly outbound: unknown[];
  /** Every string the panel wrote to `navigator.clipboard`. */
  readonly clipboardWrites: string[];
}

/** Run every inline script of the panel over a DOM stub. */
function runPanel(): PanelHarness {
  const elements = new Map<string, FakeElement>();
  for (const id of [
    "context",
    "scheduling-posture",
    "messages",
    "interaction",
    "decisions",
    "empty-notice",
    "error",
    "busy-indicator",
    "busy-spinner",
    "busy-text",
    "steering-note",
    "form",
    "message",
  ]) {
    elements.set(id, makeElement("div", id));
  }
  // The shipped HTML is not blank: #context holds the loading placeholder and
  // #busy-text a default sentence. A stub that starts everything empty hid a
  // first-paint failure that leaves the placeholder on screen (verification
  // review, 2026-09-18).
  elements.get("context")!.textContent = "Loading chat…";
  elements.get("busy-text")!.textContent = "No task is running.";
  const windowListeners = new Map<string, ((event: unknown) => void)[]>();
  const outbound: unknown[] = [];
  const clipboardWrites: string[] = [];
  const documentElement = makeElement("html");
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (callback: () => void) => callback(),
    acquireVsCodeApi: () => ({
      postMessage: (message: unknown) => void outbound.push(message),
      getState: () => undefined,
      setState: () => undefined,
    }),
    navigator: {
      clipboard: {
        writeText: (text: string) => {
          clipboardWrites.push(text);
          return Promise.resolve();
        },
      },
    },
    document: {
      documentElement: { ...documentElement, scrollHeight: 1000, clientHeight: 500 },
      body: makeElement("body"),
      getElementById: (id: string) => elements.get(id) ?? null,
      createElement: (tag: string) => makeElement(tag),
      createTextNode: (text: string) => {
        const node = makeElement("#text");
        node.textContent = text;
        return node;
      },
      addEventListener: () => undefined,
    },
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Math,
    Date,
    Promise,
    Error,
  });
  const fakeWindow = {
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      const existing = windowListeners.get(type) ?? [];
      existing.push(handler);
      windowListeners.set(type, existing);
    },
    removeEventListener: () => undefined,
    scrollTo: () => undefined,
    scrollY: 0,
    innerHeight: 500,
  };
  (context as { window?: unknown }).window = fakeWindow;
  for (const source of panelScripts(panelHtml())) {
    new vm.Script(source).runInContext(context);
  }
  assert.ok(windowListeners.get("message")?.length, "the panel installed no message listener");
  return {
    post(message) {
      for (const handler of windowListeners.get("message") ?? []) {
        handler({ data: message });
      }
    },
    byId(id) {
      const element = elements.get(id);
      assert.ok(element, `no element #${id}`);
      return element;
    },
    outbound,
    clipboardWrites,
  };
}

/** Depth-first search of the fake DOM for elements with a class name. */
function findByClass(root: FakeElement, className: string): FakeElement[] {
  const found: FakeElement[] = [];
  const visit = (element: FakeElement): void => {
    if (element.className.split(/\s+/).includes(className)) found.push(element);
    element.children.forEach(visit);
  };
  visit(root);
  return found;
}

function stateMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "state",
    target: { kind: "task", taskName: "My Task", canonicalId: "/w/t1", taskFolderPath: "/w/t1" },
    label: "My Task — Implementation",
    entries: [{ role: "user", text: "please implement it", atLabel: "10:00" }],
    interactions: [],
    decisions: [],
    busy: true,
    busyText: "running",
    waitingForUser: false,
    ...overrides,
  };
}

void describe("the chat panel's interaction and decision cards", () => {
  const interaction = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    interactionId: "i1",
    operationId: "op1",
    questions: [
      {
        questionId: "q1",
        kind: "singleChoice",
        prompt: "Which way?",
        required: true,
        options: [
          { optionId: "a", label: "Left" },
          { optionId: "b", label: "Right" },
        ],
      },
    ],
    atLabel: "10:15",
    atTitle: "9/20/2026, 10:15:00 AM",
    copyText: "Needs your reply\nWhich way? *\n- Left\n- Right",
    ...overrides,
  });
  const decision = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    decisionId: "d1",
    whatHappened: "A round failed.",
    whyUserNeeded: "Cannot decide alone.",
    options: [{ optionId: "o1", label: "Retry", consequence: "Runs again.", destructive: false }],
    recommendation: { kind: "none", reasoning: "No basis." },
    gatingLine: "Unblocks: nothing",
    isGating: false,
    isBlockingDecision: true,
    atLabel: "10:20",
    atTitle: "9/20/2026, 10:20:00 AM",
    copyText: "Decision needed\nA round failed.",
    createdAt: "2026-09-20T10:20:00.000Z",
    ...overrides,
  });

  void it("gives an interaction card a copy button and a timestamp; copying posts no message", () => {
    const panel = runPanel();
    panel.post(stateMessage({ interactions: [interaction()] }));
    const card = panel.byId("interaction");
    const [copy] = findByClass(card, "msg-copy");
    const [time] = findByClass(card, "msg-time");
    assert.ok(copy, "the interaction card must carry a copy button");
    assert.equal(copy.type, "button");
    assert.equal(time?.textContent, "10:15");
    assert.equal(time?.title, "9/20/2026, 10:15:00 AM");
    const outboundBefore = panel.outbound.length;
    copy.listeners.get("click")![0]!({});
    assert.deepEqual(panel.clipboardWrites, ["Needs your reply\nWhich way? *\n- Left\n- Right"]);
    assert.equal(panel.outbound.length, outboundBefore, "copying must not post a message (no confirm/cancel/select)");
    assert.equal(copy.textContent, "✓");
  });

  void it("gives a decision card a copy button and a timestamp; copying posts no message", () => {
    const panel = runPanel();
    const d = decision();
    panel.post(stateMessage({ decisions: [d], timeline: [{ type: "decision", value: d }] }));
    const [copy] = findByClass(panel.byId("messages"), "msg-copy");
    const [time] = findByClass(panel.byId("messages"), "msg-time");
    assert.ok(copy, "the decision card must carry a copy button");
    assert.equal(time?.textContent, "10:20");
    const outboundBefore = panel.outbound.length;
    copy.listeners.get("click")![0]!({});
    assert.deepEqual(panel.clipboardWrites, ["Decision needed\nA round failed."]);
    assert.equal(panel.outbound.length, outboundBefore);
  });

  void it("renders an empty, untitled time span — never Invalid/NaN — when the record carried no usable time", () => {
    const panel = runPanel();
    const d = decision({ atLabel: "", atTitle: "" });
    panel.post(
      stateMessage({
        interactions: [interaction({ atLabel: "", atTitle: "" })],
        decisions: [d],
        timeline: [{ type: "decision", value: d }],
      })
    );
    for (const root of [panel.byId("interaction"), panel.byId("messages")]) {
      const [time] = findByClass(root, "msg-time");
      assert.ok(time, "the time span is still rendered");
      assert.equal(time.textContent, "");
      assert.equal(time.title, "");
      assert.doesNotMatch(root.text(), /Invalid|NaN/);
    }
  });
});

void describe("the chat panel's inline script", () => {
  void it("parses as JavaScript", () => {
    const scripts = panelScripts(panelHtml());
    assert.ok(scripts.length > 0, "the panel must ship a script");
    for (const [index, source] of scripts.entries()) {
      assert.doesNotThrow(
        () => new vm.Script(source),
        `script #${index} in the chat panel does not parse — the panel would install no message listener at all`
      );
    }
  });

  void it("still installs the listener the panel depends on", () => {
    // A script that parses but no longer wires these up would fail the same
    // way, silently. These three are the panel's whole lifeline.
    const html = panelHtml();
    assert.match(html, /addEventListener\('message'/, "it must listen for state messages");
    assert.match(html, /postMessage\(\{type:'ready'\}\)/, "it must announce itself so the first render is sent");
    assert.match(html, /Loading chat/, "the placeholder it replaces must still be there");
  });

  void it("paints a state message: the transcript, the header and the busy banner", () => {
    const panel = runPanel();
    panel.post(stateMessage());
    assert.match(panel.byId("messages").text(), /please implement it/);
    assert.equal(panel.byId("context").textContent, "My Task — Implementation");
    assert.equal(panel.byId("busy-indicator").style.display, "block");
    assert.equal(panel.byId("error").style.display, "none");
  });

  void it("shows the non-steering note on a task chat and hides it on the global chat", () => {
    const panel = runPanel();
    panel.post(stateMessage());
    assert.equal(panel.byId("steering-note").style.display, "block");
    panel.post(stateMessage({ target: { kind: "global" } }));
    assert.equal(panel.byId("steering-note").style.display, "none");
  });

  void it("a failed paint shows a banner and KEEPS the conversation and the busy banner", () => {
    // The regression this guards: the failure state used to be sent as a
    // full, empty `state` message, so any error while refreshing wiped the
    // transcript, the busy banner and a pending decision card — a round
    // waiting on an answer could then no longer be answered at all.
    const panel = runPanel();
    const state = stateMessage();
    panel.post(state);
    panel.post({
      type: "renderFailed",
      target: state.target,
      label: state.label,
      errorMessage: "This conversation could not be refreshed. (ENOENT)",
      unpaintedMessage: "This conversation could not be shown. (ENOENT)",
    });
    assert.match(panel.byId("error").textContent, /could not be refreshed/);
    assert.equal(panel.byId("error").style.display, "block");
    assert.match(panel.byId("messages").text(), /please implement it/, "the transcript must survive");
    assert.equal(panel.byId("busy-indicator").style.display, "block", "the busy banner must survive");
  });

  void it("a failed paint for ANOTHER task never leaves the previous task's conversation on screen", () => {
    // The blocker (verification review, 2026-09-18): Send and every Reply
    // control post against the panel's CURRENT target. Leaving task A's
    // transcript up while the target had already moved to task B meant the
    // user could answer B's round while reading A's conversation.
    const panel = runPanel();
    panel.post(stateMessage());
    panel.post({
      type: "renderFailed",
      target: { kind: "task", taskName: "Other Task", canonicalId: "/w/t2", taskFolderPath: "/w/t2" },
      label: "Other Task — Plan",
      errorMessage: "could not be refreshed",
      unpaintedMessage: "This conversation could not be shown. (EACCES)",
    });
    assert.doesNotMatch(panel.byId("messages").text(), /please implement it/, "the other task's transcript is gone");
    assert.equal(panel.byId("context").textContent, "Other Task — Plan", "the header names the conversation shown");
    assert.equal(panel.byId("busy-indicator").style.display, "none", "and does not claim the other task's round");
    assert.match(panel.byId("error").textContent, /could not be shown/, "the wording for a conversation never painted");
  });

  void it("a first paint that fails replaces the loading placeholder", () => {
    // Otherwise the panel is back on "Loading chat…" for ever, which is the
    // dead end the whole webview test exists for.
    const panel = runPanel();
    assert.equal(panel.byId("context").textContent, "Loading chat…", "the shipped placeholder");
    panel.post({
      type: "renderFailed",
      target: { kind: "task", taskName: "My Task", canonicalId: "/w/t1", taskFolderPath: "/w/t1" },
      label: "My Task — Implementation",
      errorMessage: "could not be refreshed",
      unpaintedMessage: "This conversation could not be shown. (ENOENT)",
    });
    assert.equal(panel.byId("context").textContent, "My Task — Implementation");
    assert.match(panel.byId("error").textContent, /could not be shown/);
    assert.equal(panel.byId("error").style.display, "block");
  });

  void it("a later successful paint clears the failure banner", () => {
    const panel = runPanel();
    panel.post({ type: "renderFailed", target: undefined, label: "Chat", errorMessage: "transient" });
    panel.post(stateMessage());
    assert.equal(panel.byId("error").style.display, "none");
    assert.equal(panel.byId("error").textContent, "");
  });

  void it("a restored draft is kept apart from what the user typed while waiting", () => {
    const panel = runPanel();
    panel.byId("message").value = "second thought";
    panel.post({ type: "restoreDraft", text: "the message that failed to send" });
    const box = panel.byId("message").value;
    assert.match(box, /second thought/, "nothing the user typed is lost");
    assert.match(box, /the message that failed to send/, "and the handed-back message is there");
    assert.match(box, /\n--- below: a message that could not be sent ---\n/, "with a visible marker on its own line");
  });

  void it("a restored draft goes straight into an empty box, with no marker", () => {
    const panel = runPanel();
    panel.post({ type: "restoreDraft", text: "the message that failed to send" });
    assert.equal(panel.byId("message").value, "the message that failed to send");
    // Whitespace is not something the user wants kept either.
    const blank = runPanel();
    blank.byId("message").value = "   ";
    blank.post({ type: "restoreDraft", text: "handed back" });
    assert.equal(blank.byId("message").value, "handed back");
  });

  void it("a second handed-back message does not stack a second marker", () => {
    const panel = runPanel();
    panel.byId("message").value = "typed";
    panel.post({ type: "restoreDraft", text: "first failed message" });
    panel.post({ type: "restoreDraft", text: "second failed message" });
    const box = panel.byId("message").value;
    assert.equal(box.split("--- below:").length - 1, 1, "one marker, not one per failure");
    assert.match(box, /first failed message/);
    assert.match(box, /second failed message/);
  });

  void it("the panel's failed-paint state comes from render() itself, not only from a hand-posted message", async () => {
    // The webview half of this was covered while the HOST half was not:
    // reverting render()'s fallback to the old empty `state` payload left
    // every other test in this file passing (verification review,
    // 2026-09-18).
    const posted: unknown[] = [];
    const provider = new ChatViewProvider({
      get: () => undefined,
      update: () => Promise.resolve(),
      keys: () => [],
    } as never);
    const internals = provider as unknown as {
      view: unknown;
      target: unknown;
      renderInnerV1: () => Promise<void>;
      render: () => Promise<void>;
    };
    internals.view = { webview: { postMessage: (message: unknown) => void posted.push(message) } };
    internals.target = { kind: "task", taskName: "My Task", canonicalId: "/w/t1", taskFolderPath: "/w/t1" };
    internals.renderInnerV1 = () => Promise.reject(new Error("ENOENT: no such file or directory"));
    await internals.render();
    const message = posted.at(-1) as Record<string, unknown> | undefined;
    assert.equal(message?.type, "renderFailed", "a banner, never a fresh empty state");
    assert.ok(message?.target, "carrying the conversation it is about");
    assert.match(String(message?.errorMessage), /could not be refreshed/);
    assert.match(String(message?.unpaintedMessage), /ENOENT/);
    assert.equal(
      Object.prototype.hasOwnProperty.call(message ?? {}, "entries"),
      false,
      "no empty transcript may travel with it"
    );
  });
});
