// Callosium on-account-created side-effect: the welcome email a real user gets
// when they create an account IN THE APP (Google / GitHub / email+password),
// as opposed to the landing-page waitlist welcome (that one is on-signup).
//
// Fired by an AFTER INSERT OR UPDATE OF email_confirmed_at trigger on
// auth.users (via pg_net), so it lands exactly when the account becomes
// confirmed: OAuth users on insert (provider-verified), email/password users
// when they click the confirm link. The DB trigger is exception-wrapped so a
// mail hiccup can NEVER roll back account creation.
//
// Auth: called server-to-server by the trigger with an x-signup-secret header
// (SIGNUP_HOOK_SECRET in Vault, the same secret the waitlist hook uses). No
// browser/CORS path.
//
// Two independent side-effects, each with its own idempotency marker so a
// failure in one is never masked by the other and stays re-attemptable:
//   1. profiles.welcomed_at   — the transactional welcome email (retried on
//      429/5xx/network; a Resend Idempotency-Key makes retries dedupe-safe).
//      Stamped IMMEDIATELY on a confirmed send, before any slow best-effort work.
//   2. profiles.contact_synced_at — the marketing-list sync (create Resend
//      contact + add to the "Users" segment). Best-effort, retried, and stamped
//      ONLY on success, so a transient failure leaves the row queryable
//      (welcomed_at set, contact_synced_at null) for a re-fire or a backfill.
// The early-return guard fires only when BOTH are done, so a re-invocation
// completes whichever half is still outstanding without re-sending the email.
//
// The welcome is a TRANSACTIONAL email (you made an account); the Users-segment
// membership is what carries the unsubscribe, so the email itself has none.
//
// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const FROM = 'Abdo from Callosium <abdo@callosium.com>';
const REPLY_TO = 'abdo@callosium.com';
const SUBJECT = "You're set. Every AI you use now shares one memory";
// Real registered users land in the "Users" Resend segment (distinct from the
// pre-launch "Waitlist" segment) so product/marketing broadcasts can target
// actual customers. Contacts are unsubscribe-able; broadcasts carry the unsub
// link automatically — this is a marketing list, not transactional.
const SEGMENT_USERS = 'b0d57586-d01b-4c3a-9738-cdba0d625853';

function firstName(name: string | null): string {
  if (!name) return 'there';
  const n = name.trim().split(/\s+/)[0];
  return n && n.length <= 40 ? n : 'there';
}

// The name is user-controlled (raw_user_meta_data.full_name at email/password
// signup). It is only ever mailed back to that same user, but it is still
// interpolated into HTML, so escape it — a stray `<`/`&` must not break layout
// or become markup. The plain-text branch needs no escaping.
function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function welcomeText(name: string | null): string {
  return [
    `Hey ${firstName(name)}, it's Abdo.`, '',
    'Your Callosium account is set up. Thank you for installing it, genuinely.',
    '',
    "Here's what you just switched on: every AI you connect now reads from and writes to one shared memory, and that memory is a folder of plain files on your own computer. Teach one AI something and the next one already knows it. Nothing leaves your machine.",
    '',
    'WHAT TO DO NEXT',
    '1. In the Callosium dashboard (already running on your computer), open Agents and connect your first AI. Claude, Cursor, ChatGPT-compatible apps, 23 clients supported.',
    '2. Ask it something you have told an AI before. Watch it recall the answer with the exact source cited.',
    "3. That's it. It gets a little smarter every time you or your AI writes to it.",
    '',
    'The core is free, forever. If anything is confusing or broken, just hit reply. It comes straight to me and I read every one.',
    '', '- Abdo', '',
    'Callosium. One brain, every AI, your files.',
  ].join('\n');
}

