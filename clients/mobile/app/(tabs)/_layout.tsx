/**
 * (tabs) group layout — the primary authenticated navigation.
 *
 * Six tabs: Chat, Chats, Actions, Calendar, Notes, Profile.
 * The Actions tab shows a live badge count (pending approvals + tasks due today).
 * Calendar (WC5) and Notes (WC10) are the new agenda + notes surfaces.
 * The tab bar is themed from `@weaveintel/tokens` via {@link useTheme}.
 */
import { Tabs } from 'expo-router';
import { useTheme } from '../../src/native/providers';
import { Icon } from '../../src/native/ui/icon';
import { useActions } from '../../src/native/actions/use-actions';

export default function TabsLayout() {
  const { theme } = useTheme();
  const { badgeCount } = useActions();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        // Active = accent (the one sanctioned accent use for tab indication);
        // inactive = secondary text per the monochrome icon rules.
        tabBarActiveTintColor: theme.colors.accent,
        tabBarInactiveTintColor: theme.colors.textSecondary,
        tabBarStyle: {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.surfaceElevated,
        },
        tabBarLabelStyle: { fontFamily: theme.typography.families.body },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: 'Chat', tabBarIcon: ({ color }) => <Icon name="chat" size="lg" color={color} /> }}
      />
      <Tabs.Screen
        name="chats"
        options={{ title: 'Chats', tabBarIcon: ({ color }) => <Icon name="chats" size="lg" color={color} /> }}
      />
      <Tabs.Screen
        name="actions"
        options={{
          title: 'Actions',
          tabBarIcon: ({ color }) => <Icon name="actions" size="lg" color={color} />,
          tabBarBadge: badgeCount > 0 ? badgeCount : undefined,
          tabBarBadgeStyle: {
            backgroundColor: theme.colors.accent,
            color: '#fff',
            fontSize: 10,
            minWidth: 16,
            height: 16,
            lineHeight: 14,
          },
        }}
      />
      <Tabs.Screen
        name="calendar"
        options={{ title: 'Calendar', tabBarIcon: ({ color }) => <Icon name="calendar" size="lg" color={color} /> }}
      />
      <Tabs.Screen
        name="notes"
        options={{ title: 'Notes', tabBarIcon: ({ color }) => <Icon name="notes" size="lg" color={color} /> }}
      />
      <Tabs.Screen
        name="profile"
        options={{ title: 'Profile', tabBarIcon: ({ color }) => <Icon name="profile" size="lg" color={color} /> }}
      />
    </Tabs>
  );
}
