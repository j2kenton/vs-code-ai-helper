import React from 'react';
import { StyleSheet, Text } from 'react-native';

import type {
  ControlPlaneClientV1,
  SandboxBindingRequestV1,
  SandboxProviderV1,
  TaskDtoV1,
  TaskRoundDtoV1,
} from '../api/controlPlaneClientV1';
import {
  Body,
  Card,
  Heading,
  Row,
  Screen,
  Stack,
  TextField,
  Title,
  TouchButton,
} from '../components/primitives';
import { getAppServicesV1 } from '../services/appServicesV1';
import { useAppStore } from '../state/appStore';
import {
  latestRoundProgressV1,
  statusBadgeV1,
  taskDisplayNameV1,
  type RoundProgressV1,
  type StatusBadgeToneV1,
} from '../tasks/taskPresentationV1';
import { useTheme } from '../theme/ThemeProvider';

/**
 * Task management tab (plan Part 7), ported from the extension's task tree /
 * status view intent: the task list shows display names under the fallback
 * naming rule (never raw internal folder names), `N/M` part progress from the
 * latest round, and status badges; the detail view shows per-round history;
 * the creation form mirrors the context-pack request shape plus the Part 3
 * SandboxBinding inputs, surfacing the contract's typed binding errors.
 */

type TasksViewState =
  | { readonly kind: 'list' }
  | { readonly kind: 'detail'; readonly taskId: string }
  | { readonly kind: 'create' };

function StatusBadge({ status }: { status?: string }): React.JSX.Element {
  const theme = useTheme();
  const badge = statusBadgeV1(status);
  const toneColors: Record<StatusBadgeToneV1, string> = {
    accent: theme.colors.accent,
    success: theme.colors.success,
    warning: theme.colors.warning,
    danger: theme.colors.danger,
    muted: theme.colors.textMuted,
  };
  const color = toneColors[badge.tone];
  return (
    <Text
      style={[
        theme.typography.caption,
        styles.badge,
        { color, borderColor: color, borderRadius: theme.radius.sm },
      ]}
    >
      {badge.label}
    </Text>
  );
}

function formatProgress(progress: RoundProgressV1 | null): string | null {
  return progress === null ? null : `${progress.complete}/${progress.total} parts`;
}

interface TaskListProps {
  readonly tasks: readonly TaskDtoV1[];
  readonly progressById: Readonly<Record<string, RoundProgressV1 | null>>;
  readonly loading: boolean;
  readonly loadError: string | null;
  readonly onRefresh: () => void;
  readonly onOpen: (taskId: string) => void;
  readonly onCreate: () => void;
}

function TaskList(props: TaskListProps): React.JSX.Element {
  return (
    <>
      <Row style={styles.spaceBetween}>
        <Title>Tasks</Title>
        <Row>
          <TouchButton label="Refresh" variant="secondary" onPress={props.onRefresh} disabled={props.loading} />
          <TouchButton label="New task" onPress={props.onCreate} />
        </Row>
      </Row>
      {props.loadError !== null ? <Body muted>{props.loadError}</Body> : null}
      {props.tasks.length === 0 ? (
        <Card>
          <Stack gap={1}>
            <Heading>No tasks yet</Heading>
            <Body muted>Create a task with a sandbox binding to see it here.</Body>
          </Stack>
        </Card>
      ) : (
        props.tasks.map((task) => {
          const progressLabel = formatProgress(props.progressById[task.taskId] ?? null);
          return (
            <Card key={task.taskId}>
              <Stack gap={2}>
                <Row style={styles.spaceBetween}>
                  <Heading>{taskDisplayNameV1(task.progress)}</Heading>
                  <StatusBadge status={task.progress.status} />
                </Row>
                <Body muted>
                  {`Stage: ${task.progress.currentStage}${progressLabel !== null ? ` · ${progressLabel}` : ''}`}
                </Body>
                <Row>
                  <TouchButton label="Open" variant="secondary" onPress={() => props.onOpen(task.taskId)} />
                </Row>
              </Stack>
            </Card>
          );
        })
      )}
    </>
  );
}

