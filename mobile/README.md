# NoBossly mobile app

An Expo (React Native) app for iPhone and Android. The native parts are the tab
bar, splash screen, social sign-in and navigation. Every screen shows a
nobossly.com page, so anything shipped on the website appears in the app
without an app update.

| Tab | Page |
| --- | --- |
| Home | `/dashboard` |
| Quests | `/quests` |
| Community | `/community` |
| Tools | `/tools` |
| More | Native list: Tasks, Trophies, Budget, Feed, Wins, Peer review, Messages, Notifications, Account, Premium, Help, Log out |

## How it fits with the website

- **In-app layout.** The app adds `NoBosslyApp/<version>` to its user agent.
  The server sets `res.locals.inApp` from that and hides the site's header,
  footer and bottom tab bar, because the native tab bar replaces them.
  `/` sends app visitors to `/login`.
- **Social sign-in.** Google blocks OAuth inside web views, so tapping *Continue
  with Google / LinkedIn / GitHub* runs the round trip in the system browser
  sheet. The app creates the PKCE verifier and Supabase returns the code to
  `nobossly://auth/callback`. The web view then opens `/auth/app/finish` on
  the site, which exchanges the code for the session cookies. Email/password
  sign-in simply works in the web view.
- **Links.** nobossly.com and Stripe stay in the app. Stripe has to stay in so
  checkout returns to the signed-in session. Other sites open in an in-app
  browser sheet; `mailto:` and `tel:` go to the phone. The rules are in
  `src/lib/links.ts` and tested in `test/links.test.js`.

## One-time setup

1. **Supabase → Authentication → URL Configuration → Redirect URLs:** add
   `nobossly://**`. Without it, social sign-in in the app returns to the
   website instead of the app. To try sign-in in Expo Go, also add the
   `exp://…/--/auth/callback` URL that Expo prints.
2. **Expo account:** sign up at expo.dev, then run `npx eas-cli@latest login`
   and `npx eas-cli@latest init` in this folder. That writes the project ID
   into `app.json`.
3. **App icons:** replace the placeholder images in `assets/` with the NoBossly
   logo. The files are `icon.png` (1024×1024), `splash-icon.png`, and the three
   `android-icon-*.png` files.

## Run it

```bash
cd mobile
npm install
npx expo start          # scan the QR code with Expo Go, or press a / i
```

Expo Go is enough for everything except social sign-in's return to the app,
which needs the `nobossly://` scheme and therefore a build:

```bash
npx eas-cli@latest build --profile development --platform android   # or ios
```

Builds run in Expo's cloud, so no Mac is needed for iPhone builds. An iPhone
build does need an Apple Developer account ($99/yr); Google Play needs a
developer account ($25 once).

## Checks

```bash
npm run typecheck
npm test
```

## Before submitting to the App Store

Premium is a digital subscription, and Apple's rules for selling those inside
an iOS app differ by region: in-app purchase is the default, while some
regions (including the US) allow linking out to web checkout. The app
currently opens the website's Stripe checkout inside the app. Check Apple's
current App Review Guidelines (3.1) and decide how the iOS app handles
Premium before submitting.
