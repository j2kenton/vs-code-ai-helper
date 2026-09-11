/**
 * The relayed CLI sign-in prompt, parsed the way the Settings screen needs
 * it. The fixture is the REAL captured output of `claude auth login` inside
 * a sandbox (Claude Code 2.1.267, 2026-09-10) — OSC-8 hyperlink, colour
 * codes, CRLFs and all — because that is what the control plane relays
 * verbatim, and a synthetic "https://… on its own line" fixture would pass
 * a parser that returns the URL with `\x1b]8;;` glued to its end.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cliLoginPromptAwaitsCodeV1,
  cliLoginVerdictV1,
  describeCliLoginVerdictV1,
  extractCliLoginUrlV1,
  isClaudeSignInUrlV1,
  stripTerminalControlV1,
} from '../src/sandbox/cliLoginPromptV1';

const URL =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=YSq5QGZrF0N0KgFUss7-DewSM5uW7xl5gon6T-9baAE&code_challenge_method=S256&state=f53MBYvOlJQx6PG0xkI2JflXIFPkNjQt2Nv1TmL8bZE';

const CAPTURED_PROMPT =
  'Opening browser to sign in…\r\n' +
  `If the browser didn't open, visit: ]8;;${URL}[94m${URL}[39m]8;;\r\n` +
  'Paste code here if prompted > ';

test('the real captured prompt yields exactly one clean URL, state parameter intact', () => {
  assert.equal(extractCliLoginUrlV1(CAPTURED_PROMPT), URL);
});

test('control sequences are stripped without damaging the text between them', () => {
  const plain = stripTerminalControlV1(CAPTURED_PROMPT);
  assert.equal(plain.includes(''), false);
  assert.equal(plain.includes(''), false);
  assert.ok(plain.startsWith('Opening browser to sign in…\nIf the browser didn\'t open, visit: https://'));
  assert.ok(plain.endsWith('Paste code here if prompted > '));
});

test('a prompt with no URL yields undefined rather than a garbage token', () => {
  assert.equal(extractCliLoginUrlV1('Not logged in · Please run /login\r\n'), undefined);
  assert.equal(extractCliLoginUrlV1(''), undefined);
});

test('a plain single URL (no hyperlink wrapper) is returned as-is', () => {
  assert.equal(extractCliLoginUrlV1(`visit: ${URL}\nPaste code here > `), URL);
});

test('only a genuine Claude sign-in host is ever returned — look-alikes and credential tricks are refused', () => {
  const lookalikes = [
    'https://claude.com.evil.example/cai/oauth/authorize?code=true',
    'https://claude.com@evil.example/cai/oauth/authorize',
    'https://evil.example/?next=https://claude.com',
    'https://claude.com:8443/cai/oauth/authorize',
    'https://xclaude.com/cai/oauth/authorize',
  ];
  for (const url of lookalikes) {
    assert.equal(extractCliLoginUrlV1(`If the browser didn't open, visit: ${url}\nPaste code here > `), undefined, url);
    assert.equal(isClaudeSignInUrlV1(url), false, url);
  }
  // Plain http is not a sign-in link either.
  assert.equal(isClaudeSignInUrlV1('http://claude.com/cai/oauth/authorize'), false);
  assert.equal(isClaudeSignInUrlV1(URL), true);
});

test('awaiting-code detection reads the prompt line, not the control bytes around it', () => {
  assert.equal(cliLoginPromptAwaitsCodeV1(CAPTURED_PROMPT), true);
  assert.equal(cliLoginPromptAwaitsCodeV1('Opening browser to sign in…\r\n'), false);
});

test('the code-submission verdict maps every server body to one user-facing outcome', () => {
  assert.deepEqual(cliLoginVerdictV1({ completed: true, success: true }), { kind: 'signedIn' });
  assert.deepEqual(cliLoginVerdictV1({ completed: true, success: false }), { kind: 'rejected' });
  assert.deepEqual(cliLoginVerdictV1({ completed: false }), { kind: 'stillWorking' });
  for (const kind of ['signedIn', 'rejected', 'stillWorking'] as const) {
    assert.ok(describeCliLoginVerdictV1({ kind }).length > 20);
  }
  assert.match(describeCliLoginVerdictV1({ kind: 'signedIn' }), /no API key/);
});