interface TaskDetailProps {
  readonly client: ControlPlaneClientV1;
  readonly taskId: string;
  readonly onBack: () => void;
}

function TaskDetail({ client, taskId, onBack }: TaskDetailProps): React.JSX.Element {
  const [task, setTask] = React.useState<TaskDtoV1 | null>(null);
  const [rounds, setRounds] = React.useState<readonly TaskRoundDtoV1[]>([]);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const [taskResult, historyResult] = await Promise.all([
      client.getTask(taskId),
      client.getTaskHistory(taskId),
    ]);
    if (taskResult.ok) {
      setTask(taskResult.body);
      setError(null);
    } else {
      setError(`${taskResult.code}: ${taskResult.message}`);
    }
    if (historyResult.ok) {
      setRounds(historyResult.body);
    }
  }, [client, taskId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const progressLabel = formatProgress(latestRoundProgressV1(rounds));

  return (
    <>
      <Row style={styles.spaceBetween}>
        <Title>{task !== null ? taskDisplayNameV1(task.progress) : 'Task'}</Title>
        <Row>
          <TouchButton label="Refresh" variant="secondary" onPress={() => void load()} />
          <TouchButton label="Back" variant="secondary" onPress={onBack} />
        </Row>
      </Row>
      {error !== null ? <Body muted>{error}</Body> : null}
      {task !== null ? (
        <Card>
          <Stack gap={2}>
            <Row style={styles.spaceBetween}>
              <Heading>Status</Heading>
              <StatusBadge status={task.progress.status} />
            </Row>
            <Body>{`Stage: ${task.progress.currentStage}`}</Body>
            {progressLabel !== null ? <Body>{`Progress: ${progressLabel}`}</Body> : null}
            <Body muted>{`Sandbox binding: ${task.bindingId}`}</Body>
            <Body muted>{`Updated: ${task.progress.updatedAt}`}</Body>
          </Stack>
        </Card>
      ) : null}
      <Card>
        <Stack gap={2}>
          <Heading>Round history</Heading>
          {rounds.length === 0 ? (
            <Body muted>No completed rounds yet.</Body>
          ) : (
            rounds.map((round) => (
              <Stack key={round.roundId} gap={1}>
                <Row style={styles.spaceBetween}>
                  <Body>{`${round.stage}${round.summary !== undefined ? ` — ${round.summary}` : ''}`}</Body>
                </Row>
                <Body muted>
                  {round.completedAt !== undefined
                    ? `${round.startedAt} → ${round.completedAt}`
                    : `started ${round.startedAt}`}
                </Body>
              </Stack>
            ))
          )}
        </Stack>
      </Card>
    </>
  );
}

const SANDBOX_PROVIDERS: readonly SandboxProviderV1[] = ['e2b', 'daytona'];

interface TaskCreateFormProps {
  readonly client: ControlPlaneClientV1;
  readonly defaultProvider: SandboxProviderV1;
  /** Model selection surfaced from Settings (Part 9); editable per task. */
  readonly defaultModel: string;
  readonly onCancel: () => void;
  readonly onCreated: (task: TaskDtoV1) => void;
}

