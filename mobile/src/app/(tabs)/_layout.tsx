import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router';
import type { ComponentProps } from 'react';
import { useColorScheme } from 'react-native';

import { BRAND } from '@/lib/config';
import { emitTabReselect } from '@/lib/tabEvents';

type IconName = ComponentProps<typeof Ionicons>['name'];

// The first four sections of the site's own tab bar (views/partials/appnav.ejs);
// everything else lives under More.
const TABS: { name: string; title: string; icon: IconName; iconActive: IconName }[] = [
  { name: 'index',     title: 'Home',      icon: 'home-outline',     iconActive: 'home' },
  { name: 'quests',    title: 'Quests',    icon: 'flag-outline',     iconActive: 'flag' },
  { name: 'community', title: 'Community', icon: 'chatbubbles-outline', iconActive: 'chatbubbles' },
  { name: 'tools',     title: 'Tools',     icon: 'construct-outline', iconActive: 'construct' },
  { name: 'more',      title: 'More',      icon: 'menu-outline',     iconActive: 'menu' },
];

export default function TabLayout() {
  const dark = useColorScheme() === 'dark';
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: BRAND.accent,
        tabBarStyle: dark ? { backgroundColor: BRAND.dark, borderTopColor: '#2a3247' } : undefined,
      }}
    >
      {TABS.map(t => (
        <Tabs.Screen
          key={t.name}
          name={t.name}
          options={{
            title: t.title,
            tabBarIcon: ({ color, size, focused }) => (
              <Ionicons name={focused ? t.iconActive : t.icon} size={size} color={color} />
            ),
          }}
          listeners={({ navigation }) => ({
            tabPress: () => {
              // Already on this tab: send it back to its home page.
              if (navigation.isFocused()) emitTabReselect(t.name);
            },
          })}
        />
      ))}
    </Tabs>
  );
}
