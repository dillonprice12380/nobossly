import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Daily task-deadline reminder emails via Resend, called by pg_cron
// (job "daily-task-reminders"). verify_jwt is off because pg_cron has no user
// token, so the caller must send the shared secret kept in
// public.app_secrets (key 'cron_task_reminders') as the x-cron-secret header;
// anything else gets a 401. Idempotent per day: never emails the same member
// twice in one day (checked via email_log).

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

// Task titles and names are member-written: escape them before they go into HTML.
const esc = (s: unknown) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// Constant-time comparison, so the secret cannot be guessed from response times.
function same(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: secretRow } = await admin.from("app_secrets").select("value").eq("key", "cron_task_reminders").maybeSingle();
  if (!secretRow?.value || !same(req.headers.get("x-cron-secret") || "", secretRow.value)) {
    return json({ error: "unauthorized" }, 401);
  }

  const resendKey = Deno.env.get("RESEND_API_KEY");
  if (!resendKey) return json({ error: "RESEND_API_KEY secret not set" }, 500);

  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);

  // Tasks due within 3 days (or overdue), not done
  const { data: tasks, error } = await admin
    .from("tasks")
    .select("id, user_id, title, due_date, status")
    .not("due_date", "is", null)
    .lte("due_date", soon)
    .neq("status", "done")
    .limit(500);
  if (error) return json({ error: error.message }, 500);

  const byUser: Record<string, { title: string; due_date: string }[]> = {};
  (tasks || []).forEach((t) => { (byUser[t.user_id] = byUser[t.user_id] || []).push(t); });

  let sent = 0, skipped = 0;
  for (const [userId, userTasks] of Object.entries(byUser)) {
    // idempotency: one reminder email per member per day
    const { data: already } = await admin.from("email_log").select("id")
      .eq("user_id", userId).eq("email_type", "task_reminder")
      .gte("created_at", today + "T00:00:00Z").limit(1);
    if (already && already.length) { skipped++; continue; }

    const { data: prof } = await admin.from("profiles")
      .select("display_name, notification_emails_enabled, unsubscribed_all").eq("id", userId).maybeSingle();
    if (!prof || prof.unsubscribed_all || prof.notification_emails_enabled === false) { skipped++; continue; }

    const { data: { user } } = await admin.auth.admin.getUserById(userId);
    if (!user?.email) { skipped++; continue; }

    const rows = userTasks.slice(0, 10).map((t) => {
      const late = t.due_date < today;
      return `<tr><td style="padding:6px 12px;border-bottom:1px solid #eee">${esc(t.title)}</td>` +
        `<td style="padding:6px 12px;border-bottom:1px solid #eee;color:${late ? "#d33" : "#555"}">${esc(t.due_date)}${late ? " (overdue)" : ""}</td></tr>`;
    }).join("");
    const hello = prof.display_name ? `Hi ${esc(prof.display_name)},` : "Hi,";
    const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
      <h2 style="color:#0a9d6c">Your upcoming deadlines</h2>
      <p>${hello} these tasks are due soon:</p>
      <table style="width:100%;border-collapse:collapse">${rows}</table>
      <p style="margin-top:16px"><a href="https://nobossly.com/tasks" style="background:#0a9d6c;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Open your tasks</a></p>
      <p style="color:#999;font-size:12px">You can turn these reminders off in your NoBossly account settings.</p></div>`;

    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "NoBossly <reminders@nobossly.com>",
        to: [user.email],
        subject: `${userTasks.length} task${userTasks.length > 1 ? "s" : ""} due soon on NoBossly`,
        html,
      }),
    });
    const rj = await r.json().catch(() => ({}));
    await admin.from("email_log").insert({
      user_id: userId, to_email: user.email, email_type: "task_reminder",
      subject: "Task deadline reminder", resend_id: rj?.id || null,
      status: r.ok ? "sent" : "failed", error_msg: r.ok ? null : JSON.stringify(rj).slice(0, 500),
    });
    if (r.ok) sent++;
  }
  return json({ ok: true, users_emailed: sent, skipped });
});
