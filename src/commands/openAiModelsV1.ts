/**
 * bugs6 items 22 and 3: "Change the model in AI Models" and "Ensemble: Configure AI Models" always end with AI Models
 * visible and the stage's row in view, or say plainly why they could not. The command used to start the view's focus
 * without waiting for it, send `focusStage` to a view that might not exist yet, and return nothing, so a card that
 * said "applying now" could be followed by nothing at all (2026-11-05: AI Models did not open, twice, and the chat said
 * it had).
 */
import type { TaskStage } from "../types/taskProgress";
import { stageGroupLabelV1 } from "../utils/modelStageLabelsV1";

/** What the command returns. `outcome` and `message` follow the decision-card result protocol, so a card that ran it
 * shows `message` under itself when nothing opened, instead of the bare "did not complete". */
export interface OpenAiModelsResultV1 {
  readonly opened: boolean;
  readonly reason?: string;
  readonly outcome: "done" | "refused";
  readonly message?: string;
}

export interface OpenAiModelsDepsV1 {
  /** `vs-code-ai-helper.settingsView.focus`: resolves when VS Code has handled the focus request. */
  readonly focusView: () => Promise<unknown>;
  /** Reveals Ensemble's view container in the side bar (it may be hidden, collapsed or never opened). */
  readonly revealContainer: () => Promise<unknown>;
  /** Whether the AI Models webview has resolved and is visible right now. */
  readonly isVisible: () => boolean;
  /** Whether the AI Models webview has resolved at all in this window. */
  readonly hasResolved: () => boolean;
  /** Sends `focusStage` (queued by the view until its rows exist). */
  readonly focusStage: (stage: TaskStage) => void;
  readonly sleep: (ms: number) => Promise<void>;
}

const POLL_MS_V1 = 100;

async function waitUntilVisibleV1(deps: OpenAiModelsDepsV1, waitMs: number): Promise<boolean> {
  for (let waited = 0; waited <= waitMs; waited += POLL_MS_V1) {
    if (deps.isVisible()) return true;
    await deps.sleep(POLL_MS_V1);
  }
  return deps.isVisible();
}

/** The guidance a refused card carries: another way that works. */
export function describeAiModelsNotShownV1(reason: string, stage: TaskStage | undefined): string {
  const where = stage !== undefined ? ` Its row for ${stageGroupLabelV1(stage)} is in the model chain list there.` : "";
  return (
    `AI Models could not be shown (${reason}). Use "View: Open View…" in the Command Palette and choose "AI Models" ` +
    `(it is in the Ensemble side bar).${where} Once you have changed the model, choose "Retry now".`
  );
}

/**
 * Brings AI Models into view: awaits the focus, checks the view resolved and is visible, and when it is not reveals
 * Ensemble's container, focuses again and waits a bounded time. `focusStage` is sent only once the view is visible.
 */
export async function openAiModelsV1(
  deps: OpenAiModelsDepsV1,
  stage: TaskStage | undefined,
  options: { readonly firstWaitMs?: number; readonly secondWaitMs?: number; readonly focusTimeoutMs?: number } = {}
): Promise<OpenAiModelsResultV1> {
  const firstWaitMs = options.firstWaitMs ?? 1500;
  const secondWaitMs = options.secondWaitMs ?? 4000;
  const focusTimeoutMs = options.focusTimeoutMs ?? 3000;
  const swallow = (): undefined => undefined;
  // A focus request that never settles must not hang the command: it is awaited for a bounded time.
  const awaitBounded = async (request: () => Promise<unknown>): Promise<void> => {
    await Promise.race([Promise.resolve(request()).then(swallow, swallow), deps.sleep(focusTimeoutMs)]);
  };
  await awaitBounded(deps.focusView);
  let visible = await waitUntilVisibleV1(deps, firstWaitMs);
  if (!visible) {
    // Hidden, collapsed, moved or never opened in this window: reveal the container and ask again.
    await awaitBounded(deps.revealContainer);
    await awaitBounded(deps.focusView);
    visible = await waitUntilVisibleV1(deps, secondWaitMs);
  }
  if (!visible) {
    const reason = deps.hasResolved()
      ? "the AI Models section is not visible in this window"
      : "the AI Models section did not load in this window";
    return { opened: false, reason, outcome: "refused", message: describeAiModelsNotShownV1(reason, stage) };
  }
  if (stage !== undefined) {
    deps.focusStage(stage);
  }
  return { opened: true, outcome: "done" };
}
