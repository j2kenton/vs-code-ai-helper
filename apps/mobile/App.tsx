import { DarkTheme, DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { StatusBar } from 'expo-status-bar';
import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { navigationRefV1 } from './src/navigation/navigationRefV1';
import { RootTabs } from './src/navigation/RootTabs';
import { EventStreamBinder } from './src/services/eventStreamBinderV1';
import { installE2ETestHooksV1 } from './src/testing/e2eHooksV1';
import { ThemeProvider, useTheme } from './src/theme/ThemeProvider';

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