function welcomeHtml(name: string | null): string {
  const hi = htmlEscape(firstName(name));
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>Callosium</title>
</head>
<body style="margin:0; padding:0; background-color:#EFEDEA;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#EFEDEA" style="background-color:#EFEDEA;">
<tr><td align="center" style="padding-top:24px; padding-bottom:24px; padding-left:12px; padding-right:12px;">
<table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; width:100%;">
  <tr>
    <td bgcolor="#07060B" style="background-color:#07060B; padding-top:28px; padding-bottom:28px; padding-left:32px; padding-right:32px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="font-family:'Courier New', Courier, monospace; font-size:22px; line-height:26px; color:#EFEDF2; letter-spacing:6px; font-weight:bold;">CALLOSIUM<span style="color:#FF2E88;">_</span></td></tr>
        <tr><td style="padding-top:8px; font-family:'Courier New', Courier, monospace; font-size:11px; line-height:16px; color:#9A93A8; letter-spacing:2px;">ONE BRAIN &#183; EVERY AI &#183; YOUR FILES</td></tr>
      </table>
    </td>
  </tr>
  <tr><td bgcolor="#FF2E88" style="background-color:#FF2E88; font-size:0; line-height:0; height:3px;">&nbsp;</td></tr>
  <tr>
    <td bgcolor="#FFFFFF" style="background-color:#FFFFFF; padding-top:32px; padding-bottom:32px; padding-left:32px; padding-right:32px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="font-family:Georgia, 'Times New Roman', serif; font-size:16px; line-height:26px; color:#1A1721;">
          <p style="margin:0 0 16px 0;">Hey ${hi}, it's Abdo.</p>
          <p style="margin:0 0 16px 0;">Your Callosium account is set up. Thank you for installing it, genuinely.</p>
          <p style="margin:0 0 16px 0;">Here's what you just switched on: <strong>every AI you connect now reads from and writes to one shared memory</strong>, and that memory is a folder of plain files on your own computer. Teach one AI something and the next one already knows it. Nothing leaves your machine.</p>
        </td></tr>
        <tr><td style="padding-top:4px; padding-bottom:20px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td bgcolor="#F5F2FA" style="background-color:#F5F2FA; border-left:3px solid #FF2E88; padding-top:16px; padding-bottom:16px; padding-left:20px; padding-right:20px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr><td style="font-family:'Courier New', Courier, monospace; font-size:12px; line-height:18px; color:#544E64; letter-spacing:1px;">WHAT TO DO NEXT</td></tr>
                <tr><td style="padding-top:8px; font-family:Georgia, 'Times New Roman', serif; font-size:15px; line-height:24px; color:#1A1721;"><strong>1.</strong> In the Callosium dashboard (already running on your computer), open <strong>Agents</strong> and connect your first AI: Claude, Cursor, ChatGPT-compatible apps, 23 clients supported.<br><br><strong>2.</strong> Ask it something you have told an AI before. Watch it recall the answer with the exact source cited.<br><br><strong>3.</strong> That's it. It gets a little smarter every time you or your AI writes to it.</td></tr>
              </table>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="font-family:Georgia, 'Times New Roman', serif; font-size:16px; line-height:26px; color:#1A1721;">
          <p style="margin:0 0 16px 0;">The core is <strong>free, forever</strong>. If anything is confusing or broken, just hit reply. It comes straight to me and I read every one.</p>
          <p style="margin:0 0 4px 0;">Abdo</p>
        </td></tr>
      </table>
    </td>
  </tr>
  <tr>
    <td bgcolor="#EFEDEA" style="background-color:#EFEDEA; padding-top:20px; padding-bottom:8px; padding-left:32px; padding-right:32px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td align="center" style="font-family:Arial, Helvetica, sans-serif; font-size:11px; line-height:17px; color:#9A93A8;">You're getting this because you created a Callosium account. Questions? Just reply, it reaches Abdo directly.</td></tr>
      </table>
    </td>
  </tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

async function vaultVal(supabase: any, rpc: string): Promise<string | null> {
  const { data, error } = await supabase.rpc(rpc);
  if (error || !data) { console.error(`${rpc} failed:`, error?.message ?? 'empty'); return null; }
  return data as string;
}

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// POST with retry on the transient failures Resend actually returns: 429 (the
// ~2 req/s account limit — real on a launch-day burst), any 5xx, and network
// errors. 409 (already exists) is success. Caps at 5 attempts and ~3s backoff so
// a single invocation can't run away. Used for BOTH the welcome email (whose
// Idempotency-Key makes retries dedupe-safe) and the contact/segment sync.
async function retryPost(url: string, headers: Record<string, string>, body?: unknown, maxAttempts = 5): Promise<{ ok: boolean; status: number; txt?: string }> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
      if (res.ok || res.status === 409) return { ok: true, status: res.status };
      const retryable = res.status === 429 || res.status >= 500;
      const txt = (await res.text()).slice(0, 200);
      if (retryable && attempt < maxAttempts) {
        const ra = Number(res.headers.get('retry-after')) || 0;
        await new Promise((r) => setTimeout(r, ra > 0 ? Math.min(ra * 1000, 3000) : Math.min(500 * attempt, 3000)));
        continue;
      }
      return { ok: false, status: res.status, txt };
    } catch (e) {
      if (attempt < maxAttempts) { await new Promise((r) => setTimeout(r, Math.min(500 * attempt, 3000))); continue; }
      return { ok: false, status: 0, txt: (e as Error)?.message };
    }
  }
  return { ok: false, status: 429, txt: 'retries' };
}

