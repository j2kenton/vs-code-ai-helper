import React from 'react';
import { Linking } from 'react-native';

import {
  DOCKER_SANDBOX_PLACEHOLDER_KEY_V1,
  SANDBOX_PROVIDER_LABELS_V1,
  type SandboxProviderV1,
} from '../api/controlPlaneClientV1';
import {
  Body,
  Card,
  Heading,
  Row,
  Screen,
  SegmentedControl,
  Stack,
  TextField,
  Title,
  TouchButton,
} from '../components/primitives';
import {
  cliLoginVerdictV1,
  describeCliLoginVerdictV1,
  extractCliLoginUrlV1,
} from '../sandbox/cliLoginPromptV1';
import { getAppServicesV1 } from '../services/appServicesV1';
import { useAppStore, type ThemePreference } from '../state/appStore';

const THEME_OPTIONS: ThemePreference[] = ['system', 'light', 'dark'];
/** Docker first: the self-hosted, no-account default; the BYOS clouds after. */
const SANDBOX_PROVIDERS: SandboxProviderV1[] = ['docker', 'e2b', 'daytona'];
const SIGN_IN_PROVIDERS = ['github', 'google'] as const;

/**
 * The model id that routes rounds through the Claude Code CLI inside the
 * sandbox (the engine's `claude-cli` provider) — the bring-your-own-
 * subscription path. No API key is ever stored for it.
 */
const CLAUDE_CLI_MODEL_PROVIDER_V1 = 'claude-cli';
const CLAUDE_CLI_DEFAULT_MODEL_V1 = 'claude-cli:sonnet';

/**
 * The in-sandbox CLI sign-in, step by step. Each state is exactly what the
 * card renders; there is no hidden "loading" flag to fall out of sync.
 */
type CliLoginUiStateV1 =
  | { readonly kind: 'idle' }
  | { readonly kind: 'starting' }
  | {
      readonly kind: 'awaitingCode';
      readonly loginSessionId: string;
      readonly url: string | undefined;
      readonly submitting: boolean;
      readonly notice: string | null;
    }
  | { readonly kind: 'signedIn'; readonly message: string }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * Settings tab (plan Part 6): sign-in, control-plane connection, sandbox
 * provider selection (Docker/E2B/Daytona), API key submission with masked
 * metadata, the in-sandbox Claude Code sign-in, model configuration, and
 * the gate policy default. Ported from the extension's settings-view
 * semantics (`ensemble.*` keys only). Key material is submitted over TLS to
 * the control plane and NEVER persisted on-device; the list below shows the
 * server's masked hints only.
 */
