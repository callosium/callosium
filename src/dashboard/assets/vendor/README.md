# Vendored browser assets

Third-party browser libraries are **vendored** (committed here and served by the local
app from `/assets/vendor/…`) instead of loaded from a CDN at runtime. This keeps the app
fully offline except for the two calls it's allowed to make — the Supabase **auth API**
(only on an actual sign-in) and the GitHub **update check** (server-side). The dashboard's
Content-Security-Policy (`server.ts`) blocks any external script/style/font/connection, so a
runtime CDN fetch would be refused anyway.

## `supabase.js`

- Package: `@supabase/supabase-js`
- Pinned version: **2.110.8**
- Build: the official UMD bundle (`dist/umd/supabase.js`)
- Used by: the onboarding sign-in flow (`ui.html.base` → `sbEnsure()`), Connected-tier hosted accounts.

To refresh to a new pinned version:

```bash
npm i --no-save @supabase/supabase-js@<version>
cp node_modules/@supabase/supabase-js/dist/umd/supabase.js src/dashboard/assets/vendor/supabase.js
# update the pinned version above and the comment in ui.html.base, then rebuild:
node src/dashboard/build-ui.mjs
```
