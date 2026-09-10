/**
 * Presentation helpers for the in-sandbox CLI sign-in (bring your own
 * subscription): the control plane relays the CLI's raw terminal output, and
 * this module turns it into something a screen can show — the one URL the
 * user has to open, and plain-language verdicts for what came back.
 *
 * Pure and platform-free on purpose (tested under Node): the terminal
 * output is the CLI's, not ours, so the parsing rules are pinned by tests
 * against the real captured shape (Claude Code 2.1.267, 2026-09-10):
 *
 *   Opening browser to sign in…\r\n
 *   If the browser didn't open, visit: ESC]8;;<url>BEL ESC[94m<url> ESC[39m ESC]8;;BEL\r\n
 *   Paste code here if prompted >
 *
 * — the same URL twice (an OSC-8 hyperlink wrapping a coloured copy), with
 * the OSC-8 terminator glued straight onto the URL's last character. Any
 * naive "grab the https:// token" would return the URL with `\x1b]8;;`
 * appended; the control sequences must be stripped FIRST.
 */

// eslint-disable-next-line no-control-regex
const OSC_SEQUENCE_V1 = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// eslint-disable-next-line no-control-regex
const CSI_SEQUENCE_V1 = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const OTHER_CONTROL_V1 = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** Terminal output as plain text: OSC (hyperlinks, titles), CSI (colours, cursor), and stray control bytes removed. */
export function stripTerminalControlV1(text: string): string {
  return text
    .replace(OSC_SEQUENCE_V1, '')
    .replace(CSI_SEQUENCE_V1, '')
    .replace(OTHER_CONTROL_V1, '')
    .replace(/\r\n?/g, '\n');
}

/** The first `https://` URL in the relayed prompt, or undefined when the CLI printed none. */
export function extractCliLoginUrlV1(promptOutput: string): string | undefined {
  const plain = stripTerminalControlV1(promptOutput);
  const match = /https:\/\/[^\s"'<>]+/.exec(plain);
  if (match === null) {
    return undefined;
  }
  // The coloured copy follows the hyperlink copy with no separator once the
  // control sequences are gone ("…stateXYZhttps://…"): cut at the second
  // scheme if the match swallowed both.
  const url = match[0];
  const second = url.indexOf('https://', 1);
  return second > 0 ? url.slice(0, second) : url;
}

/** Whether the CLI's prompt has reached the point where a code can be pasted. */
export function cliLoginPromptAwaitsCodeV1(promptOutput: string): boolean {
  return /paste code/i.test(stripTerminalControlV1(promptOutput));
}

export type CliLoginVerdictV1 =
  | { readonly kind: 'signedIn' }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'stillWorking' };

/** The user-facing meaning of the code-submission body. */
export function cliLoginVerdictV1(result: {
  readonly completed: boolean;
  readonly success?: boolean;
}): CliLoginVerdictV1 {
  if (!result.completed) {
    return { kind: 'stillWorking' };
  }
  return result.success === true ? { kind: 'signedIn' } : { kind: 'rejected' };
}

export function describeCliLoginVerdictV1(verdict: CliLoginVerdictV1): string {
  switch (verdict.kind) {
    case 'signedIn':
      return 'Signed in. Rounds in your sandbox now run on this subscription — no API key involved.';
    case 'rejected':
      return 'The CLI did not accept that code. Start again and paste the code exactly as shown.';
    case 'stillWorking':
      return 'The CLI is still finishing the sign-in. Give it a few seconds, then start a new sign-in if it does not complete.';
  }
}
