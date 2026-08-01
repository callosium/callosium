// Callosium on-signup side-effects. Fired by an AFTER INSERT trigger on
// public.waitlist (via pg_net). Decoupled from the waitlist insert function on
// purpose: the product/backend team owns the fast, hardened insert; marketing
// owns these side-effects (welcome email + Resend contact + owner alert), so
// neither redeploy can clobber the other.
//
// Auth: called server-to-server by the DB trigger with an x-signup-secret
// header, compared against SIGNUP_HOOK_SECRET in Vault. No browser/CORS path.
// Idempotent: skips if the row's welcomed_at is already set.
//
// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const FROM = 'Abdo from Callosium <abdo@callosium.com>';
const ALERT_FROM = 'Callosium Signups <abdo@callosium.com>';
// Comma-separated. REDACTED FOR THE PUBLIC REPO: the deployed function carries a
// personal address as the fallback, which is deliberately not committed here. Set
// the SIGNUP_ALERT_TO secret before redeploying, or signup alerts go nowhere —
// an empty list makes sendAlert a silent no-op.
const ALERT_TO = (Deno.env.get('SIGNUP_ALERT_TO') || '').split(',').map(s=>s.trim()).filter(Boolean);
const SUBJECT = "you're in. here's what happens on August 4";
// Unsubscribe on OUR domain, proxied to this same function by a Vercel rewrite
// (deploy/vercel.json: /unsubscribe -> the supabase functions URL).
// The mail sends from abdo@callosium.com, but this URL used to be the raw
// kiimqsadfzwlgywskafq.supabase.co host — and it appears three times in every
// welcome email: the HTML footer link, the plain-text line, and the
// List-Unsubscribe header that Gmail and Yahoo read for RFC 8058 one-click.
// A sending domain that does not match its own links is a spam-filter signal,
// and Resend's Insights flagged it. A REWRITE rather than a redirect because a
// 308 still lands the browser on supabase.co and adds a hop some providers will
// not follow on the one-click POST. Safe to proxy: the unsubscribe function
// authenticates purely on the HMAC in the query string (e + t) — no origin
// check, no cookies, no custom headers. The supabase URL stays live, so
// unsubscribe links in already-delivered mail keep working.
const UNSUB_BASE = 'https://callosium.com/unsubscribe';
const SEGMENT_WAITLIST = '51f2d641-ddc2-401f-8966-67f261b8efb4';
const enc = new TextEncoder();

