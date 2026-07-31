# The Callosium brain schema

Version 0.1, extracted 11 July 2026 from a year of a real, heavily-used second brain shared by a human and four AI agents.

This document defines the default structure every new Callosium brain starts from. It is opinionated on purpose: the value of Callosium is not that it stores Markdown (anything stores Markdown), it is that every file has one correct home, every AI that connects inherits the same rules, and retrieval is deterministic because filing was deterministic.

## Principles

1. **The brain is self-contained.** No note may depend on a file outside the brain folder. If a note needs to cite a document, the document is copied into the brain first and the note links the internal copy.
2. **Plain Markdown, plain names.** Every note is a `.md` file with YAML frontmatter. Names are plain words with spaces: no number prefixes, no underscores, no dashes, no camelCase. The brain must stay readable by a human with a file explorer, forever, with no app.
3. **Preserve first, distill second.** Anything authoritative (a spec, a contract, an export, an original document) is kept verbatim and never rewritten. Summaries point at originals; they never replace them.
4. **Anchors stay current, records stay forever.** Knowledge lives in two layers: anchor notes that are always up to date (one per entity), and episodic records that are append-only history (one per event or session). Update anchors; never rewrite records.
5. **Links build the graph.** Notes link each other with `[[wiki links]]` that resolve by exact filename or alias. Every note should be reachable from a hub.
6. **AI-written is marked.** Generated text never silently overwrites the owner's own words.

## Partitions

A partition is a top-level folder with one job. Core partitions exist in every brain; optional modules are enabled at onboarding or later.

### Core

| Partition | Job |
|---|---|
| `Profile/` | Who the owner is: `About Me`, `Working Style`, `Goals and Now` (the living priorities note every AI reads first) |
| `Knowledge/` | Evergreen reusable know-how, each note reachable from a hub |
| `Initiatives/` | The owner's own ventures and side projects, one anchor note each, `status:` tracks idea / active / parked / done. Named to never collide with `Work/Projects/` |
| `People/` | One short note per person worth remembering |
| `Memory/` | Episodic records, append-only, filed `Memory/<Source>/<Year>/<MM Month>/`, one auto-maintained `Index.md` per source |
| `Logs/` | Dated session logs (`Session D Month YYYY.md`, day unpadded) plus `Log Index.md` |
| `Milestones/` | Finished workstreams, `type: milestone` with a `completed:` date, queryable as an accomplishment table |
| `Personal/` | Personal life and setup |
| `Private/` | Gated sensitive content (health, family, identity documents). Agents read or write here only when the task is specifically about those topics, and never surface its content otherwise |
| `Inbox/` | Quick unsorted captures, to be filed later by the housekeeping loop |
| `Reference/` | Verbatim source material, bucketed by topic (`Reference/<Bucket>/`). New bucket over loose files, always |
| `Templates/` | Note templates |
| `System/` | How this brain works: the generated instructions, the schema config, filing rules. Callosium maintains this partition |

### Optional modules

| Module | Adds | For |
|---|---|---|
| `Work/` | `Work/Projects/<Name>/` (anchor + `Raw/` of verbatim originals), `Work/Meetings/<Year>/<Month>/<Day>/<Topic>/`, `Work/People/`, `Work/Playbooks/` | Anyone with a job or clients |
| `Social Media/` | `Content Studied/`, `Playbooks/`, `Creators/`, `Platforms/` | Creators and students of content |
| Custom | Any user-defined partition registered in the schema config | Everything else |

## Note anatomy

Every agent-written note starts with YAML frontmatter:

```yaml
---
type: knowledge | initiative | project | person | memory | log | milestone | moc | reference | system | profile
tags: [lowercase, kebab-or-plain]
status: active | idea | parked | done | archived
updated: YYYY-MM-DD
aliases: [optional short names for linking]
created_by: <agent identity, stamped by the server>
updated_by: <agent identity of the last writer, stamped by the server>
---
```

Verbatim source files are exempt: they keep their original content, naming, and format untouched, always.

