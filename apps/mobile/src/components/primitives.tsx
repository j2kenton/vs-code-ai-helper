/**
 * Touch-first layout primitives. All interactive primitives guarantee the
 * theme's minimum touch-target size; layout primitives keep spacing on the
 * theme's 4pt grid so screens compose consistently on phones, tablets, and web.
 */
import React from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useTheme } from '../theme/ThemeProvider';

interface ChildrenProps {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

/** Full-screen scrollable container with safe-area handling and themed background. */
export function Screen({ children, style }: ChildrenProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <SafeAreaView style={[styles.flex, { backgroundColor: theme.colors.background }]} edges={['top', 'left', 'right']}>
      <ScrollView
        style={styles.flex}
        contentContainerStyle={[{ padding: theme.spacing(4), gap: theme.spacing(3) }, style]}
      >
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

/** Vertical stack with grid-aligned gaps. */
export function Stack({ children, style, gap = 3 }: ChildrenProps & { gap?: number }): React.JSX.Element {
  const theme = useTheme();
  return <View style={[{ gap: theme.spacing(gap) }, style]}>{children}</View>;
}

/** Horizontal row, centered vertically, with grid-aligned gaps. */
export function Row({ children, style, gap = 2 }: ChildrenProps & { gap?: number }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={[styles.row, { gap: theme.spacing(gap) }, style]}>{children}</View>
  );
}

/** Raised card surface for list items and detail sections. */
export function Card({ children, style }: ChildrenProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      style={[
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.border,
          borderWidth: StyleSheet.hairlineWidth,
          borderRadius: theme.radius.md,
          padding: theme.spacing(4),
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function Title({ children }: { children: React.ReactNode }): React.JSX.Element {
  const theme = useTheme();
  return <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>{children}</Text>;
}

export function Heading({ children }: { children: React.ReactNode }): React.JSX.Element {
  const theme = useTheme();
  return <Text style={[theme.typography.heading, { color: theme.colors.textPrimary }]}>{children}</Text>;
}

export function Body({ children, muted = false }: { children: React.ReactNode; muted?: boolean }): React.JSX.Element {
  const theme = useTheme();
  return (
    <Text style={[theme.typography.body, { color: muted ? theme.colors.textMuted : theme.colors.textSecondary }]}>
      {children}
    </Text>
  );
}

interface TouchButtonProps {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary';
  disabled?: boolean;
}

/** Button meeting the minimum touch-target height on every platform. */
export function TouchButton({ label, onPress, variant = 'primary', disabled = false }: TouchButtonProps): React.JSX.Element {
  const theme = useTheme();
  const isPrimary = variant === 'primary';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          minHeight: theme.touchTarget,
          borderRadius: theme.radius.sm,
          paddingHorizontal: theme.spacing(4),
          backgroundColor: isPrimary ? theme.colors.accent : theme.colors.surfaceRaised,
          borderColor: theme.colors.border,
          borderWidth: isPrimary ? 0 : StyleSheet.hairlineWidth,
          opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
        },
      ]}
    >
      <Text
        style={[
          theme.typography.heading,
          { color: isPrimary ? theme.colors.accentContrast : theme.colors.textPrimary },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

interface TextFieldProps {
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  /** Masks input for credentials; the value is never echoed elsewhere. */
  secureTextEntry?: boolean;
  autoCapitalize?: 'none' | 'sentences';
  editable?: boolean;
  /** Grows to a comfortable multi-line height (task request text). */
  multiline?: boolean;
}

/** Themed input meeting the minimum touch-target height. */
export function TextField({
  value,
  onChangeText,
  placeholder,
  secureTextEntry = false,
  autoCapitalize = 'none',
  editable = true,
  multiline = false,
}: TextFieldProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={theme.colors.textMuted}
      secureTextEntry={secureTextEntry}
      autoCapitalize={autoCapitalize}
      autoCorrect={false}
      editable={editable}
      multiline={multiline}
      textAlignVertical={multiline ? 'top' : 'center'}
      style={[
        theme.typography.body,
        {
          minHeight: multiline ? theme.touchTarget * 2.5 : theme.touchTarget,
          paddingVertical: multiline ? theme.spacing(2) : 0,
          borderRadius: theme.radius.sm,
          borderColor: theme.colors.border,
          borderWidth: StyleSheet.hairlineWidth,
          backgroundColor: theme.colors.surfaceRaised,
          color: theme.colors.textPrimary,
          paddingHorizontal: theme.spacing(3),
          opacity: editable ? 1 : 0.5,
        },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  button: { alignItems: 'center', justifyContent: 'center' },
});
