import React from 'react';
import { ScrollView, StyleSheet, Text, View, type GestureResponderEvent } from 'react-native';

import type { FileContentDtoV1, FileEntryDtoV1, TokenSpanDtoV1 } from '../api/controlPlaneClientV1';
import { buildDiffRowsV1, diffFileNamesV1, type DiffRowV1 } from '../files/diffViewModelV1';
import { buildCodeLinesV1, type CodeLineV1 } from '../files/fileViewModelV1';
import { breadcrumbSegmentsV1, childPathV1, parentPathV1, ROOT_PATH_V1 } from '../files/pathBrowserV1';
import { highlightWithShikiV1 } from '../files/shikiHighlightV1';
import { Body, Card, Heading, Row, Screen, Stack, Title, TouchButton } from '../components/primitives';
import { getAppServicesV1 } from '../services/appServicesV1';
import { useAppStore } from '../state/appStore';
import { useTheme } from '../theme/ThemeProvider';
import type { Theme } from '../theme/theme';

/**
 * Read-only file viewer and diff viewer (plan Part 10). No Monaco, no edit
 * pathway anywhere on this screen — browsing, viewing, and diff review only,
 * against the task's SandboxBinding root (the server enforces confinement;
 * navigation here can only compose validated entry names, so escapes are
 * unrepresentable in the UI). Native rendering consumes the server's
 * pre-tokenized spans (shared token-span schema); a file served without
 * spans renders as plain text. Touch affordances: wrap toggle, font zoom
 * via buttons AND a two-finger pinch on the code surface.
 */

type FilesViewState =
  | { readonly mode: 'browse'; readonly path: string }
  | { readonly mode: 'file'; readonly path: string }
  | { readonly mode: 'diff' };

const MIN_FONT_SCALE = 0.6;
const MAX_FONT_SCALE = 2.2;
const LINES_PER_PAGE = 500;

function scopeColor(scope: string | undefined, theme: Theme): string {
  switch (scope) {
    case 'keyword':
    case 'tag':
    case 'heading':
      return theme.colors.accent;
    case 'string':
      return theme.colors.success;
    case 'number':
    case 'literal':
      return theme.colors.warning;
    case 'comment':
      return theme.colors.textMuted;
    case 'property':
      return theme.colors.textPrimary;
    default:
      // Unstyled text and unknown scopes (forward-compatible fallback).
      return theme.colors.textSecondary;
  }
}

function diffRowColor(kind: DiffRowV1['kind'], theme: Theme): string {
  switch (kind) {
    case 'add':
      return theme.colors.success;
    case 'remove':
      return theme.colors.danger;
    case 'hunk':
      return theme.colors.accent;
    case 'file':
      return theme.colors.textPrimary;
    case 'meta':
      return theme.colors.textMuted;
    default:
      return theme.colors.textSecondary;
  }
}

function touchDistance(event: GestureResponderEvent): number | null {
  const touches = event.nativeEvent.touches;
  if (touches.length < 2) {
    return null;
  }
  const [a, b] = [touches[0], touches[1]];
  if (a === undefined || b === undefined) {
    return null;
  }
  return Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
}

/** Two-finger pinch → font-scale updates, on plain responder events. */
function usePinchZoom(
  fontScale: number,
  setFontScale: (next: number) => void
): {
  readonly onTouchStart: (event: GestureResponderEvent) => void;
  readonly onTouchMove: (event: GestureResponderEvent) => void;
  readonly onTouchEnd: () => void;
} {
  const pinchRef = React.useRef<{ distance: number; scale: number } | null>(null);
  return {
    onTouchStart(event: GestureResponderEvent): void {
      const distance = touchDistance(event);
      pinchRef.current = distance === null ? null : { distance, scale: fontScale };
    },
    onTouchMove(event: GestureResponderEvent): void {
      const distance = touchDistance(event);
      const pinch = pinchRef.current;
      if (distance === null || pinch === null || pinch.distance <= 0) {
        return;
      }
      const next = pinch.scale * (distance / pinch.distance);
      setFontScale(Math.min(MAX_FONT_SCALE, Math.max(MIN_FONT_SCALE, next)));
    },
    onTouchEnd(): void {
      pinchRef.current = null;
    },
  };
}

