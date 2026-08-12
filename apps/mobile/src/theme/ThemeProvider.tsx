import React, { createContext, useContext, useMemo } from 'react';
import { useColorScheme } from 'react-native';

import { darkTheme, lightTheme, type Theme } from './theme';
import { useAppStore } from '../state/appStore';

const ThemeContext = createContext<Theme>(lightTheme);

export function ThemeProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const systemScheme = useColorScheme();
  const preference = useAppStore((s) => s.themePreference);

  const theme = useMemo(() => {
    const scheme = preference === 'system' ? (systemScheme ?? 'light') : preference;
    return scheme === 'dark' ? darkTheme : lightTheme;
  }, [preference, systemScheme]);

  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
