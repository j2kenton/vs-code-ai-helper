import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import React from 'react';
import { Text } from 'react-native';

import { ActivityScreen } from '../screens/ActivityScreen';
import { ChatScreen } from '../screens/ChatScreen';
import { FilesScreen } from '../screens/FilesScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { TasksScreen } from '../screens/TasksScreen';
import { useTheme } from '../theme/ThemeProvider';

export type RootTabParamList = {
  Tasks: undefined;
  Activity: undefined;
  Chat: undefined;
  Files: undefined;
  Settings: undefined;
};

const Tab = createBottomTabNavigator<RootTabParamList>();

const TAB_ICONS: Record<keyof RootTabParamList, string> = {
  Tasks: '☑',
  Activity: '⚡',
  Chat: '💬',
  Files: '📄',
  Settings: '⚙',
};

function tabIcon(route: keyof RootTabParamList) {
  return function TabIcon({ color }: { color: string; focused: boolean; size: number }) {
    return <Text style={{ color, fontSize: 18 }}>{TAB_ICONS[route]}</Text>;
  };
}

export function RootTabs(): React.JSX.Element {
  const theme = useTheme();
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarIcon: tabIcon(route.name as keyof RootTabParamList),
        tabBarActiveTintColor: theme.colors.accent,
        tabBarInactiveTintColor: theme.colors.textMuted,
        tabBarStyle: {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.border,
        },
      })}
    >
      <Tab.Screen name="Tasks" component={TasksScreen} options={{ tabBarButtonTestID: 'tab-tasks' }} />
      <Tab.Screen name="Activity" component={ActivityScreen} options={{ tabBarButtonTestID: 'tab-activity' }} />
      <Tab.Screen name="Chat" component={ChatScreen} options={{ tabBarButtonTestID: 'tab-chat' }} />
      <Tab.Screen name="Files" component={FilesScreen} options={{ tabBarButtonTestID: 'tab-files' }} />
      <Tab.Screen name="Settings" component={SettingsScreen} options={{ tabBarButtonTestID: 'tab-settings' }} />
    </Tab.Navigator>
  );
}