interface CodeViewProps {
  readonly lines: readonly CodeLineV1[];
  readonly wrap: boolean;
  readonly fontScale: number;
  readonly setFontScale: (next: number) => void;
}

interface ViewerControlsProps {
  readonly wrap: boolean;
  readonly setWrap: React.Dispatch<React.SetStateAction<boolean>>;
  readonly setFontScale: React.Dispatch<React.SetStateAction<number>>;
}

/** The shared wrap/zoom control row — one set of affordances for file AND diff views. */
function ViewerControls({ wrap, setWrap, setFontScale }: ViewerControlsProps): React.JSX.Element {
  return (
    <Row>
      <TouchButton
        label={wrap ? 'Wrap: on' : 'Wrap: off'}
        variant="secondary"
        onPress={() => setWrap((current) => !current)}
      />
      <TouchButton
        label="A−"
        variant="secondary"
        onPress={() => setFontScale((s) => Math.max(MIN_FONT_SCALE, s - 0.15))}
      />
      <TouchButton
        label="A+"
        variant="secondary"
        onPress={() => setFontScale((s) => Math.min(MAX_FONT_SCALE, s + 0.15))}
      />
    </Row>
  );
}

interface DiffViewProps {
  readonly rows: readonly DiffRowV1[];
  readonly wrap: boolean;
  readonly fontScale: number;
  readonly setFontScale: (next: number) => void;
}

/** Unified-diff rows with the file viewer's wrap, zoom, and pinch behavior. */
function DiffView({ rows, wrap, fontScale, setFontScale }: DiffViewProps): React.JSX.Element {
  const theme = useTheme();
  const pinch = usePinchZoom(fontScale, setFontScale);
  const fontSize = Math.round(theme.typography.mono.fontSize * fontScale * 10) / 10;
  const lineHeight = Math.round(fontSize * 1.5);

  const body = (
    <View
      onTouchStart={pinch.onTouchStart}
      onTouchMove={pinch.onTouchMove}
      onTouchEnd={pinch.onTouchEnd}
    >
      {rows.map((row) => (
        <Text
          key={row.key}
          numberOfLines={wrap ? undefined : 1}
          style={{
            fontFamily: theme.typography.mono.fontFamily,
            fontSize,
            lineHeight,
            color: diffRowColor(row.kind, theme),
          }}
        >
          {row.text === '' ? ' ' : row.text}
        </Text>
      ))}
    </View>
  );

  return wrap ? body : <ScrollView horizontal>{body}</ScrollView>;
}

function CodeView({ lines, wrap, fontScale, setFontScale }: CodeViewProps): React.JSX.Element {
  const theme = useTheme();
  const [visibleCount, setVisibleCount] = React.useState(LINES_PER_PAGE);
  const pinch = usePinchZoom(fontScale, setFontScale);
  const fontSize = Math.round(theme.typography.mono.fontSize * fontScale * 10) / 10;
  const lineHeight = Math.round(fontSize * 1.5);
  const gutterWidth = String(lines.length).length;
  const visible = lines.slice(0, visibleCount);

  const code = (
    <View
      onTouchStart={pinch.onTouchStart}
      onTouchMove={pinch.onTouchMove}
      onTouchEnd={pinch.onTouchEnd}
    >
      {visible.map((line) => (
        <Text
          key={line.number}
          style={{ fontFamily: theme.typography.mono.fontFamily, fontSize, lineHeight }}
          numberOfLines={wrap ? undefined : 1}
        >
          <Text style={{ color: theme.colors.textMuted }}>
            {`${String(line.number).padStart(gutterWidth, ' ')}  `}
          </Text>
          {line.segments.map((segment, index) => (
            <Text key={index} style={{ color: scopeColor(segment.scope, theme) }}>
              {segment.text}
            </Text>
          ))}
        </Text>
      ))}
    </View>
  );

  return (
    <Stack gap={2}>
      {wrap ? code : <ScrollView horizontal>{code}</ScrollView>}
      {lines.length > visibleCount ? (
        <TouchButton
          label={`Show ${Math.min(LINES_PER_PAGE, lines.length - visibleCount)} more lines (${lines.length - visibleCount} left)`}
          variant="secondary"
          onPress={() => setVisibleCount((count) => count + LINES_PER_PAGE)}
        />
      ) : null}
    </Stack>
  );
}