function TaskCreateForm(props: TaskCreateFormProps): React.JSX.Element {
  const [displayName, setDisplayName] = React.useState('');
  const [request, setRequest] = React.useState('');
  const [model, setModel] = React.useState(props.defaultModel);
  const [provider, setProvider] = React.useState<SandboxProviderV1>(props.defaultProvider);
  const [sandboxId, setSandboxId] = React.useState('');
  const [sourceKind, setSourceKind] = React.useState<'gitClone' | 'attachExisting'>('gitClone');
  const [gitUrl, setGitUrl] = React.useState('');
  const [gitRef, setGitRef] = React.useState('main');
  const [attachPath, setAttachPath] = React.useState('');
  const [workingDirectoryRoot, setWorkingDirectoryRoot] = React.useState('/workspace');
  const [lifecycle, setLifecycle] = React.useState<'task-owned-ephemeral' | 'user-managed-persistent'>(
    'task-owned-ephemeral'
  );
  const [cleanup, setCleanup] = React.useState<'destroy-on-completion' | 'retain'>(
    'destroy-on-completion'
  );
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(): Promise<void> {
    const sandboxBinding: SandboxBindingRequestV1 = {
      provider,
      sandboxId,
      source:
        sourceKind === 'gitClone'
          ? { kind: 'gitClone', repoUrl: gitUrl, ref: gitRef }
          : { kind: 'attachExisting', path: attachPath },
      workingDirectoryRoot,
      lifecycle,
      cleanup,
    };
    const trimmedName = displayName.trim();
    const trimmedModel = model.trim();
    setSubmitting(true);
    const result = await props.client.createTask({
      request,
      ...(trimmedName.length > 0 ? { displayName: trimmedName } : {}),
      // Part 9: the selection round-trips through the contract to the
      // engine; the server validates it (typed modelSelectionInvalid).
      ...(trimmedModel.length > 0 ? { model: trimmedModel } : {}),
      sandboxBinding,
    });
    setSubmitting(false);
    if (result.ok) {
      props.onCreated(result.body);
    } else {
      // The contract's typed binding failures (sandboxBindingInvalid,
      // sandboxProviderKeyMissing, sandboxUnreachable, ...) surface verbatim.
      setError(`${result.code}: ${result.message}`);
    }
  }

  return (
    <>
      <Row style={styles.spaceBetween}>
        <Title>New task</Title>
        <TouchButton label="Cancel" variant="secondary" onPress={props.onCancel} />
      </Row>
      <Card>
        <Stack>
          <Heading>Task</Heading>
          <TextField value={displayName} onChangeText={setDisplayName} placeholder="Display name (optional)" autoCapitalize="sentences" />
          <TextField value={request} onChangeText={setRequest} placeholder="What should the ensemble do?" autoCapitalize="sentences" multiline />
        </Stack>
      </Card>
      <Card>
        <Stack>
          <Heading>Model</Heading>
          <TextField
            value={model}
            onChangeText={setModel}
            placeholder="provider:model (blank = server default)"
          />
          <Body muted>
            Prefilled from Settings; the engine runs this task&apos;s rounds with the selected model.
          </Body>
        </Stack>
      </Card>
      <Card>
        <Stack>
          <Heading>Sandbox binding</Heading>
          <Row>
            {SANDBOX_PROVIDERS.map((option) => (
              <TouchButton
                key={option}
                label={option === 'e2b' ? 'E2B' : 'Daytona'}
                variant={provider === option ? 'primary' : 'secondary'}
                onPress={() => setProvider(option)}
              />
            ))}
          </Row>
          <TextField value={sandboxId} onChangeText={setSandboxId} placeholder="Sandbox / workspace id" />
          <Row>
            <TouchButton
              label="Clone git repo"
              variant={sourceKind === 'gitClone' ? 'primary' : 'secondary'}
              onPress={() => setSourceKind('gitClone')}
            />
            <TouchButton
              label="Attach existing"
              variant={sourceKind === 'attachExisting' ? 'primary' : 'secondary'}
              onPress={() => setSourceKind('attachExisting')}
            />
          </Row>
          {sourceKind === 'gitClone' ? (
            <Stack gap={2}>
              <TextField value={gitUrl} onChangeText={setGitUrl} placeholder="Repository URL" />
              <TextField value={gitRef} onChangeText={setGitRef} placeholder="Ref (branch, tag, or commit)" />
            </Stack>
          ) : (
            <TextField value={attachPath} onChangeText={setAttachPath} placeholder="Existing workspace path" />
          )}
          <TextField
            value={workingDirectoryRoot}
            onChangeText={setWorkingDirectoryRoot}
            placeholder="Allowed working-directory root"
          />
          <Row>
            <TouchButton
              label={lifecycle === 'task-owned-ephemeral' ? 'Task-owned sandbox' : 'User-managed workspace'}
              variant="secondary"
              onPress={() =>
                setLifecycle(
                  lifecycle === 'task-owned-ephemeral' ? 'user-managed-persistent' : 'task-owned-ephemeral'
                )
              }
            />
            <TouchButton
              label={cleanup === 'destroy-on-completion' ? 'Destroy on completion' : 'Retain sandbox'}
              variant="secondary"
              onPress={() => setCleanup(cleanup === 'destroy-on-completion' ? 'retain' : 'destroy-on-completion')}
            />
          </Row>
        </Stack>
      </Card>
      {error !== null ? (
        <Card>
          <Body muted>{error}</Body>
        </Card>
      ) : null}
      <Row>
        <TouchButton
          label={submitting ? 'Creating…' : 'Create task'}
          disabled={submitting || request.trim().length === 0 || sandboxId.trim().length === 0}
          onPress={() => void submit()}
        />
      </Row>
    </>
  );
}