export function SettingsScreen(): React.JSX.Element {
  const themePreference = useAppStore((s) => s.themePreference);
  const setThemePreference = useAppStore((s) => s.setThemePreference);
  const session = useAppStore((s) => s.session);
  const setSession = useAppStore((s) => s.setSession);
  const controlPlaneUrl = useAppStore((s) => s.controlPlaneUrl);
  const setControlPlaneUrl = useAppStore((s) => s.setControlPlaneUrl);
  const sandboxProvider = useAppStore((s) => s.sandboxProvider);
  const setSandboxProvider = useAppStore((s) => s.setSandboxProvider);
  const keyRecords = useAppStore((s) => s.keyRecords);
  const setKeyRecords = useAppStore((s) => s.setKeyRecords);
  const modelPrimary = useAppStore((s) => s.modelPrimary);
  const setModelPrimary = useAppStore((s) => s.setModelPrimary);
  const gateApprovalRequired = useAppStore((s) => s.gateApprovalRequired);
  const setGateApprovalRequired = useAppStore((s) => s.setGateApprovalRequired);

  const [notice, setNotice] = React.useState<string | null>(null);
  // Tagged with the key kind it concerns, so the message appears under the
  // card whose button was pressed. A shared, untagged notice rendered in one
  // fixed place is what produced the original complaint: feedback for an
  // action you took HERE showing up somewhere you had to go looking for.
  const [keyNotice, setKeyNotice] = React.useState<{
    readonly kind: string;
    readonly message: string;
  } | null>(null);
  const [sandboxKeyDraft, setSandboxKeyDraft] = React.useState('');
  const [modelKeyDraft, setModelKeyDraft] = React.useState('');
  const [cliLogin, setCliLogin] = React.useState<CliLoginUiStateV1>({ kind: 'idle' });
  const [cliCodeDraft, setCliCodeDraft] = React.useState('');

  const services = getAppServicesV1(controlPlaneUrl);
  const signedIn = session.status === 'signedIn';
  const sandboxProviderLabel = SANDBOX_PROVIDER_LABELS_V1[sandboxProvider];
  const sandboxEnabled = keyRecords.some((record) => record.keyKind === `sandbox:${sandboxProvider}`);

  /**
   * WHICH sandbox the sign-in and reset controls currently act on. Both
   * flows span an await or a second press, and the provider picker (or the
   * control-plane URL) can change in between — the review reproduced a
   * Docker reset confirmation deleting the Daytona sandbox, and a Docker
   * sign-in finishing under the Daytona card. Every such action records its
   * target when it starts and is dropped if the target has moved.
   */
  const sandboxTarget = JSON.stringify([controlPlaneUrl, sandboxProvider]);
  const sandboxTargetRef = React.useRef(sandboxTarget);
  sandboxTargetRef.current = sandboxTarget;
  const [resetArmedFor, setResetArmedFor] = React.useState<string | null>(null);
  const [resetNotice, setResetNotice] = React.useState<string | null>(null);
  React.useEffect(() => {
    setCliLogin({ kind: 'idle' });
    setCliCodeDraft('');
    setResetArmedFor(null);
    setResetNotice(null);
  }, [sandboxTarget]);

  React.useEffect(() => services.session.onChange(setSession), [services, setSession]);

  const refreshKeyRecords = React.useCallback(async () => {
    const result = await services.client.listKeys();
    if (result.ok) {
      setKeyRecords(result.body);
    }
  }, [services, setKeyRecords]);

  // Stored keys follow the SESSION, not one particular way of starting one.
  // Previously the list was fetched only after handleSignIn returned
  // 'signedIn' or after a save, so a session restored at start-up — now the
  // normal case on web, where a cookie re-establishes it without anyone
  // pressing a button — never triggered a fetch at all. The keys were on the
  // server the whole time and the screen simply never asked, which read as
  // "saving doesn't work".
  React.useEffect(() => {
    if (!signedIn) {
      setKeyRecords([]);
      return;
    }
    void refreshKeyRecords();
  }, [signedIn, refreshKeyRecords, setKeyRecords]);

  async function handleSignIn(provider: (typeof SIGN_IN_PROVIDERS)[number]): Promise<void> {
    const outcome = await services.signIn(provider);
    if (outcome.kind === 'signedIn') {
      // No explicit refresh here: the effect above already fetches whenever
      // `signedIn` becomes true, which covers this path and the restored-session
      // path both. Doing it here as well just fetched the list twice.
      setNotice(null);
    } else if (outcome.kind === 'unavailable') {
      setNotice(outcome.reason);
    } else if (outcome.kind === 'failed') {
      setNotice(`Sign-in failed: ${outcome.message}`);
    }
  }

  async function handleSignOut(): Promise<void> {
    await services.signOut();
    setKeyRecords([]);
    setNotice(null);
  }

  async function submitKey(keyKind: string, draft: string, clear: () => void): Promise<void> {
    if (draft.length === 0) {
      return;
    }
    const result = await services.client.putKey(keyKind, draft);
    if (!result.ok) {
      setKeyNotice({ kind: keyKind, message: `Could not save: ${result.message}` });
      return;
    }
    // Clearing the field was previously the ONLY evidence a save happened, and
    // an emptied box reads at least as much like "your input was discarded" as
    // like "stored". Say what happened, and say it next to the list it changed.
    clear();
    const listed = await services.client.listKeys();
    if (listed.ok) {
      setKeyRecords(listed.body);
      setKeyNotice({ kind: keyKind, message: 'Saved. Stored server-side, encrypted.' });
    } else {
      // The write succeeded; only the read-back failed. Distinguishing the two
      // matters — the key IS stored, and re-submitting it would be pointless.
      setKeyNotice({
        kind: keyKind,
        message: `Saved, but the stored-key list could not be re-read (${listed.message}).`,
      });
    }
  }

  /**
   * The state of one key kind, rendered inside the card that submits it.
   * Every other card on this screen reports its own state — Account says who
   * is signed in, Control plane shows its URL — and the cards that take a
   * secret said nothing at all, leaving an emptied input as the only evidence.
   */
  async function removeKey(keyKind: string): Promise<void> {
    const result = await services.client.deleteKey(keyKind);
    setKeyNotice({
      kind: keyKind,
      message: result.ok ? 'Removed.' : `Could not remove: ${result.message}`,
    });
    await refreshKeyRecords();
  }

  /**
   * The bring-your-own-subscription sign-in: the control plane runs the
   * Claude Code CLI's own login inside THIS user's persistent sandbox and
   * relays the URL; the user finishes it in their browser and pastes the
   * code back. Nothing here sees a credential — the CLI keeps what it
   * receives inside the sandbox, and the server's code-submission reply is
   * a verdict only (see `SandboxLoginCodeResultDtoV1`).
   */
  async function startCliLogin(): Promise<void> {
    const target = sandboxTarget;
    setCliLogin({ kind: 'starting' });
    setCliCodeDraft('');
    const started = await services.client.startSandboxLogin(sandboxProvider);
    if (sandboxTargetRef.current !== target) {
      // The picker moved while the server was starting it: this sign-in
      // belongs to a sandbox the card no longer shows. The effect above has
      // already reset the card; the orphaned server session times out.
      return;
    }
    if (!started.ok) {
      setCliLogin({
        kind: 'failed',
        message:
          started.code === 'sandboxProviderKeyMissing'
            ? `Enable ${sandboxProviderLabel} sandboxes above first.`
            : started.code === 'userSandboxLoginUnsupported'
              ? `${sandboxProviderLabel} sandboxes cannot run an interactive sign-in yet — use Docker.`
              : `Could not start the sign-in: ${started.message}`,
      });
      return;
    }
    const url = extractCliLoginUrlV1(started.body.promptOutput);
    setCliLogin({
      kind: 'awaitingCode',
      loginSessionId: started.body.loginSessionId,
      url,
      submitting: false,
      notice:
        url === undefined
          ? 'The CLI did not print a sign-in link. It may already be signed in, or not be installed in this sandbox.'
          : null,
    });
  }

  async function submitCliLoginCode(): Promise<void> {
    if (cliLogin.kind !== 'awaitingCode' || cliCodeDraft.trim().length === 0) {
      return;
    }
    const pending = cliLogin;
    const target = sandboxTarget;
    setCliLogin({ ...pending, submitting: true, notice: null });
    const result = await services.client.submitSandboxLoginCode(pending.loginSessionId, cliCodeDraft.trim());
    if (sandboxTargetRef.current !== target) {
      // The verdict is for a sandbox this card no longer shows: never let
      // it switch the model default for the one it does.
      return;
    }
    if (!result.ok) {
      setCliLogin({
        kind: 'failed',
        message:
          result.code === 'loginSessionNotFound'
            ? 'That sign-in timed out (codes are only valid for a few minutes). Start again.'
            : `Could not submit the code: ${result.message}`,
      });
      return;
    }
    const verdict = cliLoginVerdictV1(result.body);
    const message = describeCliLoginVerdictV1(verdict);
    if (verdict.kind === 'signedIn') {
      setCliCodeDraft('');
      setCliLogin({ kind: 'signedIn', message });
      if (!modelPrimary.startsWith(`${CLAUDE_CLI_MODEL_PROVIDER_V1}:`)) {
        // The whole point of signing the sandbox in is to run on it; a
        // default that still points at an API-keyed model would quietly
        // keep billing the key instead. Prefill, don't force — the Models
        // card below stays editable.
        setModelPrimary(CLAUDE_CLI_DEFAULT_MODEL_V1);
      }
    } else if (verdict.kind === 'rejected') {
      setCliLogin({ kind: 'failed', message });
    } else {
      setCliLogin({ ...pending, submitting: false, notice: message });
    }
  }

  /**
   * Two presses on purpose: the persistent sandbox holds the user's files
   * and the CLI login, and there is no undo. The first press arms the reset
   * FOR the sandbox currently shown; the second only fires if that is still
   * the sandbox shown (a provider switch in between disarms it).
   */
  const resetArmed = resetArmedFor === sandboxTarget;
  async function resetSandbox(): Promise<void> {
    if (!resetArmed) {
      setResetArmedFor(sandboxTarget);
      setResetNotice(null);
      return;
    }
    setResetArmedFor(null);
    const target = sandboxTarget;
    const result = await services.client.resetUserSandbox(sandboxProvider);
    if (sandboxTargetRef.current !== target) {
      // The picker moved while the reset was in flight: its result belongs
      // to a sandbox this card no longer shows, and must not clear a
      // sign-in the user has since started for the new one.
      return;
    }
    if (result.ok) {
      setResetNotice('Sandbox destroyed. The next task or sign-in creates a fresh one.');
      setCliLogin({ kind: 'idle' });
    } else if (result.code === 'userSandboxNotFound') {
      setResetNotice('No persistent sandbox exists yet — nothing to reset.');
    } else {
      setResetNotice(`Could not reset: ${result.message}`);
    }
  }

  function openCliLoginUrl(url: string): void {
    void Linking.openURL(url).catch(() => {
      setCliLogin((current) =>
        current.kind === 'awaitingCode'
          ? { ...current, notice: 'Could not open a browser here — copy the link and open it yourself.' }
          : current
      );
    });
  }

  /**
   * Every key this card owns, with its masked hint and a way to remove it.
   *
   * Listed by PREFIX rather than by the currently-selected kind, because a
   * stored key outlives the selection that created it: store an E2B key, switch
   * the picker to Daytona, and a selected-kind-only view would hide it with no
   * way to remove it. The same applies to a model key after the model string
   * changes. This card is the only place those keys appear now that the
   * separate summary list is gone, so it has to show all of them.
   */
  function keyStatusFor(prefix: string): React.JSX.Element {
    const stored = keyRecords.filter((record) => record.keyKind.startsWith(`${prefix}:`));
    return (
      <Stack gap={1}>
        {stored.length === 0 ? (
          <Body muted>No key stored yet.</Body>
        ) : (
          stored.map((record) => (
            <Row key={record.keyKind} style={{ justifyContent: 'space-between' }}>
              <Body>{`${record.keyKind.slice(prefix.length + 1)} — ${record.maskedHint}`}</Body>
              <TouchButton
                label="Remove"
                variant="secondary"
                onPress={() => void removeKey(record.keyKind)}
              />
            </Row>
          ))
        )}
        {keyNotice?.kind.startsWith(`${prefix}:`) ? <Body>{keyNotice.message}</Body> : null}
        <Body muted>
          Keys are held server-side, encrypted at rest, and are never readable back — only these
          masked hints.
        </Body>
      </Stack>
    );
  }

  const modelProviderId = modelPrimary.includes(':')
    ? modelPrimary.slice(0, modelPrimary.indexOf(':'))
    : modelPrimary;

  return (
    <Screen>
      <Title>Settings</Title>

      <Card>
        <Stack>
          <Heading>Account</Heading>
          {signedIn ? (
            <Stack gap={2}>
              <Body>Signed in to the control plane.</Body>
              <Row>
                <TouchButton label="Sign out" variant="secondary" onPress={() => void handleSignOut()} />
              </Row>
            </Stack>
          ) : (
            <Stack gap={2}>
              <Body muted>
                Sign in with your identity provider. The code exchange happens server-side; this
                device only ever holds a control-plane session token.
              </Body>
              <Row>
                {SIGN_IN_PROVIDERS.map((provider) => (
                  <TouchButton
                    key={provider}
                    label={provider === 'github' ? 'GitHub' : 'Google'}
                    onPress={() => void handleSignIn(provider)}
                  />
                ))}
              </Row>
            </Stack>
          )}
          {notice !== null ? <Body muted>{notice}</Body> : null}
        </Stack>
      </Card>

      <Card>
        <Stack>
          <Heading>Control plane</Heading>
          <TextField
            value={controlPlaneUrl}
            onChangeText={setControlPlaneUrl}
            placeholder="https://control-plane.example.com"
          />
          <Body muted>Changing the control plane starts a new session.</Body>
        </Stack>
      </Card>

      <Card>
        <Stack>
          <Heading>Sandbox provider</Heading>
          <SegmentedControl
            accessibilityLabel="Sandbox provider"
            value={sandboxProvider}
            onChange={setSandboxProvider}
            options={SANDBOX_PROVIDERS.map((provider) => ({
              value: provider,
              label: SANDBOX_PROVIDER_LABELS_V1[provider],
            }))}
          />
          {sandboxProvider === 'docker' ? (
            <Stack gap={2}>
              <Body muted>
                Self-hosted: sandboxes run on your control plane&apos;s own Docker host. No provider
                account, no API key, nothing metered — bounded only by that machine.
              </Body>
              {signedIn && !sandboxEnabled ? (
                <Row>
                  <TouchButton
                    label="Enable Docker sandboxes"
                    onPress={() =>
                      void submitKey('sandbox:docker', DOCKER_SANDBOX_PLACEHOLDER_KEY_V1, () => undefined)
                    }
                  />
                </Row>
              ) : null}
            </Stack>
          ) : (
            <>
              <TextField
                value={sandboxKeyDraft}
                onChangeText={setSandboxKeyDraft}
                placeholder={`${sandboxProviderLabel} API key`}
                secureTextEntry
                editable={signedIn}
              />
              <Row>
                <TouchButton
                  label="Save sandbox key"
                  disabled={!signedIn || sandboxKeyDraft.length === 0}
                  onPress={() =>
                    void submitKey(`sandbox:${sandboxProvider}`, sandboxKeyDraft, () =>
                      setSandboxKeyDraft('')
                    )
                  }
                />
              </Row>
            </>
          )}
          {signedIn ? keyStatusFor('sandbox') : (
            <Body muted>Sign in to submit keys.</Body>
          )}
        </Stack>
      </Card>

      <Card>
        <Stack>
          <Heading>Claude Code in your sandbox</Heading>
          <Body muted>
            Sign the Claude Code CLI in inside your persistent {sandboxProviderLabel} sandbox, on
            your own Claude subscription. Tasks whose model is `{CLAUDE_CLI_DEFAULT_MODEL_V1}` then
            run every round through that CLI — editing files and running commands there, exactly
            as it does on a laptop — with no API key stored anywhere.
          </Body>
          {!signedIn ? (
            <Body muted>Sign in to the control plane first.</Body>
          ) : cliLogin.kind === 'idle' || cliLogin.kind === 'failed' || cliLogin.kind === 'signedIn' ? (
            <Stack gap={2}>
              {cliLogin.kind !== 'idle' ? <Body>{cliLogin.message}</Body> : null}
              <Row>
                <TouchButton
                  label={cliLogin.kind === 'signedIn' ? 'Sign in again' : 'Sign in Claude Code'}
                  variant={cliLogin.kind === 'signedIn' ? 'secondary' : 'primary'}
                  disabled={!sandboxEnabled}
                  onPress={() => void startCliLogin()}
                />
              </Row>
              {!sandboxEnabled ? (
                <Body muted>{`Enable ${sandboxProviderLabel} sandboxes above first.`}</Body>
              ) : null}
              {sandboxEnabled ? (
                <Row>
                  <TouchButton
                    label={
                      resetArmed
                        ? `Really destroy your ${sandboxProviderLabel} sandbox? Press again`
                        : 'Reset sandbox'
                    }
                    variant="secondary"
                    onPress={() => void resetSandbox()}
                  />
                  {resetArmed ? (
                    <TouchButton label="Keep it" variant="secondary" onPress={() => setResetArmedFor(null)} />
                  ) : null}
                </Row>
              ) : null}
              {resetNotice !== null ? <Body muted>{resetNotice}</Body> : null}
            </Stack>
          ) : cliLogin.kind === 'starting' ? (
            <Body muted>Starting the CLI sign-in in your sandbox…</Body>
          ) : (
            <Stack gap={2}>
              <Body>1. Open the sign-in link and approve it in your browser.</Body>
              {cliLogin.url !== undefined ? (
                <Row>
                  <TouchButton label="Open sign-in link" onPress={() => openCliLoginUrl(cliLogin.url as string)} />
                </Row>
              ) : null}
              {cliLogin.url !== undefined ? (
                <TextField value={cliLogin.url} onChangeText={() => undefined} editable={false} />
              ) : null}
              <Body>2. Paste the code it shows you here — within a few minutes, before it expires.</Body>
              <TextField
                value={cliCodeDraft}
                onChangeText={setCliCodeDraft}
                placeholder="Authorization code"
                editable={!cliLogin.submitting}
              />
              <Row>
                <TouchButton
                  label={cliLogin.submitting ? 'Submitting…' : 'Submit code'}
                  disabled={cliLogin.submitting || cliCodeDraft.trim().length === 0}
                  onPress={() => void submitCliLoginCode()}
                />
                <TouchButton
                  label="Cancel"
                  variant="secondary"
                  disabled={cliLogin.submitting}
                  onPress={() => setCliLogin({ kind: 'idle' })}
                />
              </Row>
              {cliLogin.notice !== null ? <Body muted>{cliLogin.notice}</Body> : null}
            </Stack>
          )}
        </Stack>
      </Card>

      <Card>
        <Stack>
          <Heading>Models</Heading>
          <TextField
            value={modelPrimary}
            onChangeText={setModelPrimary}
            placeholder="provider:model (e.g. claude-cli:sonnet or anthropic:claude-sonnet-5)"
          />
          {modelProviderId === CLAUDE_CLI_MODEL_PROVIDER_V1 ? (
            <Body muted>
              Runs through the Claude Code CLI signed in to your sandbox (above). No key to store;
              the subscription pays. Append an effort level like `claude-cli:opus@high` if you want one.
            </Body>
          ) : (
            <>
              <TextField
                value={modelKeyDraft}
                onChangeText={setModelKeyDraft}
                placeholder={`${modelProviderId} API key`}
                secureTextEntry
                editable={signedIn}
              />
              <Row>
                <TouchButton
                  label="Save model key"
                  disabled={!signedIn || modelKeyDraft.length === 0}
                  onPress={() =>
                    void submitKey(`model:${modelProviderId}`, modelKeyDraft, () => setModelKeyDraft(''))
                  }
                />
              </Row>
            </>
          )}
          {signedIn ? keyStatusFor('model') : null}
        </Stack>
      </Card>


      <Card>
        <Stack>
          <Heading>Gate policy</Heading>
          <SegmentedControl
            accessibilityLabel="Gate policy"
            value={gateApprovalRequired ? 'required' : 'optional'}
            onChange={(next) => setGateApprovalRequired(next === 'required')}
            options={[
              { value: 'required', label: 'Required' },
              { value: 'optional', label: 'Optional' },
            ]}
          />
          <Body muted>
            When required, every gate pauses execution until you approve or reject it in-app.
          </Body>
        </Stack>
      </Card>

      <Card>
        <Stack>
          <Heading>Appearance</Heading>
          <SegmentedControl
            accessibilityLabel="Appearance"
            value={themePreference}
            onChange={setThemePreference}
            options={THEME_OPTIONS.map((option) => ({ value: option, label: option }))}
          />
        </Stack>
      </Card>
    </Screen>
  );
}
