import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { FEEDS, TOPICS } from "./topics.js";
import { ALERT_GAP_HOURS, alertMessage, articlesFor, audience, collect, isFeed, parseFeed, pickAlerts, sameStory } from "./core.js";

// News for each path, every 30 minutes (pg_cron job "path-news"). Reads each
// publisher feed once (supabase/functions/path-news/topics.js), sorts the
// headlines into each path's topics, stores new ones in public.path_news, and
// sends each member at most one in-app notification a day about the freshest
// story for their path.
// verify_jwt is off because pg_cron has no user token; the caller must send
// the secret in public.app_secrets (key 'cron_path_news') as x-cron-secret.

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

function same(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Why searches failed, for the run's answer (a few examples are enough).
const problems: string[] = [];
const note = (p: string) => { if (problems.length < 5) problems.push(p.slice(0, 200)); };

async function read(url: string): Promise<{ status: number; text: string } | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": "NoBossly news (+https://nobossly.com)", Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" } });
    return { status: r.status, text: await r.text() };
  } catch (e) {
    note("fetch failed: " + String((e as Error)?.message || e));
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Run promises a few at a time.
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

Deno.serve(async (req: Request) => {
  problems.length = 0;
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: secretRow } = await admin.from("app_secrets").select("value").eq("key", "cron_path_news").maybeSingle();
  if (!secretRow?.value || !same(req.headers.get("x-cron-secret") || "", secretRow.value)) return json({ error: "unauthorized" }, 401);

  const now = new Date();
  const feeds = Object.entries(FEEDS) as [string, { name: string; url: string }][];
  let failed = 0;
  const byFeed: Record<string, any[]> = {};
  await pool(feeds, 6, async ([key, f]) => {
    const r = await read(f.url);
    if (!r || !isFeed(r.status, r.text)) {
      failed++;
      note(key + ": " + (r ? "HTTP " + r.status + " " + r.text.replace(/\s+/g, " ").slice(0, 100) : "no answer"));
      return;
    }
    byFeed[key] = parseFeed(r.text, key, f.name);
  });
  const reads = Object.entries(TOPICS).flatMap(([path, topics]) =>
    (topics as any[]).map((topic) => ({ path, topic, articles: articlesFor(topic, byFeed) })));

  // Skip stories already stored in the last few days, even from another outlet.
  const since = new Date(now.getTime() - 3 * 86400000).toISOString();
  const { data: recentRows } = await admin.from("path_news").select("path, title, url").gte("created_at", since).limit(5000);
  const urls = new Set<string>((recentRows || []).map((r: any) => r.path + "|" + r.url));
  const titles = new Map<string, string[]>();
  (recentRows || []).forEach((r: any) => { (titles.get(r.path) || titles.set(r.path, []).get(r.path)!).push(r.title); });
  const rows = collect(reads, now).filter((r: any) => !urls.has(r.path + "|" + r.url) && !(titles.get(r.path) || []).some((t) => sameStory(t, r.title)));

  let stored: any[] = [];
  if (rows.length) {
    const { data, error } = await admin.from("path_news").upsert(rows, { onConflict: "path,url", ignoreDuplicates: true }).select("id, path, topic, label, subpaths, title, published_at");
    if (error) return json({ error: error.message }, 500);
    stored = data || [];
  }

  // At most one news notification per member a day: path news first, then
  // news for everyone.
  let alerted = 0;
  const picks = pickAlerts(stored, now).sort((a: any, b: any) => (a.path === "all" ? 1 : 0) - (b.path === "all" ? 1 : 0));
  if (picks.length) {
    const { data: members } = await admin.from("profiles").select("id, path, subpath, news_alerts, account_status").eq("news_alerts", true).limit(10000);
    const gapStart = new Date(now.getTime() - ALERT_GAP_HOURS * 3600000).toISOString();
    const { data: lately } = await admin.from("notifications").select("user_id").eq("type", "news").gte("created_at", gapStart).limit(10000);
    const recent = new Set<string>((lately || []).map((n: any) => n.user_id));
    for (const row of picks) {
      const to = audience(row, members || [], recent);
      if (!to.length) continue;
      const notes = to.map((m: any) => ({ user_id: m.id, type: "news", entity_type: "path_news", entity_id: row.id, message: alertMessage(row), is_read: false }));
      for (let i = 0; i < notes.length; i += 500) {
        const { error } = await admin.from("notifications").insert(notes.slice(i, i + 500));
        if (error) return json({ error: error.message, stored: stored.length, alerted }, 500);
      }
      to.forEach((m: any) => recent.add(m.id));
      alerted += to.length;
      await admin.from("path_news").update({ alerted_at: now.toISOString() }).eq("id", row.id);
    }
  }

  // Keep a month of news.
  await admin.from("path_news").delete().lt("created_at", new Date(now.getTime() - 30 * 86400000).toISOString());

  return json({ ok: true, feeds: feeds.length, failed, stored: stored.length, alerted, problems });
});
