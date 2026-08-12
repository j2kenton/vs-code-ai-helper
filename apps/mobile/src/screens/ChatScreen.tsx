import React from 'react';
import { StyleSheet } from 'react-native';

import type { ChatTurnDtoV1, ControlPlaneClientV1, GateDtoV1 } from '../api/controlPlaneClientV1';
import { createGateDecisionRequestV1, randomHex32V1, type GateDecisionRequestV1 } from '../chat/gateDecisionV1';
import {
  buildStructuredAnswersV1,
  initialDraftsV1,
  toggleOptionV1,
  EMPTY_ANSWER_DRAFT_V1,
  type AnswerDraftV1,
  type StructuredQuestionV1,
} from '../chat/structuredQuestionsV1';
import { Body, Card, Heading, Row, Screen, Stack, TextField, Title, TouchButton } from '../components/primitives';
import { getAppServicesV1 } from '../services/appServicesV1';
import { useAppStore, type PendingQuestionsV1 } from '../state/appStore';

/**
 * AI chat and gate control (plan Part 9), porting the extension chat view's
 * semantics to the Part 3 contract: a per-task thread of chat turns,
 * structured-question interactions rendered as answerable forms (`kind:
 * questions` frames arriving over the Part 8 stream), and idempotent gate
 * approve/deny with confirmation.
 *
 * Idempotency, per the contract: the answer submission id and the gate
 * decision payload (including its idempotency key) are each generated ONCE
 * per user decision and reused VERBATIM on every retry, so a flaky
 * connection can never double-submit or double-approve; a same-key/
 * different-payload replay would surface the contract's typed mismatch
 * error, and a conflicting decision its typed conflict.
 */

interface QuestionFormProps {
  readonly client: ControlPlaneClientV1;
  readonly taskId: string;
  readonly pending: PendingQuestionsV1;
  readonly onSubmitted: () => void;
}

function QuestionCard({
  question,
  draft,
  onDraft,
}: {
  readonly question: StructuredQuestionV1;
  readonly draft: AnswerDraftV1;
  readonly onDraft: (next: AnswerDraftV1) => void;
}): React.JSX.Element {
  return (
    <Stack gap={2}>
      <Heading>{question.prompt}</Heading>
      {question.helpText !== undefined ? <Body muted>{question.helpText}</Body> : null}
      {question.kind === 'text' ? (
        <TextField
          value={draft.text}
          onChangeText={(text) => onDraft({ ...draft, skipped: false, text })}
          placeholder="Your answer"
          autoCapitalize="sentences"
          multiline
        />
      ) : (
        <Stack gap={2}>
          {question.options.map((option) => {
            const selected = draft.selectedOptionIds.includes(option.optionId);
            return (
              <TouchButton
                key={option.optionId}
                label={option.label}
                variant={selected ? 'primary' : 'secondary'}
                onPress={() => onDraft(toggleOptionV1(draft, option.optionId, question.kind === 'singleChoice'))}
              />
            );
          })}
          {question.kind === 'multipleChoice' ? (
            <Body muted>{`Select ${question.minSelections}–${question.maxSelections}`}</Body>
          ) : null}
        </Stack>
      )}
      {!question.required ? (
        <Row>
          <TouchButton
            label={draft.skipped ? 'Skipped (tap to answer)' : 'Skip this question'}
            variant="secondary"
            onPress={() => onDraft({ ...draft, skipped: !draft.skipped })}
          />
        </Row>
      ) : null}
    </Stack>
  );
}

function QuestionForm({ client, taskId, pending, onSubmitted }: QuestionFormProps): React.JSX.Element {
  const [drafts, setDrafts] = React.useState<Readonly<Record<string, AnswerDraftV1>>>(() =>
    initialDraftsV1(pending.questions)
  );
  // Generated once per interaction and reused verbatim on retries, so the
  // server's answer idempotency rule sees one submission, not two.
  const submissionIdRef = React.useRef<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setDrafts(initialDraftsV1(pending.questions));
    submissionIdRef.current = null;
    setError(null);
  }, [pending.interactionId, pending.questions]);

  async function submit(): Promise<void> {
    const built = buildStructuredAnswersV1(pending.questions, drafts);
    if (!built.ok) {
      setError(`"${built.questionId}": ${built.reason}`);
      return;
    }
    submissionIdRef.current ??= randomHex32V1();
    setSubmitting(true);
    const result = await client.submitStructuredAnswers(taskId, {
      interactionId: pending.interactionId,
      answers: built.answers,
      answerIdempotencyId: submissionIdRef.current,
    });
    setSubmitting(false);
    if (result.ok) {
      setError(null);
      onSubmitted();
    } else {
      // Keep the submission id: a retry replays the same idempotent request.
      setError(`${result.code}: ${result.message}`);
    }
  }

  return (
    <Card>
      <Stack>
        <Heading>The agent needs answers</Heading>
        {pending.questions.map((question) => (
          <QuestionCard
            key={question.questionId}
            question={question}
            draft={drafts[question.questionId] ?? EMPTY_ANSWER_DRAFT_V1}
            onDraft={(next) => setDrafts((current) => ({ ...current, [question.questionId]: next }))}
          />
        ))}
        {error !== null ? <Body muted>{error}</Body> : null}
        <Row>
          <TouchButton
            label={submitting ? 'Submitting…' : 'Submit answers'}
            disabled={submitting}
            onPress={() => void submit()}
          />
        </Row>
      </Stack>
    </Card>
  );
}

