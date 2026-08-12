/**
 * Theme system for the Ensemble Command Center.
 *
 * Touch-first sizing: every interactive element uses `touchTarget` (44pt, the
 * common minimum across iOS HIG and Android Material guidance) and spacing is
 * on a 4pt grid so layouts stay comfortable on small screens.
 */

export interface ThemeColors {
  background: string;
  surface: string;
  surfaceRaised: string;
  border: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  accent: string;
  accentContrast: string;
  success: string;
  warning: string;
  danger: string;
}

export interface Theme {
  scheme: 'light' | 'dark';
  colors: ThemeColors;
  spacing: (units: number) => number;
  radius: { sm: number; md: number; lg: number };
  touchTarget: number;
  typography: {
    title: { fontSize: number; fontWeight: '700' };
    heading: { fontSize: number; fontWeight: '600' };
    body: { fontSize: number; fontWeight: '400' };
    caption: { fontSize: number; fontWeight: '400' };
    mono: { fontSize: number; fontFamily: string };
  };
}

const SPACING_UNIT = 4;
const spacing = (units: number): number => units * SPACING_UNIT;

const shared = {
  spacing,
  radius: { sm: 6, md: 10, lg: 16 },
  touchTarget: 44,
  typography: {
    title: { fontSize: 24, fontWeight: '700' as const },
    heading: { fontSize: 17, fontWeight: '600' as const },
    body: { fontSize: 15, fontWeight: '400' as const },
    caption: { fontSize: 12, fontWeight: '400' as const },
    mono: { fontSize: 13, fontFamily: 'Menlo' },
  },
};

export const lightTheme: Theme = {
  ...shared,
  scheme: 'light',
  colors: {
    background: '#f6f7f9',
    surface: '#ffffff',
    surfaceRaised: '#ffffff',
    border: '#e1e4e8',
    textPrimary: '#1c1e21',
    textSecondary: '#4b5563',
    textMuted: '#8b929c',
    accent: '#2563eb',
    accentContrast: '#ffffff',
    success: '#15803d',
    warning: '#b45309',
    danger: '#b91c1c',
  },
};

export const darkTheme: Theme = {
  ...shared,
  scheme: 'dark',
  colors: {
    background: '#101216',
    surface: '#181b21',
    surfaceRaised: '#20242c',
    border: '#2c313a',
    textPrimary: '#e8eaed',
    textSecondary: '#aab1bb',
    textMuted: '#6b7280',
    accent: '#60a5fa',
    accentContrast: '#0b1020',
    success: '#4ade80',
    warning: '#fbbf24',
    danger: '#f87171',
  },
};