## Agent identity and attribution

Every AI connects to the brain through a registered identity: a client type plus the owner's name for that agent (for example `Claude Desktop`, `Claude Code`, `OpenClaw (Makoto)`, `ChatGPT`). The identity is created at pairing time, the same identity that scoping permissions attach to.

Attribution is stamped **by the server, not by the agent**, on every MCP write:

- `created_by:` set once when the note is created; `updated_by:` set to the last writer. Agents cannot forge or omit these, because the server derives them from the authenticated connection.
- Memory records use the agent's display name as their `Source` (so `Makoto Kitchen renovation quotes 03 Feb 2027` traces the record to the agent that wrote it, and `Memory/Makoto/` collects that agent's history).
- The server also keeps an append-only audit log (file, agent, operation, timestamp) outside the notes, powering the per-agent audit view in the dashboard.

The owner's own edits (made directly in a file editor) carry no stamp, which is itself information: unstamped changes are the human's.

Memory records are named `Source Topic DD Mon YYYY` (for example `Claude Kitchen renovation quotes compared 03 Feb 2027`). Long names link with an alias: `[[Claude Kitchen renovation quotes compared 03 Feb 2027|kitchen quotes]]`.

## Hubs (MOCs)

Navigation is hub-first: land on a topic hub, fan out through links, never scan the whole tree. Every brain has `Home.md` (the map of maps) and one MOC per major topic. A note that no hub can reach is an orphan; the housekeeping loop flags it.

## The routing tree

Run on every document before saving. This is the deterministic heart of the filing system:

1. **Is it authoritative or detail-critical?** (spec, contract, export, deliverable, anything where exact wording or numbers matter)
   → Preserve the raw file verbatim: work material to `Work/Projects/<Name>/Raw/<Doc Type>/`, everything else to the matching `Reference/<Bucket>/`. Then write a short pointing summary in the matching non-raw location and link it. Never lossy-distill. When unsure, treat as detail-critical.
2. **Is it general or conversational?** (a brainstorm, an idea, a session recap)
   → A concise knowledge or memory note in the brain's own words. Keeping the raw is optional.
3. **Is it AI-generated?**
   → Mark it clearly, keep it separable from the owner's writing.

Plus the standing rules: secrets (API keys, tokens, passwords) are never stored — the AI refuses and points the owner at their password manager — people go to `People/`, captures with no obvious home to `Inbox/`.

## The ground-truth protocol

For any canonical source (docs, specs, standards, exports), in this exact order:

1. Write the knowledge note first (concise, linked, structured), filed by topic.
2. Copy the raw file into `Reference/<Bucket>/` unaltered.
3. End the knowledge note with a "Raw source" section wiki-linking the raw file.

Never skip step 2. The summary is for orientation; the raw file is the ground truth.

## The session-end ritual

At the end of a working session, every connected AI:

1. Appends a dated entry to `Logs/`.
2. Writes a Memory record if the work was substantial.
3. Bumps any anchor note that changed (`updated:` date).
4. Updates `Profile/Goals and Now.md` if priorities shifted; adds a `Milestones/` note when a workstream finishes.
5. Adds index lines (`Logs/Log Index.md`, the source `Index.md`).

Callosium's housekeeping scanners verify this ritual happened and queue fixes when it did not.

## What is configuration, not schema

These vary per owner and live in the schema config, served to every AI over MCP:

- **Style profile**: voice and formatting rules the owner wants every AI to follow (banned punctuation, banned words, tone).
- **Tool routing**: "when I ask for research, use X" preferences.
- **Agent scopes**: which connected agent can see which partitions.
- **Module choices** and custom partitions.

## Machine-readable form

The evaluable version of this schema (partitions, note types, routing rules, index definitions) lives in [`schema/default-brain.json`](../schema/default-brain.json). `brain init` scaffolds from it; the filing engine and housekeeping scanners evaluate against it; `get_instructions` over MCP is generated from it plus the owner's config.
