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
import * as fs from "node:fs";
import * as path from "node:path";
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
  hidden?: boolean;
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

/** Which elements the panel scrolled into view or focused (reset by the tests that read them). */
const scrollLog: string[] = [];
const focusLog: string[] = [];

function makeElement(tagName: string, id = ""): FakeElement {
  const attributes = new Map<string, string>();
  const classes = new Set<string>();
  const element: FakeElement = {
    tagName: tagName.toUpperCase(),
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
    focus: () => void focusLog.push(element.getAttribute("data-card-id") ?? element.tagName),
    blur: () => undefined,
    remove: () => undefined,
    scrollIntoView: () => void scrollLog.push(element.getAttribute("data-card-id") ?? element.tagName),
    querySelector: () => null,
    querySelectorAll: () => {
      // Only the 'input,textarea' form-control query the draft capture uses.
      const found: FakeElement[] = [];
      const walk = (node: FakeElement): void => {
        for (const child of node.children) {
          if (/^(input|textarea)$/i.test(child.tagName)) found.push(child);
          walk(child);
        }
      };
      walk(element);
      return found;
    },
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
    "messages",
    "interaction",
    "decisions",
    "empty-notice",
    "error",
    "busy-indicator",
    "busy-text",
    "steering-note",
    "form",
    "message",
    "send-btn",
    "send-reason",
    "answering",
    "answering-text",
    "answering-cancel",
    "stage-nav",
  ]) {
    elements.set(id, makeElement("div", id));
  }
  // The shipped HTML is not blank: #context holds the loading placeholder. A
  // stub that starts everything empty hid a first-paint failure that leaves
  // the placeholder on screen (verification review, 2026-09-18).
  elements.get("context")!.textContent = "Loading chat…";
  const windowListeners = new Map<string, ((event: unknown) => void)[]>();
  const outbound: unknown[] = [];
  const clipboardWrites: string[] = [];
  const documentElement = makeElement("html");
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    // The strip refreshes its "N min" every 30 s; a stub keeps a test from holding the process open.
    setInterval: () => 1,
    clearInterval: () => undefined,
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

  // chat1 Steps 9, 11, 12, 14, 15, 16: one card lifecycle.
  const cardOf = (
    cardId: string,
    state: string,
    outcome: string,
    expanded: boolean,
    title = "Decision needed: A round failed."
  ): Record<string, unknown> => ({ cardId, kind: "decision", title, state, outcome, expanded });
  const timelineOf = (...values: Record<string, unknown>[]): Record<string, unknown> =>
    stateMessage({ decisions: [], timeline: values.map((value) => ({ type: "decision", value })) });
  // Messages built inside the vm context carry that context's prototypes; compare them as plain data.
  const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
  const buttons = (root: FakeElement): FakeElement[] => {
    const found: FakeElement[] = [];
    const visit = (element: FakeElement): void => {
      if (element.tagName === "BUTTON") found.push(element);
      element.children.forEach(visit);
    };
    visit(root);
    return found;
  };

  void it("gives an open card a header button that is expanded, names the outcome and toggles with aria-expanded", () => {
    const panel = runPanel();
    const d = decision({ card: cardOf("d1", "open", "needs your answer", true) });
    panel.post(timelineOf(d));
    const [header] = findByClass(panel.byId("messages"), "card-header");
    assert.ok(header, "the card must have a header");
    assert.equal(header.tagName, "BUTTON");
    assert.equal(header.type, "button");
    assert.equal(header.getAttribute("aria-expanded"), "true");
    assert.ok(header.getAttribute("aria-controls"), "the header must point at its body");
    assert.match(header.text(), /Decision needed: A round failed\. — needs your answer/);
    const [body] = findByClass(panel.byId("messages"), "card-body");
    assert.equal(body?.id, header.getAttribute("aria-controls"));
    assert.equal(body?.hidden, false);
    const before = panel.outbound.length;
    header.listeners.get("click")![0]!({});
    assert.equal(header.getAttribute("aria-expanded"), "false");
    assert.equal((body as unknown as { hidden: boolean }).hidden, true);
    assert.deepEqual(plain(panel.outbound.slice(before)), [{ type: "toggleCard", cardId: "d1", state: "open", expanded: false }]);
    header.listeners.get("click")![0]!({});
    assert.equal(header.getAttribute("aria-expanded"), "true");
  });

  void it("keeps a finished decision card read-only and collapsed: every option, the chosen one marked, no live controls", () => {
    const panel = runPanel();
    const d = decision({
      state: "resolved",
      resolvedOptionId: "o2",
      options: [
        { optionId: "o1", label: "Retry", consequence: "Runs again.", destructive: false },
        { optionId: "o2", label: "Skip", consequence: "Moves on.", destructive: false },
      ],
      card: cardOf("d1", "answered", "answered: Skip · 03:41", false),
    });
    panel.post(timelineOf(d));
    const root = panel.byId("messages");
    const [header] = findByClass(root, "card-header");
    assert.equal(header?.getAttribute("aria-expanded"), "false");
    assert.match(header?.text() ?? "", /answered: Skip · 03:41/);
    assert.equal((findByClass(root, "card-body")[0] as unknown as { hidden: boolean }).hidden, true);
    const text = root.text();
    assert.match(text, /Retry/);
    assert.match(text, /Skip ✓ Chosen/);
    assert.doesNotMatch(text, /Retry ✓ Chosen/);
    const labels = buttons(root).map((button) => button.textContent);
    assert.ok(!labels.includes("Confirm") && !labels.includes("Dismiss"), `no live buttons, found ${labels.join(",")}`);
    const inputs = root.querySelectorAll();
    assert.equal(inputs.length, 0, "no radio buttons or text boxes on a finished card");
  });

  void it("shows a trimmed finished card as one collapsed line that says its details are no longer kept", () => {
    const panel = runPanel();
    panel.post(
      timelineOf({
        decisionId: "old",
        createdAt: "2026-09-20T10:00:00.000Z",
        trimmed: true,
        card: { cardId: "old", kind: "decision", title: "Earlier card", state: "retired", outcome: "details no longer kept", expanded: false },
      })
    );
    const root = panel.byId("messages");
    assert.match(findByClass(root, "card-header")[0]?.text() ?? "", /Earlier card — details no longer kept/);
    assert.match(root.text(), /details are no longer kept/);
  });

  void it("a Dismiss that fails enables the card's controls again and shows the reason inside the card", () => {
    const panel = runPanel();
    const d = decision({ card: cardOf("d1", "open", "needs your answer", true) });
    panel.post(timelineOf(d));
    const root = panel.byId("messages");
    const dismiss = buttons(root).find((button) => button.textContent === "Dismiss")!;
    const confirm = buttons(root).find((button) => button.textContent === "Confirm")!;
    dismiss.listeners.get("click")![0]!({});
    assert.equal(dismiss.disabled, true);
    assert.equal(confirm.disabled, true);
    assert.deepEqual(plain(panel.outbound.at(-1)), { type: "resolveWorkflowDecision", decisionId: "d1", optionId: "__dismiss__" });
    panel.post({ type: "cardActionResult", cardId: "d1", action: "dismiss", ok: false, reason: "Dismiss did not go through." });
    assert.equal(dismiss.disabled, false);
    assert.equal(confirm.disabled, false);
    const [error] = findByClass(root, "interaction-error");
    assert.equal(error?.textContent, "Dismiss did not go through.");
    assert.equal(error?.style.display, "block");
  });

  void it("a Dismiss that works leaves the card as the host repaints it", () => {
    const panel = runPanel();
    const d = decision({ card: cardOf("d1", "open", "needs your answer", true) });
    panel.post(timelineOf(d));
    const dismiss = buttons(panel.byId("messages")).find((button) => button.textContent === "Dismiss")!;
    dismiss.listeners.get("click")![0]!({});
    panel.post({ type: "cardActionResult", cardId: "d1", action: "dismiss", ok: true });
    assert.equal(dismiss.disabled, true, "success changes nothing here; the host repaint shows the card as dismissed");
  });

  void it("a cancelled interaction that fails comes back enabled with its reason", () => {
    const panel = runPanel();
    panel.post(stateMessage({ interactions: [interaction({ card: { cardId: "interaction:op1:i1", kind: "interaction", title: "Needs your reply", state: "open", outcome: "needs your answer", expanded: true } })] }));
    const card = panel.byId("interaction");
    const dismiss = buttons(card).find((button) => button.textContent === "Dismiss")!;
    dismiss.listeners.get("click")![0]!({});
    assert.equal(dismiss.disabled, true);
    panel.post({ type: "cardActionResult", cardId: "interaction:op1:i1", action: "dismiss", ok: false, reason: "No longer open." });
    assert.equal(dismiss.disabled, false);
    assert.equal(findByClass(card, "interaction-error")[0]?.textContent, "No longer open.");
  });

  void it("an answered interaction keeps its questions and the answer given, read-only, with 'answered … — resuming'", () => {
    const panel = runPanel();
    panel.post(
      stateMessage({
        interactions: [
          interaction({
            answeredSummary: "Left",
            answers: [{ questionId: "q1", kind: "singleChoice", state: "answered", selectedOptionId: "a" }],
            card: { cardId: "interaction:op1:i1", kind: "interaction", title: "Needs your reply", state: "answered", outcome: "answered: Left — resuming", expanded: false },
          }),
        ],
      })
    );
    const card = panel.byId("interaction");
    assert.match(findByClass(card, "card-header")[0]?.text() ?? "", /answered: Left — resuming/);
    assert.match(card.text(), /Which way\?/);
    assert.match(card.text(), /✓ Chosen: Left/);
    assert.doesNotMatch(card.text(), /Answered: Left|Resuming…/);
    assert.equal(card.querySelectorAll().length, 0);
    assert.deepEqual(buttons(card).map((button) => button.getAttribute("aria-expanded")).filter(Boolean), ["false"]);
  });

  void it("a settled interaction stays as a collapsed read-only card with its outcome (chat1 Step 9)", () => {
    const panel = runPanel();
    panel.post(
      stateMessage({
        interactions: [
          interaction({
            state: "resumed",
            readOnly: true,
            answers: [{ questionId: "q1", kind: "singleChoice", state: "answered", selectedOptionId: "a" }],
            card: { cardId: "interaction:op1:i1", kind: "interaction", title: "Needs your reply", state: "answered", outcome: "answered: Left", expanded: false },
          }),
          interaction({
            interactionId: "i2",
            state: "cancelled",
            readOnly: true,
            card: { cardId: "interaction:op1:i2", kind: "interaction", title: "Needs your reply", state: "dismissed", outcome: "dismissed", expanded: false },
          }),
        ],
      })
    );
    const headers = findByClass(panel.byId("interaction"), "card-header");
    assert.deepEqual(headers.map((header) => header.getAttribute("aria-expanded")), ["false", "false"]);
    assert.match(headers[0]?.text() ?? "", /answered: Left/);
    assert.match(headers[1]?.text() ?? "", /dismissed/);
    const text = panel.byId("interaction").text();
    assert.match(text, /✓ Chosen: Left/);
    assert.match(text, /Not answered/, "a dismissed interaction shows no answer, not 'Skipped'");
    assert.equal(panel.byId("interaction").querySelectorAll().length, 0, "no inputs");
    assert.equal(buttons(panel.byId("interaction")).filter((button) => button.textContent === "Dismiss").length, 0);
  });

  void it("a settled open-items form stays as a collapsed read-only card (chat1 Step 9)", () => {
    const panel = runPanel();
    panel.post(
      stateMessage({
        openPlanItemsForms: [
          {
            formId: "f".repeat(32),
            state: "applied",
            readOnly: true,
            items: [{ itemId: "id-1", itemText: "First open item", occurrence: 1, reason: "needs a human" }],
            card: { cardId: "form:" + "f".repeat(32), kind: "form", title: "Decide the open plan items", state: "answered", outcome: "answered: applied", expanded: false },
          },
        ],
      })
    );
    const card = panel.byId("interaction");
    assert.match(findByClass(card, "card-header")[0]?.text() ?? "", /answered: applied/);
    assert.match(card.text(), /First open item/);
    assert.match(card.text(), /Reason from the round: needs a human/);
    assert.equal(card.querySelectorAll().length, 0, "no radio buttons or text boxes");
    assert.equal(buttons(card).filter((button) => button.textContent === "Apply" || button.textContent === "Dismiss").length, 0);
  });

  void it("wraps a pending question and a settled one in the same header", () => {
    const panel = runPanel();
    panel.post(
      stateMessage({
        entries: [],
        timeline: [
          { type: "message", value: { role: "question", text: "Which file?", at: "2026-09-20T10:00:00.000Z", atLabel: "10:00", awaitingAnswer: true, card: { cardId: "question:a", kind: "question", title: "Question: Which file?", state: "open", outcome: "needs your answer", expanded: true } } },
          { type: "message", value: { role: "question", text: "Old?", at: "2026-09-20T09:00:00.000Z", atLabel: "09:00", settlementLine: "Dismissed by you.", card: { cardId: "question:b", kind: "question", title: "Question: Old?", state: "dismissed", outcome: "dismissed · 09:05", expanded: false } } },
        ],
      })
    );
    const headers = findByClass(panel.byId("messages"), "card-header");
    assert.deepEqual(headers.map((header) => header.getAttribute("aria-expanded")), ["true", "false"]);
    assert.match(headers[1]?.text() ?? "", /dismissed · 09:05/);
  });

  void it("scrolls a card that arrives after the first paint into view, and never takes focus", () => {
    const panel = runPanel();
    const first = decision({ card: cardOf("d1", "open", "needs your answer", true) });
    panel.post(timelineOf(first));
    assert.deepEqual(scrollLog.filter((id) => id === "d1"), [], "the first paint only records the cards that are there");
    scrollLog.length = 0;
    focusLog.length = 0;
    const second = decision({ decisionId: "d2", card: cardOf("d2", "open", "needs your answer", true, "Decision needed: Second.") });
    panel.post(timelineOf(first, second));
    assert.deepEqual(scrollLog, ["d2"], "only the card that just arrived is scrolled into view");
    assert.deepEqual(focusLog, [], "scrolling a new card never moves focus");
    scrollLog.length = 0;
    panel.post(timelineOf(first, second));
    assert.deepEqual(scrollLog, [], "a repaint of the same cards scrolls nothing");
  });

  void it("the Open run log button posts through the panel's own API", () => {
    const panel = runPanel();
    const d = decision({
      card: cardOf("d1", "open", "needs your answer", true),
      evidence: [{ label: "Run log", detail: "see the file", openFilePath: "/w/t1/run.log" }],
    });
    panel.post(timelineOf(d));
    const open = buttons(panel.byId("messages")).find((button) => button.textContent === "Open run log");
    assert.ok(open, "the evidence line must carry an Open run log button");
    open.listeners.get("click")![0]!({});
    assert.deepEqual(plain(panel.outbound.at(-1)), { type: "openDecisionEvidence", filePath: "/w/t1/run.log" });
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

void describe("the open-items form card (RC3 item 5)", () => {
  const collect = (root: FakeElement, tag: string): FakeElement[] => {
    const found: FakeElement[] = [];
    const visit = (element: FakeElement): void => {
      if (element.tagName.toLowerCase() === tag) found.push(element);
      element.children.forEach(visit);
    };
    visit(root);
    return found;
  };
  const form = {
    formId: "f".repeat(32),
    items: [
      { itemId: "id-1", itemText: "First open item", occurrence: 1, reason: "needs a human" },
      { itemId: "id-2", itemText: "Second open item", occurrence: 1, reason: "" },
    ],
  };

  void it("shows every item with its reason, three choices and a note, defaulting to Leave open", () => {
    const panel = runPanel();
    panel.post(stateMessage({ busy: false, openPlanItemsForms: [form] }));
    const card = panel.byId("interaction");
    assert.equal(card.style.display, "block");
    assert.match(card.text(), /First open item/);
    assert.match(card.text(), /Reason from the round: needs a human/);
    assert.match(card.text(), /Exclude/);
    assert.match(card.text(), /I did it — tick it/);
    const radios = collect(card, "input");
    assert.equal(radios.length, 6);
    assert.deepEqual(
      radios.filter((r) => (r as unknown as { checked?: boolean }).checked).map((r) => r.value),
      ["leave", "leave"]
    );
    assert.equal(collect(card, "textarea").length, 2);
    assert.equal((collect(card, "textarea")[0] as FakeElement).value, "needs a human");
  });

  void it("one Apply posts every answer, with the owner's choices and notes", () => {
    const panel = runPanel();
    panel.post(stateMessage({ busy: false, openPlanItemsForms: [form] }));
    const card = panel.byId("interaction");
    const radios = collect(card, "input") as unknown as { value: string; checked: boolean }[];
    radios[0]!.checked = true; // item 1: exclude
    radios[2]!.checked = false; // item 1: leave off
    (collect(card, "textarea")[0] as FakeElement).value = "hand-off";
    const apply = collect(card, "button").find((b) => b.textContent === "Apply");
    assert.ok(apply, "the form has one Apply button");
    assert.equal(collect(card, "button").filter((b) => b.textContent === "Apply").length, 1);
    apply.listeners.get("click")![0]!({});
    assert.deepEqual(JSON.parse(JSON.stringify(panel.outbound.at(-1))), {
      type: "submitOpenPlanItemsForm",
      formId: form.formId,
      answers: [
        { itemId: "id-1", choice: "exclude", note: "hand-off" },
        { itemId: "id-2", choice: "leave", note: "" },
      ],
    });
  });

  void it("Set all to: tick selects every row, and each row can still be adjusted before Apply (bugs4 item 27)", () => {
    const panel = runPanel();
    panel.post(stateMessage({ busy: false, openPlanItemsForms: [form] }));
    const card = panel.byId("interaction");
    const selects = collect(card, "select");
    assert.equal(selects.length, 1, "the form has one Set all control");
    const bulk = selects[0] as unknown as { value: string; listeners: Map<string, ((event: unknown) => void)[]> };
    bulk.value = "tick";
    bulk.listeners.get("change")![0]!({});
    const radios = collect(card, "input") as unknown as { value: string; checked: boolean }[];
    // Every row's "tick" radio is selected; "leave" is no longer the choice anywhere.
    assert.deepEqual(
      radios.filter((r) => r.checked).map((r) => r.value),
      ["tick", "tick"]
    );
    // Adjust the first row back to Exclude, then Apply: the rows really are independent afterwards.
    radios[0]!.checked = true; // exclude, item 1
    radios[1]!.checked = false; // tick, item 1
    const apply = collect(card, "button").find((b) => b.textContent === "Apply")!;
    apply.listeners.get("click")![0]!({});
    const posted = JSON.parse(JSON.stringify(panel.outbound.at(-1))) as { answers: { itemId: string; choice: string }[] };
    assert.deepEqual(
      posted.answers.map((a) => [a.itemId, a.choice]),
      [["id-1", "exclude"], ["id-2", "tick"]]
    );
  });

  void it("a repaint keeps a prefilled note the owner cleared", () => {
    const panel = runPanel();
    panel.post(stateMessage({ busy: false, openPlanItemsForms: [form] }));
    (collect(panel.byId("interaction"), "textarea")[0] as FakeElement).value = "";
    panel.post(stateMessage({ busy: false, openPlanItemsForms: [form] }));
    assert.equal((collect(panel.byId("interaction"), "textarea")[0] as FakeElement).value, "");
  });

  void it("renders no form card when none is open", () => {
    const panel = runPanel();
    panel.post(stateMessage({ busy: false, openPlanItemsForms: [] }));
    assert.equal(panel.byId("interaction").style.display, "none");
  });
});

void describe("Send disabled while the panel's own task is busy (RC3 item 8)", () => {
  void it("disables Send and shows a plain-language reason while busy on a task chat", () => {
    const panel = runPanel();
    panel.post(stateMessage({ busy: true, busyLabel: "Apply Review", waitingForUser: false }));
    assert.equal(panel.byId("send-btn").disabled, true);
    assert.match(panel.byId("send-reason").textContent, /Available when Apply Review finishes/);
  });

  void it("re-enables Send and clears the reason once the task is idle", () => {
    const panel = runPanel();
    panel.post(stateMessage({ busy: true, busyLabel: "Apply Review", waitingForUser: false }));
    panel.post(stateMessage({ busy: false, busyText: undefined, busyLabel: undefined, waitingForUser: false }));
    assert.equal(panel.byId("send-btn").disabled, false);
    assert.equal(panel.byId("send-reason").textContent, "");
    assert.equal(panel.byId("send-reason").style.display, "none");
  });

  void it("keeps Send enabled while the task is waiting for an answer in this chat", () => {
    const panel = runPanel();
    panel.post(stateMessage({ busy: false, waitingForUser: true }));
    assert.equal(panel.byId("send-btn").disabled, false);
  });

  void it("keeps Send enabled for the Global Assistant even while it is busy", () => {
    const panel = runPanel();
    panel.post(
      stateMessage({ target: { kind: "global" }, busy: true, busyLabel: "something", waitingForUser: false })
    );
    assert.equal(panel.byId("send-btn").disabled, false);
  });

  void it("preserves typed text and refuses to send while Send is disabled, even via Enter", () => {
    const panel = runPanel();
    panel.post(stateMessage({ busy: true, busyLabel: "Apply Review", waitingForUser: false }));
    panel.byId("message").value = "hold this thought";
    const outboundBefore = panel.outbound.length;
    for (const handler of panel.byId("message").listeners.get("keydown") ?? []) {
      handler({ key: "Enter", ctrlKey: false, metaKey: false, shiftKey: false, preventDefault: () => undefined });
    }
    assert.equal(panel.outbound.length, outboundBefore, "no message was sent while Send is disabled");
    assert.equal(panel.byId("message").value, "hold this thought", "typed text survives");
    panel.post(stateMessage({ busy: false, busyText: undefined, busyLabel: undefined, waitingForUser: false }));
    assert.equal(panel.byId("send-btn").disabled, false);
    assert.equal(panel.byId("message").value, "hold this thought", "still there once Send re-enables");
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

  void it("paints a state message: the transcript and the header, with no run-status banner", () => {
    const panel = runPanel();
    panel.post(stateMessage());
    assert.match(panel.byId("messages").text(), /please implement it/);
    assert.equal(panel.byId("context").textContent, "My Task — Implementation");
    assert.equal(panel.byId("busy-indicator").style.display, "none", "no run status without waitingForUser");
    assert.equal(panel.byId("error").style.display, "none");
  });

  void it("shows a 'Waiting for your answer' banner only while waitingForUser is true, and hides it otherwise", () => {
    const panel = runPanel();
    panel.post(stateMessage({ waitingForUser: true }));
    assert.equal(panel.byId("busy-indicator").style.display, "block");
    assert.equal(panel.byId("busy-text").textContent, "Waiting for your answer");
    panel.post(stateMessage({ waitingForUser: false }));
    assert.equal(panel.byId("busy-indicator").style.display, "none");
  });

  void describe("run1 Step 20: Chat With AI shows nothing about what is running", () => {
    // Notifications answers "is it running?". A stale `runStrip` field or message from an older host
    // must never paint a running line in the chat.
    const staleStrip = {
      operationId: "op-7",
      label: "Apply Review — High-Level Code Review",
      model: "Claude Sonnet 5.5",
      startedAt: Date.now() - 4 * 60_000,
      sinceClock: "13:58",
      latest: "pnpm run lint · 1/12 complete",
      waiting: false,
      cancellable: true,
    };

    void it("paints no running line for a state message, even one that still carries a run strip", () => {
      const panel = runPanel();
      panel.post(stateMessage({ runStrip: staleStrip, busy: true, busyLabel: "Implementation Review" }));
      assert.equal(panel.byId("busy-indicator").style.display, "none");
      assert.equal(panel.byId("busy-text").textContent, "");
    });

    void it("ignores a runStrip message: the conversation and the banner are untouched", () => {
      const panel = runPanel();
      panel.post(stateMessage());
      const rowsBefore = panel.byId("messages").children.length;
      panel.post({ type: "runStrip", runStrip: staleStrip });
      assert.equal(panel.byId("busy-indicator").style.display, "none");
      assert.equal(panel.byId("messages").children.length, rowsBefore);
    });

    void it("keeps the waiting banner for a question waiting on the owner, with no run details", () => {
      const panel = runPanel();
      panel.post(stateMessage({ waitingForUser: true, waitingForUserSource: "liveOperation" }));
      assert.equal(panel.byId("busy-text").textContent, "Waiting for your answer");
      assert.equal(panel.byId("busy-indicator").style.display, "block");
    });

    void it("keeps the reason Send is disabled while a run is in progress", () => {
      const panel = runPanel();
      panel.post(stateMessage({ busy: true, busyLabel: "Implementation Review" }));
      assert.equal(panel.byId("send-btn").disabled, true);
      assert.match(panel.byId("send-reason").textContent, /Available when Implementation Review finishes/);
    });

    void it("the chat source posts no run strip and the strip module is gone", () => {
      const source = fs.readFileSync(path.join(__dirname, "..", "..", "src", "views", "chatView.ts"), "utf8");
      assert.doesNotMatch(source, /runStrip|chatRunStripV1|showRunInNotifications|stopRunFromStrip/);
      assert.equal(fs.existsSync(path.join(__dirname, "..", "..", "src", "views", "chatRunStripV1.ts")), false);
    });
  });

  void it("review2 Step 43: an own-words card shows 'Answering: <card title>' above the box, focuses it, and Cancel goes back", () => {
    const panel = runPanel();
    panel.post(stateMessage());
    panel.post({ type: "answeringOwnWords", text: "Answering: Step 22 acceptance line" });
    assert.equal(panel.byId("answering").style.display, "block");
    assert.equal(panel.byId("answering-text").textContent, "Answering: Step 22 acceptance line");
    // Cancel tells the host and hides the line.
    for (const handler of panel.byId("answering-cancel").listeners.get("click") ?? []) handler({});
    assert.ok(panel.outbound.some((m) => (m as { type?: unknown }).type === "cancelOwnWordsAnswer"));
    assert.equal(panel.byId("answering").style.display, "none");
    // The host ending the answer hides it too.
    panel.post({ type: "answeringOwnWords", text: "Answering: x" });
    panel.post({ type: "answeringOwnWordsEnded" });
    assert.equal(panel.byId("answering").style.display, "none");
  });

  void it("review2 Step 43: a busy task does not block the answer to an own-words card", () => {
    const panel = runPanel();
    panel.post(stateMessage({ busy: true, busyLabel: "Apply Review", waitingForUser: false }));
    assert.equal(panel.byId("send-btn").disabled, true);
    panel.post({ type: "answeringOwnWords", text: "Answering: Step 22" });
    panel.post(stateMessage({ busy: true, busyLabel: "Apply Review", waitingForUser: false }));
    assert.equal(panel.byId("send-btn").disabled, false, "the answer is not a chat send");
  });

  void it("shows the non-steering note on a task chat and hides it on the global chat", () => {
    const panel = runPanel();
    panel.post(stateMessage());
    assert.equal(panel.byId("steering-note").style.display, "block");
    panel.post(stateMessage({ target: { kind: "global" } }));
    assert.equal(panel.byId("steering-note").style.display, "none");
  });

  void it("a failed paint shows a banner and KEEPS the conversation and the waiting banner", () => {
    // The regression this guards: the failure state used to be sent as a
    // full, empty `state` message, so any error while refreshing wiped the
    // transcript, the waiting banner and a pending decision card — a round
    // waiting on an answer could then no longer be answered at all.
    const panel = runPanel();
    const state = stateMessage({ waitingForUser: true });
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
    assert.equal(panel.byId("busy-indicator").style.display, "block", "the waiting banner must survive");
  });

  void it("a failed paint for ANOTHER task never leaves the previous task's conversation on screen", () => {
    // The blocker (verification review, 2026-09-18): Send and every Reply
    // control post against the panel's CURRENT target. Leaving task A's
    // transcript up while the target had already moved to task B meant the
    // user could answer B's round while reading A's conversation.
    const panel = runPanel();
    panel.post(stateMessage({ waitingForUser: true }));
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

void describe("the chat panel's stage arrows", () => {
  const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
  const nav = {
    previous: { stage: "impl-high-review", label: "Chat with High-Level Code Review", attention: 0, tooltip: "Open the High-Level Code Review chat." },
    next: { stage: "publish", label: "Chat with Publish [2]", attention: 2, tooltip: "Open the Publish chat. 2 items need you on Publish." },
  };

  void it("shows previous on the left and next on the right, the one that needs the owner marked", () => {
    const panel = runPanel();
    panel.post(stateMessage({ stageNav: nav }));
    const bar = panel.byId("stage-nav");
    assert.equal(bar.style.display, "flex");
    assert.equal(bar.children.length, 2);
    const [previous, next] = bar.children;
    assert.equal(previous?.textContent, "\u25C0 Chat with High-Level Code Review");
    assert.equal(previous?.className, "stage-nav-previous");
    assert.equal(next?.textContent, "Chat with Publish [2] \u25B6");
    assert.equal(next?.className, "stage-nav-next stage-nav-attention");
    assert.equal(next?.title, "Open the Publish chat. 2 items need you on Publish.");
  });

  void it("asks the extension to open the chosen stage", () => {
    const panel = runPanel();
    panel.post(stateMessage({ stageNav: nav }));
    const before = panel.outbound.length;
    panel.byId("stage-nav").children[1]!.listeners.get("click")![0]!({});
    assert.deepEqual(plain(panel.outbound.slice(before)), [{ type: "openStage", stage: "publish", canonicalId: "/w/t1" }]);
  });

  void it("clears the buttons when a switch to another task fails to paint", () => {
    const panel = runPanel();
    panel.post(stateMessage({ stageNav: nav }));
    panel.post({ type: "renderFailed", target: { kind: "task", canonicalId: "/w/t2", stage: "impl" }, label: "Other", errorMessage: "x" });
    const bar = panel.byId("stage-nav");
    assert.equal(bar.children.length, 0);
    assert.equal(bar.style.display, "none");
  });

  void it("hides the bar when there is no stage to move to (the global assistant)", () => {
    const panel = runPanel();
    panel.post(stateMessage({ stageNav: nav }));
    panel.post(stateMessage({ target: { kind: "global" }, stageNav: undefined }));
    const bar = panel.byId("stage-nav");
    assert.equal(bar.children.length, 0);
    assert.equal(bar.style.display, "none");
  });
});
