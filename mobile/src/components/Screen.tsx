import type { ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BRAND } from '@/lib/config';

// Pads the page below the status bar / notch, in the page's own colour.
export function Screen({ children }: { children: ReactNode }) {
  const dark = useColorScheme() === 'dark';
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: dark ? BRAND.dark : '#fff' }} edges={['top']}>
      {children}
    </SafeAreaView>
  );
}
