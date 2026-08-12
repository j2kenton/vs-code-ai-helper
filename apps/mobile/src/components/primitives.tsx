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

interface SegmentedOptionV1<T extends string> {
  readonly value: T;
  readonly label: string;
}

interface SegmentedControlProps<T extends string> {
  readonly options: readonly SegmentedOptionV1<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly accessibilityLabel: string;
}

/**
 * A single choice among a few — provider, theme, mode.
 *
 * Distinct from TouchButton on purpose. Rendered as buttons, a choice group and
 * an action are indistinguishable: pressing "Daytona" and pressing "Save key"
 * looked identical while doing entirely different things, and nothing told you
 * which provider was currently selected except a colour you had to interpret.
 * Here the options share one recessed track, the selected option is the only
 * raised surface in it, and each carries `radio` semantics so the selection is
 * announced rather than inferred from styling.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
}: SegmentedControlProps<T>): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel}
      style={[
        styles.segmentTrack,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.border,
          borderRadius: theme.radius.sm,
          padding: theme.spacing(1),
          gap: theme.spacing(1),
        },
      ]}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            // Both spellings on purpose: `accessibilityState` is what native
            // reads, while react-native-web does not map it to `aria-checked`
            // for role="radio" — it rendered a bare <div role="radio"> with no
            // checked state, so the selection stayed invisible to assistive
            // tech on web (and to any test asserting it).
            accessibilityState={{ checked: selected }}
            aria-checked={selected}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => [
              styles.segmentOption,
              {
                minHeight: theme.touchTarget,
                borderRadius: theme.radius.sm,
                paddingHorizontal: theme.spacing(3),
                backgroundColor: selected ? theme.colors.surfaceRaised : 'transparent',
                borderColor: selected ? theme.colors.accent : 'transparent',
                borderWidth: selected ? StyleSheet.hairlineWidth : 0,
                opacity: pressed ? 0.8 : 1,
              },
            ]}
          >
            <Text
              style={[
                selected ? theme.typography.heading : theme.typography.body,
                { color: selected ? theme.colors.textPrimary : theme.colors.textMuted },
              ]}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
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
  segmentTrack: { flexDirection: 'row', borderWidth: StyleSheet.hairlineWidth },
  segmentOption: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  button: { alignItems: 'center', justifyContent: 'center' },
});
