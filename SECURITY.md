# Security

Callosium is a local-first tool: your notes are plain files on your disk, the retrieval engine and
MCP server run entirely on your machine, and the app only reaches the network for sign-in (optional,
Connected tier) and the update check. There is no server that holds your data.

To report a vulnerability, open a private security advisory on the GitHub repo (Security → Report a
vulnerability) rather than a public issue.

## Dependency advisories — risk acceptance

`npm audit` reports advisories in transitive dependencies of `@huggingface/transformers` (the local
embedding runtime) and `@modelcontextprotocol/sdk` (the HTTP MCP transport). The safe, non-breaking
fixes are applied (e.g. `fast-uri`). The following are **accepted** because they are unreachable in
how Callosium uses those packages, and the only "fixes" npm offers are **breaking major downgrades**
that would regress the engine / MCP transport. They are tracked for a clean upstream bump.

| Advisory | Path | Why it's not reachable here |
|---|---|---|
| `adm-zip` — crafted ZIP → 4 GB alloc (high) | `@huggingface/transformers` → `onnxruntime-node` → `adm-zip` | adm-zip is used only at **install time** to unpack onnxruntime's optional GPU provider blobs from nuget. CI sets `ONNXRUNTIME_NODE_INSTALL=skip` and the CPU binaries ship inside the package, so that download/extract path never runs, and Callosium never feeds a user-supplied ZIP to adm-zip. |
| `sharp` / libvips CVEs (high) | `@huggingface/transformers` → `sharp` | `sharp` is an **image**-processing dependency of transformers. Callosium only runs the **text** feature-extraction pipeline (`multilingual-e5-small`); it never decodes an image through sharp/libvips. |
| `onnxruntime-node`, `@huggingface/transformers` (inherit the two above) | — | Inherit only the adm-zip / sharp advisories above; both paths are unreachable as described. |
| `@hono/node-server` — `serve-static` path traversal via `%5C` on Windows (moderate) | `@modelcontextprotocol/sdk` → `@hono/node-server` | Only the MCP SDK's HTTP transport pulls hono, and Callosium does not use hono's `serve-static` (the dashboard is a separate `http.createServer` with its own path-containment guards). The advisory's static-file handler is never mounted. |

The forced remediations (`npm audit fix --force`) would install `@modelcontextprotocol/sdk@1.24.3`
(a breaking downgrade of the MCP transport) and bump majors under transformers. We do not apply them;
we will pick up patched versions when the upstreams release non-breaking fixes.

### Verifying "unreachable" rather than asserting it

"Unreachable" is a claim about runtime, so it is checked at runtime rather than argued from the
dependency tree. Hook `Module._load`, then exercise the real paths — a full recall (which loads the
embedding runtime), the MCP server, and the dashboard server:

```bash
node -e 'const M=require("module"),h=new Set(),o=M._load;M._load=function(r){if(["sharp","adm-zip","hono"].some(w=>r===w||r.startsWith(w+"/")))h.add(r);return o.apply(this,arguments)};process.on("exit",()=>console.error("loaded:",h.size?[...h]:"NONE"))' --require /dev/stdin src/cli.ts recall "anything" --brain <a-brain>
```

Last run (26 Jul 2026, a real `recall` against a freshly `init`ed brain): **NONE**. None of the three
packages is loaded, so no advisory in them is on any code path Callosium executes. Re-run this after
any dependency bump — a lazily-required image or static-file path could appear without the tree
changing shape.