export function FilesScreen(): React.JSX.Element {
  const session = useAppStore((s) => s.session);
  const controlPlaneUrl = useAppStore((s) => s.controlPlaneUrl);
  const activeTaskId = useAppStore((s) => s.activeTaskId);

  const services = getAppServicesV1(controlPlaneUrl);
  const signedIn = session.status === 'signedIn';

  const [view, setView] = React.useState<FilesViewState>({ mode: 'browse', path: ROOT_PATH_V1 });
  const [entries, setEntries] = React.useState<readonly FileEntryDtoV1[]>([]);
  const [file, setFile] = React.useState<FileContentDtoV1 | null>(null);
  const [diff, setDiff] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [wrap, setWrap] = React.useState(false);
  const [fontScale, setFontScale] = React.useState(1);
  // Web renders with Shiki client-side (plan Part 10); native has no Shiki
  // build and always falls back to the server's spans below.
  const [shikiSpans, setShikiSpans] = React.useState<readonly TokenSpanDtoV1[] | undefined>(undefined);

  const load = React.useCallback(
    async (target: FilesViewState) => {
      if (activeTaskId === null) {
        return;
      }
      setError(null);
      if (target.mode === 'browse') {
        const result = await services.client.listFiles(activeTaskId, target.path);
        if (result.ok) {
          const sorted = [...result.body].sort(
            (a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1)
          );
          setEntries(sorted);
        } else {
          // Typed confinement errors (pathOutsideBindingRoot,
          // symlinkEscapesBindingRoot, ...) surface verbatim.
          setError(`${result.code}: ${result.message}`);
        }
      } else if (target.mode === 'file') {
        setFile(null);
        const result = await services.client.getFile(activeTaskId, target.path);
        if (result.ok) {
          setFile(result.body);
        } else {
          setError(`${result.code}: ${result.message}`);
        }
      } else {
        setDiff(null);
        const result = await services.client.getDiff(activeTaskId);
        if (result.ok) {
          setDiff(result.body.unifiedDiff);
        } else {
          setError(`${result.code}: ${result.message}`);
        }
      }
    },
    [services, activeTaskId]
  );

  React.useEffect(() => {
    setView({ mode: 'browse', path: ROOT_PATH_V1 });
    setEntries([]);
    setFile(null);
    setDiff(null);
    setError(null);
    if (signedIn && activeTaskId !== null) {
      void load({ mode: 'browse', path: ROOT_PATH_V1 });
    }
  }, [signedIn, activeTaskId, load]);

  function navigate(target: FilesViewState): void {
    setView(target);
    void load(target);
  }

  React.useEffect(() => {
    let cancelled = false;
    setShikiSpans(undefined);
    if (file !== null) {
      void highlightWithShikiV1(file.text, file.language).then((spans) => {
        if (!cancelled) {
          setShikiSpans(spans);
        }
      });
    }
    return () => {
      cancelled = true;
    };
  }, [file]);

  if (!signedIn || activeTaskId === null) {
    return (
      <Screen>
        <Title>Files</Title>
        <Card>
          <Stack gap={1}>
            <Heading>{signedIn ? 'No task selected' : 'Sign in to browse files'}</Heading>
            <Body muted>
              {signedIn
                ? 'Open a task from the Tasks tab to browse its sandbox files and review diffs.'
                : 'Sign in from the Settings tab, then pick a task to view its sandbox read-only.'}
            </Body>
          </Stack>
        </Card>
      </Screen>
    );
  }

  const codeLines = file !== null ? buildCodeLinesV1(file.text, shikiSpans ?? file.tokenSpans) : [];
  const diffRows = diff !== null ? buildDiffRowsV1(diff) : [];
  const diffFiles = diffFileNamesV1(diffRows);

  return (
    <Screen>
      <Row style={styles.spaceBetween}>
        <Title>Files</Title>
        <Row>
          {view.mode === 'browse' ? (
            <TouchButton label="Pending diff" variant="secondary" onPress={() => navigate({ mode: 'diff' })} />
          ) : (
            <TouchButton
              label="Back"
              variant="secondary"
              onPress={() =>
                navigate({
                  mode: 'browse',
                  path: view.mode === 'file' ? parentPathV1(view.path) : ROOT_PATH_V1,
                })
              }
            />
          )}
          <TouchButton
            label="Refresh"
            variant="secondary"
            onPress={() => void load(view)}
          />
        </Row>
      </Row>
      <Body muted>
        {view.mode === 'diff'
          ? 'Proposed changes (read-only review before gate approval)'
          : `${breadcrumbSegmentsV1(view.mode === 'browse' ? view.path : parentPathV1(view.path)).join(' › ')} — read-only`}
      </Body>
      {error !== null ? <Body muted>{error}</Body> : null}

      {view.mode === 'browse' ? (
        <Card>
          <Stack gap={2}>
            {view.path !== ROOT_PATH_V1 ? (
              <TouchButton
                label="⬑ Up"
                variant="secondary"
                onPress={() => navigate({ mode: 'browse', path: parentPathV1(view.path) })}
              />
            ) : null}
            {entries.length === 0 ? (
              <Body muted>Empty directory.</Body>
            ) : (
              entries.map((entry) => {
                const target = childPathV1(view.path, entry.name);
                return (
                  <TouchButton
                    key={entry.name}
                    label={entry.kind === 'directory' ? `📁 ${entry.name}` : `📄 ${entry.name}`}
                    variant="secondary"
                    disabled={target === null}
                    onPress={() =>
                      target !== null &&
                      navigate(
                        entry.kind === 'directory'
                          ? { mode: 'browse', path: target }
                          : { mode: 'file', path: target }
                      )
                    }
                  />
                );
              })
            )}
          </Stack>
        </Card>
      ) : null}

      {view.mode === 'file' ? (
        <Card>
          <Stack gap={2}>
            <Row style={styles.spaceBetween}>
              <Heading>{view.path}</Heading>
              {file?.language !== undefined ? <Body muted>{file.language}</Body> : null}
            </Row>
            <ViewerControls wrap={wrap} setWrap={setWrap} setFontScale={setFontScale} />
            {file === null ? (
              <Body muted>Loading…</Body>
            ) : (
              <CodeView lines={codeLines} wrap={wrap} fontScale={fontScale} setFontScale={setFontScale} />
            )}
          </Stack>
        </Card>
      ) : null}

      {view.mode === 'diff' ? (
        <Card>
          <Stack gap={2}>
            {diff === null ? (
              <Body muted>Loading…</Body>
            ) : diffRows.length === 0 ? (
              <Body muted>No pending diff. Diffs appear here when a gate is awaiting review.</Body>
            ) : (
              <>
                <Body muted>{`${diffFiles.length} file(s): ${diffFiles.join(', ')}`}</Body>
                <ViewerControls wrap={wrap} setWrap={setWrap} setFontScale={setFontScale} />
                <DiffView rows={diffRows} wrap={wrap} fontScale={fontScale} setFontScale={setFontScale} />
              </>
            )}
          </Stack>
        </Card>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  spaceBetween: { justifyContent: 'space-between' },
});
