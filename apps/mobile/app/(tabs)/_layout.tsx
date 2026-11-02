import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { color } from '@/core/theme';

type Icon = React.ComponentProps<typeof Ionicons>['name'];
const icon = (name: Icon, focusedName: Icon) => ({ color: tint, focused, size }: { color: unknown; focused: boolean; size: number }) => <Ionicons name={focused ? focusedName : name} size={size} color={String(tint)} />;

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: color.brand },
        headerTintColor: '#fff',
        headerTitleStyle: { fontWeight: '700' },
        tabBarActiveTintColor: color.brand600,
        tabBarInactiveTintColor: color.subtle,
        tabBarLabelStyle: { fontWeight: '600' },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Today', tabBarIcon: icon('home-outline', 'home') }} />
      <Tabs.Screen name="leads" options={{ title: 'Leads', tabBarIcon: icon('people-outline', 'people') }} />
      <Tabs.Screen name="followups" options={{ title: 'Follow-ups', tabBarIcon: icon('calendar-outline', 'calendar') }} />
      <Tabs.Screen name="more" options={{ title: 'More', tabBarIcon: icon('menu-outline', 'menu') }} />
    </Tabs>
  );
}
