import Constants from 'expo-constants';

type Extra = { siteUrl?: string; supabaseUrl?: string };
const extra = (Constants.expoConfig?.extra ?? {}) as Extra;

export const SITE_URL = (extra.siteUrl ?? 'https://nobossly.com').replace(/\/$/, '');
export const SUPABASE_URL = (extra.supabaseUrl ?? '').replace(/\/$/, '');

// The site looks for this to hide its own header, footer and bottom bar
// (server.js → res.locals.inApp). Keep the "NoBosslyApp/" prefix.
export const APP_USER_AGENT = 'NoBosslyApp/' + (Constants.expoConfig?.version ?? '1.0.0');

export const siteUrl = (path: string) => SITE_URL + (path.startsWith('/') ? path : '/' + path);

export const BRAND = {
  accent: '#10b981',
  dark: '#0d1117',
};
