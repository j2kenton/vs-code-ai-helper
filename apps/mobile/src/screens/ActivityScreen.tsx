import { useNavigation, type NavigationProp } from '@react-navigation/native';
import React from 'react';
import { StyleSheet } from 'react-native';

import { Body, Card, Heading, Row, Screen, SegmentedControl, Stack, Title, TouchButton } from '../components/primitives';
import { filterFeedByTaskV1, type FeedEntryV1 } from '../events/notificationFeedV1';
import type { RootTabParamList } from '../navigation/RootTabs';
import { useAppStore } from '../state/appStore';

/**
 * Notification stream tab (plan Part 8): the real-time activity feed over
 * the authorized WS channel — agent lifecycle events, gate requests, skipped
 * candidates, indeterminate-attempt re-offers, and errors — with per-task
 * filtering. Gate entries deep-link into the Chat tab's gate detail, which
 * is where approve/deny happens (never inside a notification). On web this
 * feed IS the source of truth; pushes are native-only.
 */

function FeedEntryCard({
  entry,
  onOpenGate,
}: {
  readonly entry: FeedEntryV1;
  readonly onOpenGate: (taskId: string, gateId: string) => void;
}): React.JSX.Element {
  const { taskId, gateId } = entry;
  return (
    <Card>
      <Stack gap={1}>
        <Row style={styles.spaceBetween}>
          <Heading>{entry.title}</Heading>
        </Row>
        {entry.detail !== undefined ? <Body>{entry.detail}</Body> : null}
        <Body muted>{`${entry.at}${taskId !== undefined ? ` · task ${taskId}` : ''}`}</Body>
        {gateId !== undefined && taskId !== undefined ? (
          <Row>
            <TouchButton label="Open gate" variant="secondary" onPress={() => onOpenGate(taskId, gateId)} />
          </Row>
        ) : null}
      </Stack>
    </Card>
  );
}

export function ActivityScreen(): React.JSX.Element {
  const navigation = useNavigation<NavigationProp<RootTabParamList>>();
  const session = useAppStore((s) => s.session);
  const connectionStatus = useAppStore((s) => s.connectionStatus);
  const feedEntries = useAppStore((s) => s.feedEntries);
  const clearFeed = useAppStore((s) => s.clearFeed);
  const activeTaskId = useAppStore((s) => s.activeTaskId);
  const setActiveTaskId = useAppStore((s) => s.setActiveTaskId);
  const setActiveGateId = useAppStore((s) => s.setActiveGateId);

  const [onlyActiveTask, setOnlyActiveTask] = React.useState(false);

  if (session.status !== 'signedIn') {
    return (
      <Screen>
        <Title>Activity</Title>
        <Card>
          <Stack gap={1}>
            <Heading>Sign in to follow activity</Heading>
            <Body muted>
              Agent lifecycle events, gate requests, and alerts stream here in real time once you
              sign in from the Settings tab.
            </Body>
          </Stack>
        </Card>
      </Screen>
    );
  }

  const filterTaskId = onlyActiveTask && activeTaskId !== null ? activeTaskId : null;
  const visible = filterFeedByTaskV1(feedEntries, filterTaskId);

  function openGate(taskId: string, gateId: string): void {
    setActiveTaskId(taskId);
    setActiveGateId(gateId);
    navigation.navigate('Chat');
  }

  return (
    <Screen>
      <Row style={styles.spaceBetween}>
        <Title>Activity</Title>
        <TouchButton label="Clear" variant="secondary" onPress={clearFeed} disabled={feedEntries.length === 0} />
      </Row>
      <Body muted>{`Stream: ${connectionStatus}`}</Body>
      <SegmentedControl
        accessibilityLabel="Feed filter"
        value={filterTaskId === null ? 'all' : 'active'}
        onChange={(next) => setOnlyActiveTask(next === 'active')}
        options={[
          { value: 'all', label: 'All tasks' },
          { value: 'active', label: 'Active task', disabled: activeTaskId === null },
        ]}
      />
      {visible.length === 0 ? (
        <Card>
          <Stack gap={1}>
            <Heading>No activity yet</Heading>
            <Body muted>
              {filterTaskId !== null
                ? 'No events for the active task yet.'
                : 'Events appear here as your agents run: lifecycle updates, gate requests, skipped candidates, re-approval offers, and errors.'}
            </Body>
          </Stack>
        </Card>
      ) : (
        visible.map((entry) => <FeedEntryCard key={entry.id} entry={entry} onOpenGate={openGate} />)
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  spaceBetween: { justifyContent: 'space-between' },
});
