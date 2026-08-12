/**
 * A navigation handle usable outside the component tree (the official
 * React Navigation "navigating without the navigation prop" pattern),
 * needed because `EventStreamBinder` and the notification tap listener
 * (plan Part 8) act on gate deep links from outside any screen component —
 * they cannot call the `useNavigation()` hook.
 */
import { createNavigationContainerRef } from '@react-navigation/native';

import type { RootTabParamList } from './RootTabs';

export const navigationRefV1 = createNavigationContainerRef<RootTabParamList>();

/** Opens the Chat tab, where the focused gate (via appStore) renders first. */
export function navigateToGateDetailV1(): void {
  if (navigationRefV1.isReady()) {
    navigationRefV1.navigate('Chat');
  }
}
