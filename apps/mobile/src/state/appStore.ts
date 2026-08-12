import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { KeyRecordDtoV1, SandboxProviderV1 } from '../api/controlPlaneClientV1';
import type { SessionSnapshotV1 } from '../auth/sessionManagerV1';
import type { StructuredQuestionV1 } from '../chat/structuredQuestionsV1';
import { appendFeedEntryV1, type FeedEntryV1 } from '../events/notificationFeedV1';
import { DEFAULT_CONTROL_PLANE_URL_V1 } from '../services/appServicesV1';

export type ThemePreference = 'system' | 'light' | 'dark';

/** Most recently bumped tasks whose chat-stream revision is retained. */
export const CHAT_REVISION_TASK_CAP_V1 = 50;

/** Connection state of the control-plane `/v1/events` WebSocket (Part 8). */
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

/** A structured-question interaction the engine is paused on (Part 9). */
export interface PendingQuestionsV1 {
  readonly interactionId: string;
  readonly questions: readonly StructuredQuestionV1[];
}

export interface AppState {
  themePreference: ThemePreference;
  connectionStatus: ConnectionStatus;
  /** Task id currently focused across tabs (Tasks → Chat/Files deep links). */
  activeTaskId: string | null;
  /** Gate focused by an Activity/push deep link; Chat shows it first. */
  activeGateId: string | null;
  /** Newest-first Part 8 activity feed, capped by the feed model. */
  feedEntries: readonly FeedEntryV1[];
  /** Pending structured-question interaction per task (from the WS stream). */
  pendingQuestionsByTask: Readonly<Record<string, PendingQuestionsV1>>;
  /**
   * Bumped per task when a stream event may have changed its chat
   * transcript or gate list (see chatRefreshV1); an open Chat screen
   * re-fetches when its task's revision changes.
   */
  chatStreamRevisionByTask: Readonly<Record<string, number>>;
  /** Part 6 session state, mirrored from the session manager. */
  session: SessionSnapshotV1;
  /** Control-plane origin the client talks to. */
  controlPlaneUrl: string;
  /** BYOS sandbox provider selection (E2B/Daytona). */
  sandboxProvider: SandboxProviderV1;
  /** Masked key metadata from `/v1/keys` — never key material. */
  keyRecords: readonly KeyRecordDtoV1[];
  /** Local default for model selection surfaced on later engine runs. */
  modelPrimary: string;
  /** Gate policy default: require in-app approval for every gate. */
  gateApprovalRequired: boolean;
  setThemePreference: (preference: ThemePreference) => void;
  setConnectionStatus: (status: ConnectionStatus) => void;
  setActiveTaskId: (taskId: string | null) => void;
  setActiveGateId: (gateId: string | null) => void;
  appendFeedEntry: (entry: FeedEntryV1) => void;
  clearFeed: () => void;
  setPendingQuestions: (taskId: string, pending: PendingQuestionsV1) => void;
  clearPendingQuestions: (taskId: string) => void;
  bumpChatStreamRevision: (taskId: string) => void;
  setSession: (session: SessionSnapshotV1) => void;
  setControlPlaneUrl: (url: string) => void;
  setSandboxProvider: (provider: SandboxProviderV1) => void;
  setKeyRecords: (records: readonly KeyRecordDtoV1[]) => void;
  setModelPrimary: (model: string) => void;
  setGateApprovalRequired: (required: boolean) => void;
}

/**
 * Settings survive a reload; nothing else does.
 *
 * `partialize` is the whole point here. Session snapshots, key records, the
 * feed and connection status are all either secret-adjacent or derived from a
 * live connection, and writing them to disk would either leak or go stale —
 * the session in particular is owned by sessionManagerV1, whose web half
 * deliberately keeps no local copy. Only the four values the user typed or
 * chose are kept.
 *
 * The control-plane URL is the one that made this necessary: without it, every
 * reload pointed the app back at the placeholder host, so restoring the session
 * asked the wrong server and always failed.
 *
 * Storage falls back to an in-memory shim when `localStorage` is absent (React
 * Native), where this simply behaves as it did before — nothing persists —
 * rather than throwing at import time.
 */
