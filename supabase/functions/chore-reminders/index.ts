// supabase/functions/chore-reminders/index.ts
//
// Runs on a schedule (set up separately — see deployment notes) and emails
// each assignee whose chore is due today or overdue. Uses the service role
// key (auto-provided in Edge Function environment) to read across all
// households, since this is a system job, not a per-user request.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL"),
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
);

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
// Resend requires sending from a domain you've verified with them. Until
// you verify your own domain, Resend's sandbox "onboarding@resend.dev"
// sender works for testing but has its own limitations — check Resend's
// dashboard for your current sending status before relying on this.
const FROM_ADDRESS = Deno.env.get("CHORE_EMAIL_FROM") || "onboarding@resend.dev";

Deno.serve(async () => {
  const today = new Date().toISOString().slice(0, 10);

  const { data: dueChores, error } = await supabaseAdmin
    .from("chores")
    .select("id, title, due_date, assigned_to")
    .eq("done", false)
    .lte("due_date", today)
    .not("assigned_to", "is", null);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  if (!dueChores || dueChores.length === 0) {
    return new Response(JSON.stringify({ sent: 0 }), { status: 200 });
  }

  // Look up emails for the assignees. auth.admin.listUsers isn't filterable
  // by id list directly, so we fetch each user by id individually — fine at
  // household scale, would need batching at real scale.
  const results = [];
  for (const chore of dueChores) {
    const { data: userResult, error: userErr } = await supabaseAdmin.auth.admin.getUserById(chore.assigned_to);
    if (userErr || !userResult?.user?.email) continue;

    const email = userResult.user.email;
    const overdue = chore.due_date < today;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: email,
        subject: overdue ? `Overdue: ${chore.title}` : `Due today: ${chore.title}`,
        html: `<p>Your chore "<strong>${chore.title}</strong>" ${overdue ? "was due" : "is due"} on ${chore.due_date}.</p>`,
      }),
    });

    results.push({ chore_id: chore.id, email, ok: res.ok });
  }

  return new Response(JSON.stringify({ sent: results.length, results }), { status: 200 });
});