export function TasksScreen(): React.JSX.Element {
  const session = useAppStore((s) => s.session);
  const setSession = useAppStore((s) => s.setSession);
  const controlPlaneUrl = useAppStore((s) => s.controlPlaneUrl);
  const sandboxProvider = useAppStore((s) => s.sandboxProvider);
  const modelPrimary = useAppStore((s) => s.modelPrimary);
  const setActiveTaskId = useAppStore((s) => s.setActiveTaskId);

  const services = getAppServicesV1(controlPlaneUrl);
  const signedIn = session.status === 'signedIn';

  const [view, setView] = React.useState<TasksViewState>({ kind: 'list' });
  const [tasks, setTasks] = React.useState<readonly TaskDtoV1[]>([]);
  const [progressById, setProgressById] = React.useState<Record<string, RoundProgressV1 | null>>({});
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  React.useEffect(() => services.session.onChange(setSession), [services, setSession]);

  const refreshTasks = React.useCallback(async () => {
    setLoading(true);
    const result = await services.client.listTasks();
    if (result.ok) {
      setTasks(result.body);
      setLoadError(null);
      // The server now carries each task's latest round on the list DTO
      // (`latestRound`), so the list no longer needs a per-task
      // `getTaskHistory` fetch just to derive `N/M` progress — that call is
      // reserved for the detail screen's full round history.
      const entries = result.body.map(
        (task) =>
          [
            task.taskId,
            task.latestRound !== undefined ? latestRoundProgressV1([task.latestRound]) : null,
          ] as const
      );
      setProgressById(Object.fromEntries(entries));
    } else {
      setLoadError(`${result.code}: ${result.message}`);
    }
    setLoading(false);
  }, [services]);

  React.useEffect(() => {
    if (signedIn) {
      void refreshTasks();
    } else {
      setTasks([]);
      setProgressById({});
      setView({ kind: 'list' });
    }
  }, [signedIn, refreshTasks]);

  function openTask(taskId: string): void {
    setActiveTaskId(taskId);
    setView({ kind: 'detail', taskId });
  }

  if (!signedIn) {
    return (
      <Screen>
        <Title>Tasks</Title>
        <Card>
          <Stack gap={1}>
            <Heading>Sign in to manage tasks</Heading>
            <Body muted>
              Connect a control plane and sign in from the Settings tab; tasks you create appear here
              with live progress.
            </Body>
          </Stack>
        </Card>
      </Screen>
    );
  }

  return (
    <Screen>
      {view.kind === 'list' ? (
        <TaskList
          tasks={tasks}
          progressById={progressById}
          loading={loading}
          loadError={loadError}
          onRefresh={() => void refreshTasks()}
          onOpen={openTask}
          onCreate={() => setView({ kind: 'create' })}
        />
      ) : null}
      {view.kind === 'detail' ? (
        <TaskDetail client={services.client} taskId={view.taskId} onBack={() => setView({ kind: 'list' })} />
      ) : null}
      {view.kind === 'create' ? (
        <TaskCreateForm
          client={services.client}
          defaultProvider={sandboxProvider}
          defaultModel={modelPrimary}
          onCancel={() => setView({ kind: 'list' })}
          onCreated={(task) => {
            void refreshTasks();
            openTask(task.taskId);
          }}
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  spaceBetween: { justifyContent: 'space-between' },
  badge: {
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 8,
    paddingVertical: 2,
    overflow: 'hidden',
  },
});
