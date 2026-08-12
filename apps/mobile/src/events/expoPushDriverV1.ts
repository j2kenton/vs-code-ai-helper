/**
 * The `expo-notifications` push driver (plan Part 8): presents a gate-
 * approval push as a LOCAL notification the instant the live WS stream
 * delivers the triggering event — `presentGatePushV1` already restricts
 * calls here to native platforms and gate-approval event kinds, so this
 * driver only has to request permission (once per process; a denial simply
 * means nothing is ever presented) and hand the OS a notification carrying
 * the deep link in `data`, never in an interactive action (Expo has no
 * native notification-action extension on iOS).
 *
 * `wireGateTapNavigationV1` is the tap side: it decodes the deep link from
 * a tapped notification and hands (taskId, gateId) to the caller, which
 * opens the in-app gate detail exactly like the Activity feed's "Open gate"
 * button does — approve/deny always happens in-app, never in the
 * notification itself.
 */
import * as Notifications from 'expo-notifications';

import { parseGateDeepLinkV1, type PushDriverV1 } from './pushNotificationsV1';

Notifications.setNotificationHandler({
  handleNotification: () =>
    Promise.resolve({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
});

let permissionRequested = false;

/** Best-effort, once per process: a denied prompt never presents anything. */
async function ensurePermissionV1(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) {
    return true;
  }
  if (permissionRequested) {
    return false;
  }
  permissionRequested = true;
  const requested = await Notifications.requestPermissionsAsync();
  return requested.granted;
}

export function createExpoPushDriverV1(): PushDriverV1 {
  return {
    async present(push): Promise<void> {
      const granted = await ensurePermissionV1();
      if (!granted) {
        return;
      }
      await Notifications.scheduleNotificationAsync({
        content: { title: push.title, body: push.body, data: { deepLink: push.deepLink } },
        trigger: null,
      });
    },
  };
}

export function wireGateTapNavigationV1(onOpenGate: (taskId: string, gateId: string) => void): () => void {
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    const deepLink = response.notification.request.content.data.deepLink;
    if (typeof deepLink !== 'string') {
      return;
    }
    const parsed = parseGateDeepLinkV1(deepLink);
    if (parsed !== null) {
      onOpenGate(parsed.taskId, parsed.gateId);
    }
  });
  return () => subscription.remove();
}