type PersistedSettingsV1 = Pick<
  AppState,
  'controlPlaneUrl' | 'sandboxProvider' | 'modelPrimary' | 'gateApprovalRequired' | 'themePreference'
>;

const memoryFallbackV1 = new Map<string, string>();

const settingsStorageV1 = createJSONStorage<PersistedSettingsV1>(() =>
  typeof globalThis.localStorage !== 'undefined'
    ? globalThis.localStorage
    : {
        getItem: (name: string): string | null => memoryFallbackV1.get(name) ?? null,
        setItem: (name: string, value: string): void => void memoryFallbackV1.set(name, value),
        removeItem: (name: string): void => void memoryFallbackV1.delete(name),
      }
);

export const useAppStore = create<AppState>()(
  persist<AppState, [], [], PersistedSettingsV1>(
    (set) => ({
      themePreference: 'system',
      connectionStatus: 'disconnected',
      activeTaskId: null,
      activeGateId: null,
      feedEntries: [],
      pendingQuestionsByTask: {},
      chatStreamRevisionByTask: {},
      session: { status: 'signedOut' },
      controlPlaneUrl: DEFAULT_CONTROL_PLANE_URL_V1,
      sandboxProvider: 'e2b',
      keyRecords: [],
      modelPrimary: 'anthropic:claude-sonnet-5',
      gateApprovalRequired: true,
      setThemePreference: (themePreference) => set({ themePreference }),
      setConnectionStatus: (connectionStatus) => set({ connectionStatus }),
      setActiveTaskId: (activeTaskId) => set({ activeTaskId }),
      setActiveGateId: (activeGateId) => set({ activeGateId }),
      appendFeedEntry: (entry) => set((s) => ({ feedEntries: appendFeedEntryV1(s.feedEntries, entry) })),
      clearFeed: () => set({ feedEntries: [] }),
      setPendingQuestions: (taskId, pending) =>
        set((s) => ({ pendingQuestionsByTask: { ...s.pendingQuestionsByTask, [taskId]: pending } })),
      clearPendingQuestions: (taskId) =>
        set((s) => {
      const next = { ...s.pendingQuestionsByTask };
      delete next[taskId];
      return { pendingQuestionsByTask: next };
        }),
      bumpChatStreamRevision: (taskId) =>
        set((s) => {
      // Housekeeping (same class as the feed cap): re-insert the bumped task
      // last and keep only the most recently bumped entries, so the map
      // cannot grow one key per task ever streamed. A pruned task's revision
      // restarts at 0, which at worst triggers one redundant re-fetch.
      const bumped = (s.chatStreamRevisionByTask[taskId] ?? 0) + 1;
      const others = Object.entries(s.chatStreamRevisionByTask).filter(([id]) => id !== taskId);
      const kept = others.slice(Math.max(0, others.length - (CHAT_REVISION_TASK_CAP_V1 - 1)));
      return { chatStreamRevisionByTask: { ...Object.fromEntries(kept), [taskId]: bumped } };
        }),
      setSession: (session) => set({ session }),
      setControlPlaneUrl: (controlPlaneUrl) => set({ controlPlaneUrl }),
      setSandboxProvider: (sandboxProvider) => set({ sandboxProvider }),
      setKeyRecords: (keyRecords) => set({ keyRecords }),
      setModelPrimary: (modelPrimary) => set({ modelPrimary }),
      setGateApprovalRequired: (gateApprovalRequired) => set({ gateApprovalRequired }),
    }),
    {
      name: 'ensemble.settings.v1',
      storage: settingsStorageV1,
      partialize: (state) => ({
        controlPlaneUrl: state.controlPlaneUrl,
        sandboxProvider: state.sandboxProvider,
        modelPrimary: state.modelPrimary,
        gateApprovalRequired: state.gateApprovalRequired,
        themePreference: state.themePreference,
      }),
    }
  )
);
