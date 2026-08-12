import React from 'react';

import type { SandboxProviderV1 } from '../api/controlPlaneClientV1';
import { Body, Card, Heading, Row, Screen, Stack, TextField, Title, TouchButton } from '../components/primitives';
import { getAppServicesV1 } from '../services/appServicesV1';
import { useAppStore, type ThemePreference } from '../state/appStore';

const THEME_OPTIONS: ThemePreference[] = ['system', 'light', 'dark'];
const SANDBOX_PROVIDERS: SandboxProviderV1[] = ['e2b', 'daytona'];
const SIGN_IN_PROVIDERS = ['github', 'google'] as const;

/**
 * Settings tab (plan Part 6): sign-in, control-plane connection, sandbox
 * provider selection (E2B/Daytona), API key submission with masked
 * metadata, model configuration, and the gate policy default. Ported from
 * the extension's settings-view semantics (`ensemble.*` keys only). Key
 * material is submitted over TLS to the control plane and NEVER persisted
 * on-device; the list below shows the server's masked hints only.
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
  const [sandboxKeyDraft, setSandboxKeyDraft] = React.useState('');
  const [modelKeyDraft, setModelKeyDraft] = React.useState('');

  const services = getAppServicesV1(controlPlaneUrl);
  const signedIn = session.status === 'signedIn';

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
      setNotice(null);
      await refreshKeyRecords();
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
    if (result.ok) {
      clear();
      setNotice(null);
      await refreshKeyRecords();
    } else {
      setNotice(`Key submission failed: ${result.message}`);
    }
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
          <Row>
            {SANDBOX_PROVIDERS.map((provider) => (
              <TouchButton
                key={provider}
                label={provider === 'e2b' ? 'E2B' : 'Daytona'}
                variant={sandboxProvider === provider ? 'primary' : 'secondary'}
                onPress={() => setSandboxProvider(provider)}
              />
            ))}
          </Row>
          <TextField
            value={sandboxKeyDraft}
            onChangeText={setSandboxKeyDraft}
            placeholder={`${sandboxProvider === 'e2b' ? 'E2B' : 'Daytona'} API key`}
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
          {!signedIn ? <Body muted>Sign in to submit keys.</Body> : null}
        </Stack>
      </Card>

      <Card>
        <Stack>
          <Heading>Models</Heading>
          <TextField
            value={modelPrimary}
            onChangeText={setModelPrimary}
            placeholder="provider:model (e.g. anthropic:claude-sonnet-5)"
          />
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
        </Stack>
      </Card>

      <Card>
        <Stack>
          <Heading>Stored keys</Heading>
          {keyRecords.length === 0 ? (
            <Body muted>
              No stored keys{signedIn ? '' : ' (sign in to view)'}. Keys are held server-side,
              encrypted at rest, and are never readable back — only these masked hints.
            </Body>
          ) : (
            keyRecords.map((record) => (
              <Row key={record.keyKind} style={{ justifyContent: 'space-between' }}>
                <Body>{`${record.keyKind} — ${record.maskedHint}`}</Body>
                <TouchButton
                  label="Remove"
                  variant="secondary"
                  onPress={() =>
                    void services.client.deleteKey(record.keyKind).then(refreshKeyRecords)
                  }
                />
              </Row>
            ))
          )}
        </Stack>
      </Card>

      <Card>
        <Stack>
          <Heading>Gate policy</Heading>
          <Row>
            <TouchButton
              label={gateApprovalRequired ? 'Approval required' : 'Approval optional'}
              variant={gateApprovalRequired ? 'primary' : 'secondary'}
              onPress={() => setGateApprovalRequired(!gateApprovalRequired)}
            />
          </Row>
          <Body muted>
            When required, every gate pauses execution until you approve or reject it in-app.
          </Body>
        </Stack>
      </Card>

      <Card>
        <Stack>
          <Heading>Appearance</Heading>
          <Row>
            {THEME_OPTIONS.map((option) => (
              <TouchButton
                key={option}
                label={option}
                variant={themePreference === option ? 'primary' : 'secondary'}
                onPress={() => setThemePreference(option)}
              />
            ))}
          </Row>
        </Stack>
      </Card>
    </Screen>
  );
}
