import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';

import { SiteView } from '@/components/SiteView';

// One site page opened from the More list, with a native header and back
// button. Logging out is the same screen opened with a POST to /logout.
export default function MorePage() {
  const { path, title, method } = useLocalSearchParams<{ path: string; title?: string; method?: string }>();
  const [pageTitle, setPageTitle] = useState(title ?? '');
  const isLogout = path === '/logout';

  const onUrl = useCallback((url: string) => {
    // /logout redirects away once the session is cleared; the other tabs
    // reload on their own (authEpoch), so just go back to the list.
    if (isLogout && !/\/logout\/?$/.test(new URL(url).pathname)) router.back();
  }, [isLogout]);

  return (
    <>
      <Stack.Screen options={{ title: pageTitle }} />
      <SiteView
        path={path ?? '/dashboard'}
        method={method === 'POST' ? 'POST' : undefined}
        onTitle={isLogout ? undefined : setPageTitle}
        onUrl={onUrl}
      />
    </>
  );
}
