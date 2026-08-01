// Opinly content webhook — Svix-signed, fired when a post publishes or updates.
//
// WHAT THIS CAN AND CANNOT DO, HONESTLY:
// callosium.com is pre-built static HTML uploaded by `vercel deploy --prod` from a
// local folder. There is no framework, no server runtime, and no build step on
// Vercel's side, so there is no cache to invalidate and no revalidatePath()
// equivalent to call — the pages simply do not exist until build-blog.mjs runs and
// the folder is redeployed.
//
// So this endpoint does the only two useful things available: it VERIFIES the
// signature (so nothing unsigned can trigger anything) and it NOTIFIES Abdo with
// the exact paths that changed, so he runs the two-command rebuild.
//
// To make this fully automatic later, the deploy model has to change: either give
// the Vercel project a build step (package.json + `node build-blog.mjs`, with
// OPINLY_API_KEY as a Vercel env var) and swap the email below for a fetch() to a
// Vercel Deploy Hook, or run the same build on a schedule. Deliberately not done
// pre-launch: it would rewrite a production deploy path that currently works.
//
// Deploy: supabase functions deploy opinly-webhook --no-verify-jwt
//   (--no-verify-jwt is required: Svix signs with its own scheme, it has no Supabase JWT)
//
// Secrets: SVIX_WEBHOOK_SECRET (from the Opinly dashboard when you register this
// URL). Read from env first, Vault RPC second, matching the other functions here.
//
// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { Webhook } from 'https://esm.sh/svix@1.24.0';

const FROM = 'Callosium <abdo@callosium.com>';
const TO = 'abdo@callosium.com';

async function vaultVal(supabase: any, rpc: string): Promise<string | null> {
  try {
    const { data, error } = await supabase.rpc(rpc);
    if (error || !data) return null;
    return data as string;
  } catch { return null; }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const supabase = (url && serviceKey)
    ? createClient(url, serviceKey, { auth: { persistSession: false } })
    : null;

  const secret = Deno.env.get('SVIX_WEBHOOK_SECRET')
    ?? (supabase ? await vaultVal(supabase, 'get_svix_webhook_secret') : null);
  if (!secret) {
    console.error('opinly-webhook: SVIX_WEBHOOK_SECRET is not configured');
    return new Response('not configured', { status: 500 });
  }

  // The signature covers the RAW body. Parsing before verifying would let a
  // forged payload through on any JSON re-serialisation difference, so read text
  // first and only trust it after verify() returns.
  const raw = await req.text();
  const headers = {
    'svix-id': req.headers.get('svix-id') ?? '',
    'svix-timestamp': req.headers.get('svix-timestamp') ?? '',
    'svix-signature': req.headers.get('svix-signature') ?? '',
  };

  let evt: any;
  try {
    evt = new Webhook(secret).verify(raw, headers);
  } catch (e) {
    // 400 on a bad signature, as specified. Svix retries on 5xx but not 4xx,
    // which is what we want: a forged or misconfigured call should not be retried.
    console.error('opinly-webhook: signature rejected:', (e as Error)?.message);
    return new Response(JSON.stringify({ error: 'invalid signature' }),
      { status: 400, headers: { 'content-type': 'application/json' } });
  }

  const type = typeof evt?.type === 'string' ? evt.type : 'unknown';
  const paths: string[] = Array.isArray(evt?.data?.paths)
    ? evt.data.paths.filter((p: unknown) => typeof p === 'string').slice(0, 200)
    : [];

  console.log(`opinly-webhook: ${type} → ${paths.length} path(s): ${paths.join(', ')}`);

  // Notify, best-effort. A mail failure must NOT fail the webhook: Svix would
  // retry a 5xx and re-notify for an event we already processed correctly.
  if (supabase && paths.length) {
    try {
      const key = Deno.env.get('RESEND_API_KEY') ?? await vaultVal(supabase, 'get_resend_key');
      if (key) {
        const list = paths.map((p) => `  ${p}`).join('\n');
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: FROM, to: [TO],
            subject: `Opinly content changed (${paths.length} path${paths.length === 1 ? '' : 's'})`,
            text: [
              `Event: ${type}`, '', 'Changed paths:', list, '',
              'To publish the change:', '',
              '  cd "Callosium/Marketing/website"',
              '  node build-blog.mjs',
              '  cd deploy && npx vercel@latest deploy --prod --yes', '',
              'OPINLY_API_KEY must be set in the environment for the build step.',
            ].join('\n'),
          }),
        });
      }
    } catch (e) {
      console.error('opinly-webhook: notify failed (non-fatal):', (e as Error)?.message);
    }
  }

  return new Response(JSON.stringify({ ok: true, type, paths: paths.length }),
    { status: 200, headers: { 'content-type': 'application/json' } });
});