function b64url(s: string): string {
  return btoa(String.fromCharCode(...enc.encode(s))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name:'HMAC', hash:'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return Array.from(new Uint8Array(sig)).map(b=>b.toString(16).padStart(2,'0')).join('');
}
function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0; for (let i=0;i<a.length;i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function welcomeText(unsubUrl: string): string {
  return [
    "Hey, it's Abdo.",'',
    "You're on the Callosium early access list. Thank you, genuinely. The list is small and early, which means you're one of the people shaping this.",'',
    'Quick recap of what you signed up for: Callosium gives every AI you use one shared memory. It lives in plain files, in a folder on your computer, owned by you. Teach one AI something, and all of them know it.','',
    'WHAT HAPPENS NEXT','August 4: early access opens. You get the download link before anyone else. The core is free, forever.',
    "Until then I'm building in public: what got built, what broke, honest numbers. About one email a week, no noise.",'',
    'One question, and it genuinely helps me build this right: which AI do you use most day to day - ChatGPT, Claude, something else? Just hit reply with a name. I read every answer.','','- Abdo','',
    'Follow the build: https://x.com/callosium','',
    "You're getting this because you joined the waitlist at callosium.com. One email a week at most until launch.",
    `Unsubscribe (one click): ${unsubUrl}`,
  ].join('\n');
}
function welcomeHtml(unsubUrl: string): string {
  return `<!DOCTYPE html>\n<html>\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n<meta http-equiv="X-UA-Compatible" content="IE=edge">\n<title>Callosium</title>\n</head>\n<body style="margin:0; padding:0; background-color:#EFEDEA;">\n<table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#EFEDEA" style="background-color:#EFEDEA;">\n<tr><td align="center" style="padding-top:24px; padding-bottom:24px; padding-left:12px; padding-right:12px;">\n<table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; width:100%;">\n  <tr>\n    <td bgcolor="#07060B" style="background-color:#07060B; padding-top:28px; padding-bottom:28px; padding-left:32px; padding-right:32px;">\n      <table width="100%" cellpadding="0" cellspacing="0" border="0">\n        <tr><td style="font-family:'Courier New', Courier, monospace; font-size:22px; line-height:26px; color:#EFEDF2; letter-spacing:6px; font-weight:bold;">CALLOSIUM<span style="color:#FF2E88;">_</span></td></tr>\n        <tr><td style="padding-top:8px; font-family:'Courier New', Courier, monospace; font-size:11px; line-height:16px; color:#9A93A8; letter-spacing:2px;">ONE BRAIN &#183; EVERY AI &#183; YOUR FILES</td></tr>\n      </table>\n    </td>\n  </tr>\n  <tr><td bgcolor="#FF2E88" style="background-color:#FF2E88; font-size:0; line-height:0; height:3px;">&nbsp;</td></tr>\n  <tr>\n    <td bgcolor="#FFFFFF" style="background-color:#FFFFFF; padding-top:32px; padding-bottom:32px; padding-left:32px; padding-right:32px;">\n      <table width="100%" cellpadding="0" cellspacing="0" border="0">\n        <tr><td style="font-family:Georgia, 'Times New Roman', serif; font-size:16px; line-height:26px; color:#1A1721;">\n          <p style="margin:0 0 16px 0;">Hey, it's Abdo.</p>\n          <p style="margin:0 0 16px 0;">You're on the Callosium early access list. Thank you, genuinely. The list is small and early, which means you're one of the people shaping this.</p>\n          <p style="margin:0 0 16px 0;">Quick recap of what you signed up for: <strong>Callosium gives every AI you use one shared memory.</strong> It lives in plain files, in a folder on your computer, owned by you. Teach one AI something, and all of them know it.</p>\n        </td></tr>\n        <tr><td style="padding-top:4px; padding-bottom:20px;">\n          <table width="100%" cellpadding="0" cellspacing="0" border="0">\n            <tr><td bgcolor="#F5F2FA" style="background-color:#F5F2FA; border-left:3px solid #FF2E88; padding-top:16px; padding-bottom:16px; padding-left:20px; padding-right:20px;">\n              <table width="100%" cellpadding="0" cellspacing="0" border="0">\n                <tr><td style="font-family:'Courier New', Courier, monospace; font-size:12px; line-height:18px; color:#544E64; letter-spacing:1px;">WHAT HAPPENS NEXT</td></tr>\n                <tr><td style="padding-top:8px; font-family:Georgia, 'Times New Roman', serif; font-size:15px; line-height:24px; color:#1A1721;"><strong>August 4</strong>: early access opens. You get the download link before anyone else. The core is free, forever.<br><br>Until then I'm building in public: what got built, what broke, honest numbers. About one email a week, no noise.</td></tr>\n              </table>\n            </td></tr>\n          </table>\n        </td></tr>\n        <tr><td style="font-family:Georgia, 'Times New Roman', serif; font-size:16px; line-height:26px; color:#1A1721;">\n          <p style="margin:0 0 16px 0;"><strong>One question, and it genuinely helps me build this right:</strong> which AI do you use most day to day &#8212; ChatGPT, Claude, something else? Just hit reply with a name. I read every answer.</p>\n          <p style="margin:0 0 4px 0;">&#8212; Abdo</p>\n        </td></tr>\n        <tr><td style="padding-top:12px;">\n          <table cellpadding="0" cellspacing="0" border="0">\n            <tr><td bgcolor="#07060B" style="background-color:#07060B; padding-top:12px; padding-bottom:12px; padding-left:24px; padding-right:24px;"><a href="https://x.com/callosium" style="font-family:'Courier New', Courier, monospace; font-size:13px; line-height:16px; color:#FF2E88; text-decoration:none; letter-spacing:1px;">FOLLOW THE BUILD &#8594;</a></td></tr>\n          </table>\n        </td></tr>\n      </table>\n    </td>\n  </tr>\n  <tr>\n    <td bgcolor="#EFEDEA" style="background-color:#EFEDEA; padding-top:20px; padding-bottom:8px; padding-left:32px; padding-right:32px;">\n      <table width="100%" cellpadding="0" cellspacing="0" border="0">\n        <tr><td align="center" style="font-family:Arial, Helvetica, sans-serif; font-size:11px; line-height:17px; color:#9A93A8;">You're getting this because you joined the waitlist at <a href="https://callosium.com" style="color:#9A93A8;">callosium.com</a>.<br>One email a week at most until launch. <a href="${unsubUrl}" style="color:#9A93A8;">Unsubscribe</a> anytime, one click, no hard feelings.</td></tr>\n      </table>\n    </td>\n  </tr>\n</table>\n</td></tr>\n</table>\n</body>\n</html>`;
}

const vaultCache = new Map<string,string>();
async function vaultVal(supabase: any, rpc: string): Promise<string|null> {
  if (vaultCache.has(rpc)) return vaultCache.get(rpc)!;
  const { data, error } = await supabase.rpc(rpc);
  if (error || !data) { console.error(`${rpc} failed:`, error?.message ?? 'empty'); return null; }
  vaultCache.set(rpc, data as string); return data as string;
}

async function sendWelcome(supabase: any, email: string): Promise<boolean> {
  const key = Deno.env.get('RESEND_API_KEY') ?? await vaultVal(supabase, 'get_resend_key');
  const secret = await vaultVal(supabase, 'get_unsub_secret');
  if (!key || !secret) return false;
  const token = (await hmacHex(secret, email)).slice(0,32);
  const unsubUrl = `${UNSUB_BASE}?e=${b64url(email)}&t=${token}`;
  try {
    const res = await fetch('https://api.resend.com/emails', { method:'POST', headers:{ Authorization:`Bearer ${key}`, 'Content-Type':'application/json', 'Idempotency-Key':`welcome-${email}` },
      body: JSON.stringify({ from:FROM, to:[email], reply_to:'abdo@callosium.com', subject:SUBJECT, html:welcomeHtml(unsubUrl), text:welcomeText(unsubUrl),
        headers:{ 'List-Unsubscribe':`<${unsubUrl}>`, 'List-Unsubscribe-Post':'List-Unsubscribe=One-Click' } }) });
    if (!res.ok) { console.error('welcome failed:', res.status, (await res.text()).slice(0,200)); return false; }
    return true;
  } catch(e){ console.error('welcome error:', (e as Error)?.message); return false; }
}

// Sync the signup into Resend: create the contact (properties live here), THEN
// attach it to the waitlist segment via the SEPARATE segment endpoint. Resend
// SILENTLY IGNORES segment_ids on POST /contacts (verified 17 Jul: contacts
// landed with no segment), so membership MUST be set with
// POST /contacts/{email}/segments/{id}. Both calls retry on 429 because this
// runs after the alert + welcome emails and trips Resend's ~2 req/s account
// limit. 409 / already-present count as success. Returns a debug label.
async function createContact(supabase: any, email: string, plan: string, source: string|null): Promise<string> {
  const key = await vaultVal(supabase, 'get_resend_contacts_key');
  if (!key) return 'fail:nokey';
  const auth = { Authorization:`Bearer ${key}`, 'Content-Type':'application/json' };
  async function post(url: string, body?: unknown): Promise<{ok:boolean; status:number; txt?:string}> {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const res = await fetch(url, { method:'POST', headers:auth, body: body === undefined ? undefined : JSON.stringify(body) });
        if (res.ok || res.status === 409) return { ok:true, status:res.status };
        const txt = (await res.text()).slice(0,160);
        if (res.status === 429 && attempt < 5) {
          const ra = Number(res.headers.get('retry-after')) || 0;
          await new Promise(r => setTimeout(r, ra > 0 ? Math.min(ra*1000, 3000) : 500*attempt));
          continue;
        }
        return { ok:false, status:res.status, txt };
      } catch(e){ return { ok:false, status:0, txt:(e as Error)?.message }; }
    }
    return { ok:false, status:429, txt:'retries' };
  }
  const create = await post('https://api.resend.com/contacts', { email, properties:{ plan, source: source ?? 'unknown' } });
  if (!create.ok) { console.error(`contact create failed: ${create.status} ${create.txt}`); return `fail:create:${create.status}`; }
  const seg = await post(`https://api.resend.com/contacts/${encodeURIComponent(email)}/segments/${SEGMENT_WAITLIST}`);
  if (!seg.ok) { console.error(`segment add failed: ${seg.status} ${seg.txt}`); return `ok:${create.status}+segfail:${seg.status}`; }
  console.log(`contact ok: create ${create.status}, segment ${seg.status}`);
  return `ok:${create.status}+seg:${seg.status}`;
}