interface GateCardProps {
  readonly client: ControlPlaneClientV1;
  readonly gate: GateDtoV1;
  readonly highlighted: boolean;
  readonly onDecided: () => void;
}

function GateCard({ client, gate, highlighted, onDecided }: GateCardProps): React.JSX.Element {
  const [comment, setComment] = React.useState('');
  // The frozen decision payload: created once at confirmation, resubmitted
  // unchanged on retry (same idempotency key, identical payload).
  const [request, setRequest] = React.useState<GateDecisionRequestV1 | null>(null);
  const [confirming, setConfirming] = React.useState<'approve' | 'reject' | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [outcome, setOutcome] = React.useState<string | null>(null);

  async function submitDecision(decision: GateDecisionRequestV1): Promise<void> {
    setSubmitting(true);
    const result = await client.decideGate(gate.gateId, decision);
    setSubmitting(false);
    if (result.ok) {
      setError(null);
      setOutcome(
        `${result.body.state} at ${result.body.decidedAt}${result.body.replayed ? ' (replayed original outcome)' : ''}`
      );
      onDecided();
    } else {
      // Typed contract errors surface verbatim (payload mismatch, conflict);
      // the frozen request stays for an identical retry.
      setError(`${result.code}: ${result.message}`);
    }
  }

  function confirm(decision: 'approve' | 'reject'): void {
    const frozen = request ?? createGateDecisionRequestV1(decision, comment);
    setRequest(frozen);
    void submitDecision(frozen);
  }

  const pending = gate.state === 'pending' && outcome === null;

  return (
    <Card style={highlighted ? styles.highlighted : undefined}>
      <Stack gap={2}>
        <Row style={styles.spaceBetween}>
          <Heading>{pending ? 'Gate pending' : `Gate ${gate.state}`}</Heading>
          <Body muted>{gate.requestedAt}</Body>
        </Row>
        <Body>{gate.summary}</Body>
        {pending ? (
          confirming === null ? (
            <Row>
              <TouchButton label="Approve…" onPress={() => setConfirming('approve')} />
              <TouchButton label="Reject…" variant="secondary" onPress={() => setConfirming('reject')} />
            </Row>
          ) : (
            <Stack gap={2}>
              <Body>{`Confirm ${confirming === 'approve' ? 'approval' : 'rejection'}? Execution ${
                confirming === 'approve' ? 'resumes in your sandbox' : 'stays paused'
              }.`}</Body>
              <TextField
                value={comment}
                onChangeText={setComment}
                placeholder="Comment (optional)"
                autoCapitalize="sentences"
                editable={request === null}
              />
              <Row>
                <TouchButton
                  label={submitting ? 'Sending…' : error !== null ? `Retry ${confirming}` : `Confirm ${confirming}`}
                  disabled={submitting}
                  onPress={() => confirm(confirming)}
                />
                <TouchButton
                  label="Cancel"
                  variant="secondary"
                  disabled={submitting}
                  onPress={() => {
                    setConfirming(null);
                    setRequest(null);
                    setError(null);
                  }}
                />
              </Row>
            </Stack>
          )
        ) : null}
        {outcome !== null ? <Body>{`Decision: ${outcome}`}</Body> : null}
        {error !== null ? <Body muted>{error}</Body> : null}
      </Stack>
    </Card>
  );
}

