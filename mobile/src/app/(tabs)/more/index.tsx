import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import type { ComponentProps } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View, useColorScheme } from 'react-native';

import { BRAND } from '@/lib/config';

type IconName = ComponentProps<typeof Ionicons>['name'];
type Item = { title: string; path: string; icon: IconName };

// The rest of the site's tab bar (views/partials/appnav.ejs), then the pages
// the site's header links to, which the app hides.
const SECTIONS: { title: string; items: Item[] }[] = [
  {
    title: 'Your journey',
    items: [
      { title: 'Tasks',       path: '/tasks',    icon: 'checkbox-outline' },
      { title: 'Trophies',    path: '/trophies', icon: 'trophy-outline' },
      { title: 'Budget',      path: '/budget',   icon: 'wallet-outline' },
    ],
  },
  {
    title: 'Community',
    items: [
      { title: 'Feed',        path: '/feed',          icon: 'newspaper-outline' },
      { title: 'Wins wall',   path: '/wins',          icon: 'ribbon-outline' },
      { title: 'Peer review', path: '/reviews',       icon: 'people-outline' },
      { title: 'Messages',    path: '/messages',      icon: 'mail-outline' },
      { title: 'Notifications', path: '/notifications', icon: 'notifications-outline' },
    ],
  },
  {
    title: 'Account',
    items: [
      { title: 'Account settings', path: '/account', icon: 'person-circle-outline' },
      { title: 'Premium',          path: '/pricing', icon: 'star-outline' },
      { title: 'Help',             path: '/help',    icon: 'help-circle-outline' },
    ],
  },
];

export default function More() {
  const dark = useColorScheme() === 'dark';
  const c = dark
    ? { bg: BRAND.dark, card: '#161b27', text: '#e6e9f0', muted: '#8b93a7', line: '#2a3247' }
    : { bg: '#f4f5f7', card: '#fff', text: '#111', muted: '#6b7280', line: '#e5e7eb' };

  const open = (item: Item) => router.push({ pathname: '/more/page', params: { path: item.path, title: item.title } });

  const logOut = () => Alert.alert('Log out of NoBossly?', undefined, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Log out', style: 'destructive',
      onPress: () => router.push({ pathname: '/more/page', params: { path: '/logout', title: 'Logging out', method: 'POST' } }) },
  ]);

  return (
    <ScrollView style={{ backgroundColor: c.bg }} contentContainerStyle={styles.content}>
      {SECTIONS.map(section => (
        <View key={section.title} style={styles.section}>
          <Text style={[styles.heading, { color: c.muted }]}>{section.title.toUpperCase()}</Text>
          <View style={[styles.card, { backgroundColor: c.card, borderColor: c.line }]}>
            {section.items.map((item, i) => (
              <Pressable
                key={item.path}
                onPress={() => open(item)}
                style={({ pressed }) => [styles.row, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line }, pressed && { opacity: 0.6 }]}
                accessibilityRole="link"
              >
                <Ionicons name={item.icon} size={22} color={BRAND.accent} />
                <Text style={[styles.label, { color: c.text }]}>{item.title}</Text>
                <Ionicons name="chevron-forward" size={18} color={c.muted} />
              </Pressable>
            ))}
          </View>
        </View>
      ))}
      <Pressable onPress={logOut} style={({ pressed }) => [styles.card, styles.row, { backgroundColor: c.card, borderColor: c.line }, pressed && { opacity: 0.6 }]} accessibilityRole="button">
        <Ionicons name="log-out-outline" size={22} color="#ef4444" />
        <Text style={[styles.label, { color: '#ef4444' }]}>Log out</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 40 },
  section: { marginBottom: 22 },
  heading: { fontSize: 12, fontWeight: '600', letterSpacing: 0.6, marginBottom: 8, marginLeft: 4 },
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 14 },
  label: { flex: 1, fontSize: 16 },
});