async function sendAlert(supabase: any, email: string, plan: string, source: string|null): Promise<void> {
  const key = Deno.env.get('RESEND_API_KEY') ?? await vaultVal(supabase, 'get_resend_key');
  if (!key || !ALERT_TO.length) return;
  let total: number|null = null, founding: number|null = null;
  try {
    const { count } = await supabase.from('waitlist').select('*', { count:'exact', head:true });
    total = count ?? null;
    const { count: f } = await supabase.from('waitlist').select('*', { count:'exact', head:true }).eq('plan','founding');
    founding = f ?? null;
  } catch { /* count is a nice-to-have */ }
  const isFounding = plan === 'founding';
  const subject = `${isFounding ? '\u{1F451}' : '\u{1F389}'} New Callosium signup${isFounding ? ' (FOUNDING MEMBER)' : ''}: ${email}`;
  const text = [
    `${email} just joined the Callosium waitlist.`,'',
    `plan:   ${plan}`,
    `source: ${source ?? 'unknown'}`,
    total != null ? `total signups: ${total}${founding != null ? ` (${founding} founding)` : ''}` : '',
    '', 'Reply to this email to reach them directly.',
  ].filter(Boolean).join('\n');
  try {
    await fetch('https://api.resend.com/emails', { method:'POST', headers:{ Authorization:`Bearer ${key}`, 'Content-Type':'application/json', 'Idempotency-Key':`alert-${email}` },
      body: JSON.stringify({ from:ALERT_FROM, to:ALERT_TO, reply_to:[email], subject, text }) });
  } catch(e){ console.error('alert error:', (e as Error)?.message); }
}

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
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email) return new Response('no email', { status: 400 });
  const plan = body?.plan === 'founding' ? 'founding' : 'free';
  const source = typeof body?.source === 'string' ? body.source : null;

  // Idempotency: only act if this row hasn't been welcomed yet.
  const { data: row } = await supabase.from('waitlist').select('welcomed_at, unsubscribed_at').eq('email', email).maybeSingle();
  if (!row) return new Response(JSON.stringify({ ok:true, skipped:'no-row' }), { headers:{'content-type':'application/json'} });
  if (row.welcomed_at) return new Response(JSON.stringify({ ok:true, skipped:'already' }), { headers:{'content-type':'application/json'} });

  // Alert the owner regardless (they want every signup); welcome + contact only if not unsubscribed.
  await sendAlert(supabase, email, plan, source);
  let contact = 'skipped';
  if (!row.unsubscribed_at) {
    const sent = await sendWelcome(supabase, email);
    contact = await createContact(supabase, email, plan, source);
    if (sent) await supabase.from('waitlist').update({ welcomed_at: new Date().toISOString() }).eq('email', email);
  }
  return new Response(JSON.stringify({ ok:true, contact }), { headers:{'content-type':'application/json'} });
});
