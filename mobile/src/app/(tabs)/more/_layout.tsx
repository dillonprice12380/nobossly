import { Stack } from 'expo-router';
import { useColorScheme } from 'react-native';

import { BRAND } from '@/lib/config';

export default function MoreLayout() {
  const dark = useColorScheme() === 'dark';
  return (
    <Stack
      screenOptions={{
        headerTintColor: BRAND.accent,
        headerStyle: dark ? { backgroundColor: BRAND.dark } : undefined,
        headerTitleStyle: dark ? { color: '#e6e9f0' } : undefined,
      }}
    >
      <Stack.Screen name="index" options={{ title: 'More' }} />
      <Stack.Screen name="page" options={{ title: '' }} />
    </Stack>
  );
}
