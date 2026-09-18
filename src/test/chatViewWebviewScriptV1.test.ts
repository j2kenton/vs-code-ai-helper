/**
 * The chat panel's inline script must PARSE.
 *
 * It is emitted from a TypeScript template literal, so nothing type-checks it
 * and no test exercised it: a stray line break inside a JS string literal
 * compiled cleanly, shipped, and stopped the whole panel script parsing. With
 * no listener installed, every conversation sat on "Loading chat…" for ever —
 * no error in the extension host log, nothing in the Notifications view, and
 * reloading did not help, because the panel was waiting for a state message
 * it could no longer receive (2026-09-18, in the cloud viewer).
 *
 * Parsing it here is the cheapest possible guard against that whole class.
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

void describe("the chat panel's inline script", () => {
  void it("parses as JavaScript", () => {
    const html = panelHtml();
    const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1] ?? "");
    assert.ok(scripts.length > 0, "the panel must ship a script");
    for (const [index, source] of scripts.entries()) {
      assert.doesNotThrow(
        // Compiling is enough: it never runs here (there is no DOM).
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
});