export function ChatScreen(): React.JSX.Element {
  const session = useAppStore((s) => s.session);
  const controlPlaneUrl = useAppStore((s) => s.controlPlaneUrl);
  const activeTaskId = useAppStore((s) => s.activeTaskId);
  const activeGateId = useAppStore((s) => s.activeGateId);
  const setActiveGateId = useAppStore((s) => s.setActiveGateId);
  const pendingQuestionsByTask = useAppStore((s) => s.pendingQuestionsByTask);
  const clearPendingQuestions = useAppStore((s) => s.clearPendingQuestions);
  // Scalar selection: only THIS task's revision re-renders the screen — a
  // bump for another task changes neither the selected value nor the render.
  const streamRevision = useAppStore((s) =>
    s.activeTaskId !== null ? (s.chatStreamRevisionByTask[s.activeTaskId] ?? 0) : 0
  );

  const services = getAppServicesV1(controlPlaneUrl);
  const signedIn = session.status === 'signedIn';

  const [turns, setTurns] = React.useState<readonly ChatTurnDtoV1[]>([]);
  const [gates, setGates] = React.useState<readonly GateDtoV1[]>([]);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState('');
  const [sending, setSending] = React.useState(false);

  const load = React.useCallback(async () => {
    if (activeTaskId === null) {
      return;
    }
    const [turnsResult, gatesResult] = await Promise.all([
      services.client.listChatTurns(activeTaskId),
      services.client.listGates(activeTaskId),
    ]);
    if (turnsResult.ok) {
      setTurns(turnsResult.body);
      setLoadError(null);
    } else {
      setLoadError(`${turnsResult.code}: ${turnsResult.message}`);
    }
    if (gatesResult.ok) {
      setGates(gatesResult.body);
    }
  }, [services, activeTaskId]);

  React.useEffect(() => {
    // Reset only when the task (or session) changes — a stream-driven
    // refresh below re-fetches in place without blanking the transcript.
    setTurns([]);
    setGates([]);
    setLoadError(null);
  }, [signedIn, activeTaskId]);

  React.useEffect(() => {
    if (signedIn && activeTaskId !== null) {
      void load();
    }
  }, [signedIn, activeTaskId, load, streamRevision]);

  if (!signedIn || activeTaskId === null) {
    return (
      <Screen>
        <Title>Chat</Title>
        <Card>
          <Stack gap={1}>
            <Heading>{signedIn ? 'No task selected' : 'Sign in to chat'}</Heading>
            <Body muted>
              {signedIn
                ? 'Open a task from the Tasks tab to orchestrate its agents and answer gate requests.'
                : 'Sign in from the Settings tab, then pick a task to chat with its agents.'}
            </Body>
          </Stack>
        </Card>
      </Screen>
    );
  }

  const pending = pendingQuestionsByTask[activeTaskId];
  const sortedGates = [...gates].sort((a, b) => {
    if (a.gateId === activeGateId) {
      return -1;
    }
    if (b.gateId === activeGateId) {
      return 1;
    }
    const pendingRank = (gate: GateDtoV1): number => (gate.state === 'pending' ? 0 : 1);
    return pendingRank(a) - pendingRank(b);
  });

  async function send(): Promise<void> {
    const text = message.trim();
    if (text.length === 0 || activeTaskId === null) {
      return;
    }
    setSending(true);
    const result = await services.client.sendChatMessage(activeTaskId, text);
    setSending(false);
    if (result.ok) {
      setMessage('');
      await load();
    } else {
      setLoadError(`${result.code}: ${result.message}`);
    }
  }

  return (
    <Screen>
      <Row style={styles.spaceBetween}>
        <Title>Chat</Title>
        <TouchButton label="Refresh" variant="secondary" onPress={() => void load()} />
      </Row>
      <Body muted>{`Task ${activeTaskId}`}</Body>
      {loadError !== null ? <Body muted>{loadError}</Body> : null}

      {sortedGates.map((gate) => (
        <GateCard
          key={gate.gateId}
          client={services.client}
          gate={gate}
          highlighted={gate.gateId === activeGateId}
          onDecided={() => {
            if (gate.gateId === activeGateId) {
              setActiveGateId(null);
            }
            void load();
          }}
        />
      ))}

      {pending !== undefined ? (
        <QuestionForm
          client={services.client}
          taskId={activeTaskId}
          pending={pending}
          onSubmitted={() => {
            clearPendingQuestions(activeTaskId);
            void load();
          }}
        />
      ) : null}

      <Card>
        <Stack gap={2}>
          <Heading>Thread</Heading>
          {turns.length === 0 ? (
            <Body muted>No messages yet. Say something to the ensemble below.</Body>
          ) : (
            turns.map((turn) => (
              <Stack key={turn.turnId} gap={1}>
                <Body muted>{`${turn.role} · ${turn.at}`}</Body>
                {turn.text !== undefined ? (
                  <Body>{turn.text}</Body>
                ) : turn.interactionId !== undefined ? (
                  <Body muted>Posted structured questions.</Body>
                ) : null}
              </Stack>
            ))
          )}
        </Stack>
      </Card>

      <Card>
        <Stack>
          <TextField
            value={message}
            onChangeText={setMessage}
            placeholder="Message the ensemble"
            autoCapitalize="sentences"
            multiline
          />
          <Row>
            <TouchButton
              label={sending ? 'Sending…' : 'Send'}
              disabled={sending || message.trim().length === 0}
              onPress={() => void send()}
            />
          </Row>
        </Stack>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  spaceBetween: { justifyContent: 'space-between' },
  highlighted: { borderWidth: 2 },
});
