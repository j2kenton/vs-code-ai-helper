/**
 * Gate-approval push notifications (plan Part 8), as pure policy plus a
 * driver seam:
 *
 * - pushes are NOTIFICATION + DEEP LINK only — tapping opens the gate detail
 *   in-app where approve/deny happens; no interactive actions live inside
 *   the notification itself (that would need a native notification
 *   extension beyond Expo on iOS);
 * - pushes are NATIVE-ONLY: on web the in-app feed is the source of truth
 *   (Expo web push support is limited), enforced here by the platform gate;
 * - the presenting driver is a seam: `expoPushDriverV1.ts` implements
 *   `PushDriverV1` over `expo-notifications` (permission request, local
 *   presentation, and the tap-response listener that feeds
 *   `parseGateDeepLinkV1`); `createUnavailablePushDriverV1` below stays
 *   available as an explicit no-op for callers that don't want presentation.
 *
 * A gate-approval push fires for `gateRequested` and for
 * `indeterminateAttempt` — the Part 4c re-offer re-enters the gate flow for
 * explicit user re-approval, so it is a gate-approval request too.
 */
import type { WsServerEventV1 } from './wsEventsV1';

export interface GatePushV1 {
  readonly title: string;
  readonly body: string;
  /** Opened on tap; routes to the in-app gate detail. */
  readonly deepLink: string;
}

export function gateDeepLinkV1(taskId: string, gateId: string): string {
  return `ensemble://tasks/${encodeURIComponent(taskId)}/gates/${encodeURIComponent(gateId)}`;
}

const GATE_DEEP_LINK_PATTERN = /^ensemble:\/\/tasks\/([^/]+)\/gates\/([^/]+)$/;

export function parseGateDeepLinkV1(
  url: string
): { readonly taskId: string; readonly gateId: string } | null {
  const match = GATE_DEEP_LINK_PATTERN.exec(url);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return null;
  }
  return { taskId: decodeURIComponent(match[1]), gateId: decodeURIComponent(match[2]) };
}

/** The push payload for a gate-approval event, or `null` for anything else. */
export function gatePushForEventV1(event: WsServerEventV1): GatePushV1 | null {
  if (event.type !== 'notification') {
    return null;
  }
  const { notification } = event;
  if (notification.kind === 'gateRequested') {
    return {
      title: 'Gate approval requested',
      body: notification.summary,
      deepLink: gateDeepLinkV1(notification.taskId, notification.gateId),
    };
  }
  if (notification.kind === 'indeterminateAttempt') {
    return {
      title: 'Attempt needs re-approval',
      body: 'A recovered attempt could not be proven executed; approve or reject it to continue.',
      deepLink: gateDeepLinkV1(notification.taskId, notification.gateId),
    };
  }
  return null;
}

/** Native-only: on web the in-app feed is the source of truth. */
export function isPushPlatformV1(platformOs: string): boolean {
  return platformOs === 'ios' || platformOs === 'android';
}

export interface PushDriverV1 {
  present(push: GatePushV1): Promise<void>;
}

/** An explicit no-op driver: present nothing. */
export function createUnavailablePushDriverV1(): PushDriverV1 {
  return { present: (): Promise<void> => Promise.resolve() };
}

/**
 * Present a push for the event if — and only if — it is a gate-approval
 * event on a push-capable platform. Returns whether one was presented,
 * so the wiring layer and tests observe the policy directly.
 */
export async function presentGatePushV1(
  driver: PushDriverV1,
  platformOs: string,
  event: WsServerEventV1
): Promise<boolean> {
  if (!isPushPlatformV1(platformOs)) {
    return false;
  }
  const push = gatePushForEventV1(event);
  if (push === null) {
    return false;
  }
  await driver.present(push);
  return true;
}
