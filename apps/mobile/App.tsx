import { DarkTheme, DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { StatusBar } from 'expo-status-bar';
import * as WebBrowser from 'expo-web-browser';
import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { navigationRefV1 } from './src/navigation/navigationRefV1';
import { RootTabs } from './src/navigation/RootTabs';
import { EventStreamBinder } from './src/services/eventStreamBinderV1';
import { installE2ETestHooksV1 } from './src/testing/e2eHooksV1';
import { ThemeProvider, useTheme } from './src/theme/ThemeProvider';

// Closes the OAuth loop on web, and must run at module scope — before any
// component renders — because the window this executes in may BE the redirect
// target rather than the app the user is using.
//
// On web the provider redirects to `${origin}/auth/callback`, and the dev
// server answers every path with the SPA. So the popup opened for sign-in
// comes back holding a complete, freshly-booted, signed-out copy of the app.
// maybeCompleteAuthSession detects that this window was opened by an auth
// request, posts the authorization result back to the opener, and closes
// itself. Without it the popup simply renders the app again, the original
// window learns nothing, and pressing "sign in" in the popup opens another
// popup — an endless chain of windows that never signs anyone in. Observed
// exactly that way before this call existed.
//
// Harmless on native, where the redirect is handled by the custom scheme.
WebBrowser.maybeCompleteAuthSession();

// No-op unless EXPO_PUBLIC_E2E_TEST_HOOKS=1 (Playwright's dev-server only).
installE2ETestHooksV1();

function ThemedNavigation(): React.JSX.Element {
  const theme = useTheme();
  const base = theme.scheme === 'dark' ? DarkTheme : DefaultTheme;
  const navigationTheme = {
    ...base,
    colors: {
      ...base.colors,
      primary: theme.colors.accent,
      background: theme.colors.background,
      card: theme.colors.surface,
      text: theme.colors.textPrimary,
      border: theme.colors.border,
    },
  };
  return (
    <NavigationContainer ref={navigationRefV1} theme={navigationTheme}>
      <StatusBar style={theme.scheme === 'dark' ? 'light' : 'dark'} />
      <RootTabs />
    </NavigationContainer>
  );
}

export default function App(): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <EventStreamBinder />
        <ThemedNavigation />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