async function sendWelcome(key: string, userId: string, email: string, name: string | null): Promise<boolean> {
  const res = await retryPost('https://api.resend.com/emails',
    { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Idempotency-Key': `account-welcome-${userId}` },
    { from: FROM, to: [email], reply_to: REPLY_TO, subject: SUBJECT, html: welcomeHtml(name), text: welcomeText(name) });
  if (!res.ok) console.error('account welcome failed:', res.status, res.txt);
  return res.ok;
}

// Create the Resend contact (properties live here), THEN attach it to the Users
// segment via the SEPARATE segment endpoint. Resend SILENTLY IGNORES segment_ids
// on POST /contacts, so membership MUST be set with
// POST /contacts/{email}/segments/{id}. Returns true only if BOTH succeeded, so
// the caller stamps contact_synced_at only on a real, complete sync.
async function createContact(supabase: any, email: string, provider: string): Promise<boolean> {
  const key = await vaultVal(supabase, 'get_resend_contacts_key');
  if (!key) { console.error('contact sync: no contacts key'); return false; }
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const create = await retryPost('https://api.resend.com/contacts', headers, { email, properties: { type: 'registered', provider: provider || 'email' } });
  if (!create.ok) { console.error(`contact create failed: ${create.status} ${create.txt}`); return false; }
  const seg = await retryPost(`https://api.resend.com/contacts/${encodeURIComponent(email)}/segments/${SEGMENT_USERS}`, headers);
  if (!seg.ok) { console.error(`segment add failed: ${seg.status} ${seg.txt}`); return false; }
  return true;
}

const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) return new Response('not configured', { status: 500 });
  const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

  // Verify the shared secret from the DB trigger.
  const provided = req.headers.get('x-signup-secret') ?? '';
  const expected = await vaultVal(supabase, 'get_signup_secret');
  if (!expected || !timingSafeEq(provided, expected)) return new Response('forbidden', { status: 403 });

  let body: any; try { body = await req.json(); } catch { return new Response('bad json', { status: 400 }); }
  const userId = typeof body?.user_id === 'string' ? body.user_id : '';
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : null;
  const provider = typeof body?.provider === 'string' ? body.provider : 'email';
  if (!userId || !email || !email.includes('@')) return new Response('bad input', { status: 400 });

  // Each side-effect has its own marker; only skip entirely when BOTH are done.
  const { data: prof } = await supabase.from('profiles').select('welcomed_at, contact_synced_at').eq('id', userId).maybeSingle();
  if (!prof) return jsonRes({ ok: true, skipped: 'no-profile' });
  const alreadyWelcomed = !!prof.welcomed_at;
  const alreadySynced = !!prof.contact_synced_at;
  if (alreadyWelcomed && alreadySynced) return jsonRes({ ok: true, skipped: 'already' });

  // 1) Transactional welcome — send (retried) then stamp immediately, before the
  //    slow best-effort sync, so the dedup marker is set the instant it's earned.
  if (!alreadyWelcomed) {
    const key = Deno.env.get('RESEND_API_KEY') ?? await vaultVal(supabase, 'get_resend_key');
    if (!key) return new Response('no mail key', { status: 500 });
    const sent = await sendWelcome(key, userId, email, name);
    if (!sent) return new Response('mail failed', { status: 502 }); // welcomed_at stays null → re-attemptable
    const { error: upErr } = await supabase.from('profiles').update({ welcomed_at: new Date().toISOString() }).eq('id', userId);
    if (upErr) console.error('welcomed_at stamp failed:', upErr.message);
  }

  // 2) Marketing-list sync — best-effort, stamped ONLY on a complete success so a
  //    failure leaves (welcomed_at set, contact_synced_at null): queryable for a
  //    backfill and re-attempted if the trigger ever re-fires for this user.
  let contactSynced = alreadySynced;
  if (!alreadySynced) {
    contactSynced = await createContact(supabase, email, provider);
    if (contactSynced) {
      const { error: cErr } = await supabase.from('profiles').update({ contact_synced_at: new Date().toISOString() }).eq('id', userId);
      if (cErr) console.error('contact_synced_at stamp failed:', cErr.message);
    }
  }

  return jsonRes({ ok: true, welcomed: true, contactSynced });
});
