/**
 * App-root wiring for the Part 8 event stream: one `/v1/events` subscription
 * per signed-in session feeds the whole app — the Activity feed, Chat's
 * pending structured questions, and native gate pushes — regardless of which
 * tab is open. Mounted once in App; renders nothing.
 *
 * The subscription lives exactly as long as a signed-in session against the
 * current control plane: sign-out (including the session manager's
 * fail-closed local sign-out on refresh rejection) stops it, and pointing at
 * a different control plane starts a new one.
 */
import React from 'react';
import { Platform } from 'react-native';

import { chatRefreshTaskIdV1 } from '../events/chatRefreshV1';
import { createEventsClientV1 } from '../events/eventsClientV1';
import { createExpoPushDriverV1, wireGateTapNavigationV1 } from '../events/expoPushDriverV1';
import { feedEntryFromServerEventV1, nextFeedEntryIdV1 } from '../events/notificationFeedV1';
import { presentGatePushV1 } from '../events/pushNotificationsV1';
import { logAppEventV1 } from '../log/appLogV1';
import { navigateToGateDetailV1 } from '../navigation/navigationRefV1';
import { useAppStore } from '../state/appStore';
import { getAppServicesV1 } from './appServicesV1';

// isPushPlatformV1 (checked inside presentGatePushV1) already restricts
// presentation to iOS/Android, so constructing the driver on web is inert.
const pushDriver = createExpoPushDriverV1();

export function EventStreamBinder(): null {
  const sessionStatus = useAppStore((s) => s.session.status);
  const setSession = useAppStore((s) => s.setSession);
  const controlPlaneUrl = useAppStore((s) => s.controlPlaneUrl);
  const setConnectionStatus = useAppStore((s) => s.setConnectionStatus);
  const appendFeedEntry = useAppStore((s) => s.appendFeedEntry);
  const setPendingQuestions = useAppStore((s) => s.setPendingQuestions);
  const bumpChatStreamRevision = useAppStore((s) => s.bumpChatStreamRevision);
  const setActiveTaskId = useAppStore((s) => s.setActiveTaskId);
  const setActiveGateId = useAppStore((s) => s.setActiveGateId);

  const services = getAppServicesV1(controlPlaneUrl);

  React.useEffect(() => services.session.onChange(setSession), [services, setSession]);

  // Tapping a gate push opens the same in-app gate detail the Activity
  // feed's "Open gate" button does — approve/deny only ever happens there.
  React.useEffect(
    () =>
      wireGateTapNavigationV1((taskId, gateId) => {
        setActiveTaskId(taskId);
        setActiveGateId(gateId);
        navigateToGateDetailV1();
      }),
    [setActiveTaskId, setActiveGateId]
  );

  React.useEffect(() => {
    if (sessionStatus !== 'signedIn') {
      setConnectionStatus('disconnected');
      return undefined;
    }
    const client = createEventsClientV1({
      baseUrl: controlPlaneUrl,
      getAccessToken: () => services.session.getAccessToken(),
      getAccessTokenExpiresAt: () => services.session.snapshot().accessTokenExpiresAt,
      onStatus: (status) => {
        logAppEventV1(`events stream: ${status}`);
        setConnectionStatus(status);
      },
      onEvent: (event) => {
        const entry = feedEntryFromServerEventV1(event, new Date().toISOString(), nextFeedEntryIdV1());
        if (entry !== null) {
          appendFeedEntry(entry);
        }
        if (event.type === 'structuredQuestions') {
          setPendingQuestions(event.taskId, {
            interactionId: event.interactionId,
            questions: event.questions,
          });
        }
        const chatTaskId = chatRefreshTaskIdV1(event);
        if (chatTaskId !== null) {
          // An open Chat screen for this task re-fetches turns/gates.
          bumpChatStreamRevision(chatTaskId);
        }
        void presentGatePushV1(pushDriver, Platform.OS, event);
      },
    });
    client.start();
    return (): void => client.stop();
  }, [
    sessionStatus,
    controlPlaneUrl,
    services,
    setConnectionStatus,
    appendFeedEntry,
    setPendingQuestions,
    bumpChatStreamRevision,
  ]);

  return null;
}
