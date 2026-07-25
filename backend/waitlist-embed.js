// Callosium waitlist — drop-in landing-page wiring. Zero dependencies.
//
// Two ways to use it:
//
// 1) Auto-wire a form. Give any <form> a data-callosium-waitlist attribute and an
//    <input type="email">. On submit it POSTs the email and swaps in a thank-you.
//      <form data-callosium-waitlist>
//        <input type="email" name="email" required placeholder="you@email.com">
//        <button>Get early access</button>
//        <p data-cw-message hidden></p>
//      </form>
//    Set the endpoint once, before this script runs:
//      <script>window.CALLOSIUM_WAITLIST_URL = 'https://<ref>.supabase.co/functions/v1/waitlist'</script>
//
// 2) Call it yourself:
//      const r = await callosiumJoinWaitlist('you@email.com', 'landing');
//      if (r.ok) showThanks(); else showError(r.error);
//
// The endpoint is the deployed edge function URL (see backend/DEPLOY.md). No keys
// live here — the function is public and writes server-side with the service role.

(function () {
  function endpoint() {
    return (typeof window !== 'undefined' && window.CALLOSIUM_WAITLIST_URL) || '';
  }

  async function join(email, source, plan) {
    const url = endpoint();
    if (!url) return { ok: false, error: 'Waitlist endpoint not set.' };
    const clean = String(email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) return { ok: false, error: 'Please enter a valid email.' };
    try {
      // Forward `plan` so a founding-member CTA is stored as 'founding', not
      // 'free'. The function validates it (anything but 'founding' → 'free'), so
      // an omitted/garbage plan is harmless.
      var reqBody = { email: clean, source: source || 'landing' };
      if (plan) reqBody.plan = plan;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(reqBody),
      });
      const body = await res.json().catch(function () { return {}; });
      if (res.ok && body && body.ok) return { ok: true };
      return { ok: false, error: (body && body.error) || 'Something went wrong — please try again.' };
    } catch (_e) {
      return { ok: false, error: 'Network error — please try again.' };
    }
  }

  // expose the programmatic API
  if (typeof window !== 'undefined') window.callosiumJoinWaitlist = join;

  // auto-wire any tagged forms once the DOM is ready
  function wire() {
    var forms = document.querySelectorAll('form[data-callosium-waitlist]');
    Array.prototype.forEach.call(forms, function (form) {
      if (form.__cwWired) return;
      form.__cwWired = true;
      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        var input = form.querySelector('input[type="email"], input[name="email"]');
        var msg = form.querySelector('[data-cw-message]');
        var btn = form.querySelector('button, input[type="submit"]');
        var email = input ? input.value : '';
        var source = form.getAttribute('data-cw-source') || 'landing';
        // data-cw-plan="founding" on the founding-member CTA's form → stored as
        // 'founding'; absent → 'free'.
        var plan = form.getAttribute('data-cw-plan') || undefined;
        if (btn) btn.disabled = true;
        var r = await join(email, source, plan);
        if (btn) btn.disabled = false;
        if (msg) {
          msg.hidden = false;
          msg.textContent = r.ok ? "You're on the list — we'll be in touch." : r.error;
          msg.setAttribute('data-cw-state', r.ok ? 'ok' : 'error');
        }
        if (r.ok && form.reset) form.reset();
      });
    });
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
  }
})();
