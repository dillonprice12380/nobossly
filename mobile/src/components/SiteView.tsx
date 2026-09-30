import { useFocusEffect } from 'expo-router';
import * as Linking from 'expo-linking';
import * as SplashScreen from 'expo-splash-screen';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, BackHandler, Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { WebView, type WebViewNavigation } from 'react-native-webview';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';

import { bumpAuthEpoch, currentAuthEpoch, onAuthEpoch } from '@/lib/authEpoch';
import { APP_USER_AGENT, BRAND, siteUrl } from '@/lib/config';
import { classifyLink, isAuthPath } from '@/lib/links';
import { socialSignIn } from '@/lib/socialSignIn';
import { onTabReselect } from '@/lib/tabEvents';

type Source = { uri: string; headers?: Record<string, string>; method?: 'GET' | 'POST'; body?: string };

type Props = {
  /** The page this view starts on and returns to, e.g. "/dashboard". */
  path: string;
  /** Tab name, so re-tapping the tab can send this view home. */
  tab?: string;
  /** Open the start page with a POST (used for /logout). */
  method?: 'POST';
  /** Called when a page finishes loading, with its title. */
  onTitle?: (title: string) => void;
  /** Called for every top-level URL the view lands on. */
  onUrl?: (url: string) => void;
};

let splashHidden = false;
const hideSplash = () => {
  if (splashHidden) return;
  splashHidden = true;
  SplashScreen.hideAsync().catch(() => {});
};

export function SiteView({ path, tab, method, onTitle, onUrl }: Props) {
  const home = siteUrl(path);
  const webRef = useRef<WebView>(null);
  const [source, setSource] = useState<Source>(method === 'POST' ? { uri: home, method: 'POST', body: '' } : { uri: home });
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const canGoBack = useRef(false);
  const lastUrl = useRef(home);
  const loadedEpoch = useRef(currentAuthEpoch());
  const focused = useRef(false);
  const dark = useColorScheme() === 'dark';

  const goHome = useCallback(() => {
    setFailed(false);
    loadedEpoch.current = currentAuthEpoch();
    // Same URI twice is not a change React would act on, so navigate from
    // inside the page instead of swapping the source.
    webRef.current?.injectJavaScript(`window.location.href = ${JSON.stringify(home)}; true;`);
  }, [home]);

  // Re-tapping the active tab: back to this tab's home page.
  useEffect(() => (tab ? onTabReselect(tab, goHome) : undefined), [tab, goHome]);

  // Signed in or out somewhere else while this tab was on screen.
  useEffect(() => onAuthEpoch(e => {
    if (focused.current && e !== loadedEpoch.current) goHome();
  }), [goHome]);

  useFocusEffect(useCallback(() => {
    focused.current = true;
    if (loadedEpoch.current !== currentAuthEpoch()) goHome();

    // Android back button walks the web view's history before leaving the tab.
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!canGoBack.current) return false;
      webRef.current?.goBack();
      return true;
    });
    return () => { focused.current = false; sub.remove(); };
  }, [goHome]));

  const runSocialSignIn = useCallback(async (provider: string) => {
    setBusy(true);
    try {
      const r = await socialSignIn(provider);
      if (r.ok) {
        setSource({ uri: r.finishUrl, headers: r.headers });
      } else if (!r.cancelled) {
        Alert.alert('Sign-in failed', r.message ?? 'Please try again.');
      }
    } finally {
      setBusy(false);
    }
  }, []);

  const route = useCallback((url: string): boolean => {
    const action = classifyLink(url, siteUrl('/'));
    switch (action.kind) {
      case 'load': return true;
      case 'social': runSocialSignIn(action.provider); return false;
      case 'system': Linking.openURL(url).catch(() => {}); return false;
      case 'browser': WebBrowser.openBrowserAsync(url).catch(() => {}); return false;
    }
  }, [runSocialSignIn]);

  const onShouldStart = useCallback((req: ShouldStartLoadRequest) => {
    // iframes (Stripe's card fields, embeds) load freely; only whole-page
    // navigations are routed.
    if (req.isTopFrame === false) return true;
    return route(req.url);
  }, [route]);

  const onNav = useCallback((nav: WebViewNavigation) => {
    canGoBack.current = nav.canGoBack;
    if (nav.loading) return;
    // Leaving a login/logout/sign-up page means the account may have changed:
    // tell the other tabs, but don't make this one reload itself.
    if (isAuthPath(lastUrl.current) && !isAuthPath(nav.url)) {
      bumpAuthEpoch();
      loadedEpoch.current = currentAuthEpoch();
    }
    lastUrl.current = nav.url;
    onUrl?.(nav.url);
    if (nav.title && onTitle) onTitle(nav.title.replace(/\s*·\s*NoBossly$/, ''));
  }, [onTitle, onUrl]);

  if (failed) {
    return (
      <View style={[styles.center, { backgroundColor: dark ? BRAND.dark : '#fff' }]}>
        <Text style={[styles.title, { color: dark ? '#e6e9f0' : '#111' }]}>You're offline</Text>
        <Text style={styles.muted}>NoBossly couldn't be reached. Check your connection and try again.</Text>
        <Pressable style={styles.button} onPress={() => { setFailed(false); webRef.current?.reload(); }}>
          <Text style={styles.buttonText}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: dark ? BRAND.dark : '#fff' }}>
      <WebView
        ref={webRef}
        source={source}
        applicationNameForUserAgent={APP_USER_AGENT}
        onShouldStartLoadWithRequest={onShouldStart}
        onNavigationStateChange={onNav}
        onOpenWindow={e => { if (route(e.nativeEvent.targetUrl)) setSource({ uri: e.nativeEvent.targetUrl }); }}
        onLoadEnd={hideSplash}
        onError={() => { hideSplash(); setFailed(true); }}
        onContentProcessDidTerminate={() => webRef.current?.reload()}
        onRenderProcessGone={() => webRef.current?.reload()}
        startInLoadingState
        renderLoading={() => <Loading dark={dark} />}
        pullToRefreshEnabled
        allowsBackForwardNavigationGestures
        allowsInlineMediaPlayback
        decelerationRate="normal"
        setSupportMultipleWindows
        style={{ flex: 1, backgroundColor: 'transparent' }}
      />
      {busy && <Loading dark={dark} overlay />}
    </View>
  );
}

function Loading({ dark, overlay }: { dark: boolean; overlay?: boolean }) {
  return (
    <View style={[StyleSheet.absoluteFill, styles.center, overlay && { backgroundColor: dark ? '#0d1117cc' : '#ffffffcc' }]}>
      <ActivityIndicator size="large" color={BRAND.accent} />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  title: { fontSize: 20, fontWeight: '700', marginBottom: 8 },
  muted: { fontSize: 15, color: '#8b93a7', textAlign: 'center', marginBottom: 20, maxWidth: 320 },
  button: { backgroundColor: BRAND.accent, paddingHorizontal: 22, paddingVertical: 12, borderRadius: 10 },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
});

