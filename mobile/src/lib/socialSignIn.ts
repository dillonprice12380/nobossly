// Google refuses OAuth inside embedded web views ("disallowed_useragent"), so
// social sign-in runs in the system browser session (ASWebAuthenticationSession
// on iOS, Custom Tabs on Android). The app holds the PKCE verifier; Supabase
// sends the code back to nobossly://auth/callback; the web view then opens
// /auth/app/finish on the site, which trades code + verifier for the session
// cookies it needs. See src/routes/auth.js on the server.
import * as Crypto from 'expo-crypto';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { SUPABASE_URL, siteUrl } from './config';

const PROVIDERS: Record<string, string> = { google: 'google', linkedin: 'linkedin_oidc', github: 'github' };

const b64url = (b64: string) => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export type SignInResult =
  | { ok: true; finishUrl: string; headers: Record<string, string> }
  | { ok: false; cancelled: boolean; message?: string };

export async function socialSignIn(provider: string): Promise<SignInResult> {
  const supabaseProvider = PROVIDERS[provider];
  if (!supabaseProvider || !SUPABASE_URL) return { ok: false, cancelled: false, message: 'Sign-in is not available.' };

  const verifier = b64url(bytesToBase64(Crypto.getRandomBytes(32)));
  const challenge = b64url(await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256, verifier, { encoding: Crypto.CryptoEncoding.BASE64 }));

  // nobossly://auth/callback in a build; exp://… in Expo Go. Whichever it is
  // must be on Supabase's Redirect URLs list (Authentication → URL Configuration).
  const redirectTo = Linking.createURL('auth/callback');
  const authorize = SUPABASE_URL + '/auth/v1/authorize'
    + '?provider=' + encodeURIComponent(supabaseProvider)
    + '&redirect_to=' + encodeURIComponent(redirectTo)
    + '&code_challenge=' + challenge + '&code_challenge_method=s256';

  const result = await WebBrowser.openAuthSessionAsync(authorize, redirectTo);
  if (result.type !== 'success') return { ok: false, cancelled: true };

  const { queryParams } = Linking.parse(result.url);
  const code = typeof queryParams?.code === 'string' ? queryParams.code : '';
  if (!code) {
    const why = queryParams?.error_description ?? queryParams?.error;
    return { ok: false, cancelled: false, message: typeof why === 'string' ? why : 'Sign-in failed.' };
  }
  return {
    ok: true,
    finishUrl: siteUrl('/auth/app/finish?code=' + encodeURIComponent(code) + '&verifier=' + encodeURIComponent(verifier)),
    // A cross-site page can't set this header, which is what stops another
    // site from signing a visitor in to someone else's account.
    headers: { 'X-NoBossly-App': '1' },
  };
}
