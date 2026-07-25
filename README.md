# Callosium

**Every AI you use forgets you. Callosium gives them one shared memory — in plain files you own.**

You explain your project to Claude. Then you explain it again to ChatGPT. Then again to Cursor. Every chat starts from zero, and everything you've ever told an AI is scattered across apps that don't talk to each other.

Callosium fixes that. It turns a folder of plain Markdown on your computer into a **brain any AI can use**: they recall what you know before answering, save what they learn in the right place, and cite exactly where every answer came from. Your files never leave your machine.

## Get started (2 minutes)

You need [Node.js](https://nodejs.org) 20 or newer. Then:

```bash
npx callosium init my-brain        # create a brain (or point at notes you already have)
npx callosium serve --brain my-brain
```

Open **http://localhost:4319** — the dashboard walks you through the rest, whichever situation you're in:

- **I already have notes** — an Obsidian vault or any folder of Markdown. Callosium reads it, connects it, and learns what it means. Your files are never reformatted; Obsidian stays your editor.
- **I have raw stuff** — messy text, exports, half-finished notes. Drop them in the Inbox and your AI files and links everything for you.
- **Start empty** — your AI interviews you (who you are, what you're working on, who's around you) and writes your first memories.

At the end, the dashboard generates the exact config for your AI — Claude, Cursor, ChatGPT-compatible apps, 23 clients supported — plus the standing rules that make it use your brain automatically, every session.

> First run downloads Callosium's language model (~120MB, one time) so meaning-based search works in English and Arabic — fully offline after that. No internet on first run? Everything still works — keyword recall needs no model, and the smarter search switches itself on once the model is in place.

> **On Linux:** the install pulls in GPU add-ons for the search library that Callosium never uses — it runs on the CPU everywhere. Measured in CI: **725MB installed on Linux vs 414MB on Windows and macOS**, so that's 311MB of downloaded code that never runs. Skip it:
> ```bash
> ONNXRUNTIME_NODE_INSTALL=skip npm install -g callosium
> ```
> Nothing is lost by skipping. Windows and macOS aren't affected.

## What your AI can do once connected

- **Ask before answering** — `recall` returns the right notes with the exact matching lines cited, in ~40ms. If the answer isn't in your notes, it says so — it never invents.
- **Remember what it learns** — `write_note` files new knowledge in the right folder, links it to related notes, and stamps *which AI wrote it*. Unforgeable.
- **Respect your privacy** — you decide per AI what each one can see. `Private/` is invisible unless you personally grant it.
- **Handle huge documents** — a 150,000-word reference doc comes back as a map; the AI reads just the section that answers.

## Why it's different

Plenty of tools can point an AI at a folder of Markdown. What sets Callosium apart is everything that happens *after* that:

- **It's measured, not asserted.** A 10,000-question benchmark ships in this repo — run it against your own brain. Most "AI memory" is graded by the vendor that sells it; this you can check yourself.
- **Every AI, scoped and attributed.** Connect Claude, Cursor, ChatGPT-compatible apps and more to the *same* brain. Each write is stamped with *which* AI made it (unforgeable, server-side), and you decide per-AI what each one may even see.
- **Nothing gets lost — whoever edits it.** Every note is versioned automatically: whether an AI wrote it through Callosium or you edited the file yourself in Obsidian, the change is captured and one click away from being undone. (The last 20,000 versions are kept — years of normal use, about 18MB. `CALLOSIUM_HISTORY_KEEP` raises it.)
- **No terminal to live in.** A local dashboard runs onboarding, the connection config for each AI, health checks, and search — not a command line.
- **Bilingual by design.** Meaning-based recall works in English *and* Arabic, out of the box.
- **Actually yours.** Plain files on your own disk. No database, no cloud, no account. Uninstall tomorrow and your notes are still just… notes.

## The receipts

Not marketing math — measured on the builder's own brain of 1,162 real notes, in English and Arabic: 15,000 generated questions, **96.4% found**, **0 invented answers** across 1,450 trick questions about things that don't exist, 49ms median (116ms at the 99th percentile).

You can reproduce this on **your** brain, which is the only number that should convince you. The question generator and the grader both ship here (`test/gen-scenarios-v4.mjs`, `test/run-bench-v2.mjs`); they read your vault and build the test set from your own notes. The author's own question set is deliberately *not* included — it is generated from a private vault, so every question and expected answer embeds real note paths. A benchmark you run against your own notes is worth more than one you download anyway.

## Your files, your storage

Everything is plain Markdown + YAML in a folder you choose. No database, no cloud, no account required. Delete Callosium tomorrow and your notes are still just… notes.

**Status: early access. Follow the build: [callosium.com](https://callosium.com)**

## License

Apache-2.0
