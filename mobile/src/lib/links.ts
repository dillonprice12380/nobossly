// Where a link the web view is about to open should go. Pure so it can be
// tested without a device: see test/links.test.js.

export type LinkAction =
  | { kind: 'load' }                      // let the web view open it
  | { kind: 'social'; provider: string }  // run the native sign-in instead
  | { kind: 'system' }                    // hand to the OS (mail, phone, maps…)
  | { kind: 'browser' };                  // open in the in-app browser sheet

// nobossly.com and the Stripe pages a purchase or card update passes through.
// Checkout returns to nobossly.com/billing/confirm, which needs this web view's
// session cookies, so it has to stay in here rather than in a browser sheet.
const IN_APP_HOSTS = [/^(www\.)?nobossly\.com$/i, /(^|\.)stripe\.com$/i, /(^|\.)stripe\.network$/i];

const SOCIAL = /^\/auth\/oauth\/(google|linkedin|github)\/?$/;

export function classifyLink(url: string, siteUrl: string): LinkAction {
  let u: URL;
  try { u = new URL(url); } catch { return { kind: 'load' }; }

  if (u.protocol === 'about:' || u.protocol === 'data:' || u.protocol === 'blob:') return { kind: 'load' };
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { kind: 'system' };

  const site = new URL(siteUrl);
  const sameSite = u.hostname === site.hostname || u.hostname === 'www.' + site.hostname;
  if (sameSite) {
    const m = SOCIAL.exec(u.pathname);
    return m ? { kind: 'social', provider: m[1] } : { kind: 'load' };
  }
  if (IN_APP_HOSTS.some(re => re.test(u.hostname))) return { kind: 'load' };
  return { kind: 'browser' };
}

// Pages whose visit means "who is signed in may just have changed".
const AUTH_PATHS = /^\/(?:(?:login|signup|logout|forgot|reset|choose-username)(?:\/|$)|auth\/)/;
export const isAuthPath = (url: string): boolean => {
  try { return AUTH_PATHS.test(new URL(url).pathname); } catch { return false; }
};
