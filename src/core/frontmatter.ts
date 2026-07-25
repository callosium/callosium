// Frontmatter read/write. gray-matter for parsing (battle-tested), a
// conservative hand-rolled serializer for writing so agent edits never
// reformat a human's YAML more than necessary.

import matter from 'gray-matter';
import type { Frontmatter, Note, NotePath } from './types.ts';

export function parseNote(path: NotePath, raw: string): Note {
  // Strip a leading UTF-8 BOM (U+FEFF). fs.readFile('utf8') does NOT remove it,
  // so a note saved BOM-first by a Windows editor would fail the `---` check
  // below, get misclassified as rawFile, and become permanently un-editable by
  // every MCP write tool. Drop it once, here, so the rest of the pipeline never
  // sees it.
  const clean = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (!clean.startsWith('---')) {
    // No `---` block at all — a plain legacy note. rawFile (serialized verbatim) but ADOPTABLE:
    // there's no YAML to forge, so a write tool may wrap it with server frontmatter.
    return { path, frontmatter: {}, body: clean, rawFile: true, noFrontmatter: true };
  }
  try {
    // { cache: false } is REQUIRED for correctness, not perf: gray-matter memoizes by content string,
    // and a malformed-frontmatter note THROWS only on its FIRST parse — every cached re-parse returns
    // { data: {} } WITHOUT throwing, which would flip rawFile:true→false and BYPASS the write tools'
    // malformed-refusal / attribution-forgery guard in a warm server (graph indexing + brain_check
    // parse every note before any write). Disabling the cache makes the throw deterministic — and also
    // removes the shared-.data-object poisoning the per-note structuredClone below defends against.
    // DO NOT remove this options argument. gray-matter memoizes by content string, but ONLY when
    // called with NO options (its internal `if (!options)` cache branch). Passing ANY options object
    // bypasses that cache, which is what we need: a malformed-frontmatter note throws only on its
    // FIRST cached parse, so without this a warm re-parse returns {data:{}} without throwing and flips
    // rawFile:true→false, defeating the write tools' malformed-refusal / forgery guard. `cache: false`
    // is a self-documenting no-op key (gray-matter's types don't declare it — hence the cast); it is
    // the OPTIONS-OBJECT PRESENCE, not the key, that disables the cache. Do not "tidy" it away.
    const parsed = matter(clean, { cache: false } as Parameters<typeof matter>[1]);
    // A `---`-delimited block whose YAML root is a scalar or a list (not a
    // mapping) parses WITHOUT throwing, leaving parsed.data a primitive/array.
    // Treat that like malformed YAML (rawFile) — otherwise the write tools' only
    // guard (`note.rawFile`) is bypassed and `note.frontmatter.updated_by = …`
    // throws a TypeError in strict mode instead of the clean rejection.
    if (parsed.data === null || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
      return { path, frontmatter: {}, body: clean, rawFile: true };
    }
    return {
      path,
      // gray-matter memoizes by content string: two byte-identical notes (template
      // twins, sync-conflict pairs) share ONE .data object, so an in-place
      // attribution stamp on note A poisons note B's next parse and gets written
      // to disk. Clone per note so mutations stay local. structuredClone keeps
      // Date instances as Dates (yamlValue's Date branch depends on that).
      frontmatter: structuredClone(parsed.data) as Frontmatter,
      body: parsed.content,
      rawFile: false,
    };
  } catch {
    // Malformed YAML: treat as raw so we never destroy content; brain check flags it.
    return { path, frontmatter: {}, body: clean, rawFile: true };
  }
}

// Keys are emitted as `key: value`. A key containing YAML structural characters,
// leading/trailing whitespace, or that is empty would re-parse as malformed YAML
// (degrading the whole note to rawFile on next read), so quote it the same way
// values are quoted. gray-matter happily parses such quoted keys back in.
// True when a BARE scalar would re-resolve on read as a number / date / bool / null instead of the
// string it is (leading-zero ints, hex/oct/bin, floats, .inf/.nan, ISO-date shapes, true/false/null).
// Used to decide when a KEY must be quoted — a quoted numeric-string key like "007"/"1.0" would
// otherwise be re-emitted bare and silently renamed (007→7) and its value shuffled on the next parse.
function reResolvesToNonString(s: string): boolean {
  return (
    /^[-+]?(\.[\d_]+|\d[\d_]*(\.[\d_]*)?)([eE][-+]?\d+)?$/.test(s) ||
    /^[-+]?\.(inf|nan)$/i.test(s) ||
    /^[-+]?0x[0-9a-fA-F_]+$/.test(s) ||
    /^[-+]?0b[01_]+$/.test(s) ||
    /^[-+]?0o[0-7_]+$/.test(s) ||
    /^\d{4}-\d{2}-\d{2}([Tt ].*)?$/.test(s) ||
    /^(true|false|null|~)$/i.test(s)
  );
}

function yamlKey(k: string): string {
  // Mirror yamlValue's quoting decision so a KEY can't re-parse as something other than the string it
  // is: structural chars / commas / control chars, a LEADING indicator (whitespace, '-' or '?' —
  // "- y"/"? x" would otherwise read back as a block-sequence entry / explicit-key and collapse the
  // WHOLE frontmatter block on rewrite), trailing whitespace, or a numeric/date/bool-shaped key.
  if (k === '' || /[:#[\]{}&*!|>'"%@`,\n\r\t]|[\x00-\x1f]|^[?\s-]|\s$/.test(k) || reResolvesToNonString(k)) {
    return `"${k.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
  }
  return k;
}

function yamlValue(v: unknown): string {
  // Drop `undefined` elements (no YAML representation) and emit a real `null`
  // element as the bare YAML null, mirroring the top-level field handling — so
  // an array round-trips as its intended values, not spurious "undefined"/"null"
  // strings.
  if (Array.isArray(v)) return `[${v.filter((x) => x !== undefined).map((x) => (x === null ? 'null' : yamlValue(x))).join(', ')}]`;
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') {
    // A non-finite number stringifies to bare 'NaN'/'Infinity', which YAML reads
    // back as a STRING (silent type flip on the next edit). Emit the YAML 1.1
    // core-schema tokens so it round-trips as a number instead.
    if (!Number.isFinite(v)) return v !== v ? '.nan' : v > 0 ? '.inf' : '-.inf';
    return String(v);
  }
  // js-yaml parses an unquoted `date: 2026-07-16` (or any ISO timestamp) into a
  // native Date OBJECT on read. Without this branch it falls through to the
  // generic-object case below and serializes as `"\"2026-07-16T00:00:00.000Z\""`
  // — a double-quoted, mangled value that corrupts every user date field
  // (`date`/`completed`/`due`/…) on the FIRST agent write. Re-emit it as the
  // original date string, QUOTED so it round-trips as a string and never
  // re-parses into a Date again.
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return '""'; // invalid date → empty string, never crash
    const p = (n: number) => String(n).padStart(2, '0');
    const ymd = `${v.getUTCFullYear()}-${p(v.getUTCMonth() + 1)}-${p(v.getUTCDate())}`;
    const midnight = v.getUTCHours() === 0 && v.getUTCMinutes() === 0 && v.getUTCSeconds() === 0 && v.getUTCMilliseconds() === 0;
    return `"${midnight ? ymd : v.toISOString()}"`;
  }
  // Plain objects (nested mappings) would stringify to "[object Object]" and
  // silently destroy the data — quote a JSON form so at least nothing is lost
  // and it round-trips as a string rather than corrupting on next read.
  if (v !== null && typeof v === 'object') {
    const s = JSON.stringify(v);
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  const s = String(v);
  // Quote when YAML would misread it bare. A value that the YAML core schema
  // resolves as a NUMBER (signed, float, exponent, .inf/.nan) or bool/null
  // must be quoted, or it silently changes type on the next read. Newlines/
  // control chars must be quoted-and-escaped too.
  // Covers YAML 1.1 core-schema numerics js-yaml resolves on read: decimals with
  // `_` group separators, floats/exponents, .inf/.nan, and hex/binary/octal ints
  // (0x1A / 0b101 / 0o17). A plain string shaped like any of these must be quoted
  // or it silently comes back as a number.
  const looksNumeric =
    /^[-+]?(\.[\d_]+|\d[\d_]*(\.[\d_]*)?)([eE][-+]?\d+)?$/.test(s) ||
    /^[-+]?\.(inf|nan)$/i.test(s) ||
    /^[-+]?0x[0-9a-fA-F_]+$/.test(s) ||
    /^[-+]?0b[01_]+$/.test(s) ||
    /^[-+]?0o[0-7_]+$/.test(s);
  // A bare 'YYYY-MM-DD' (or full ISO timestamp) is parsed by YAML as the
  // !!timestamp type → a native Date object, NOT the string the Frontmatter type
  // promises. isoDate() emits exactly this for `updated:`/`date:`, so it must be
  // quoted or every note an agent writes corrupts its date field on next read.
  const looksDate = /^\d{4}-\d{2}-\d{2}([Tt ].*)?$/.test(s);
  // Comma is the item separator in the flow-style `[a, b, c]` arrays we emit —
  // an unquoted scalar containing a comma (e.g. an alias "Smith, John") would
  // split into multiple array elements on the next parse.
  if (
    s === '' ||
    // structural chars anywhere, OR a leading indicator (whitespace, '-', or '?'
    // — a value starting with '? ' is YAML's complex-mapping-key indicator and
    // silently corrupts the note), OR trailing whitespace.
    /[:#\[\]{}&*!|>'"%@`\n\r\t,]|[\x00-\x1f]|^[?\s-]|\s$/.test(s) ||
    /^(true|false|null|~)$/i.test(s) ||
    looksNumeric ||
    looksDate
  ) {
    return `"${s
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')
      // any remaining control char (NUL, \x01…) → \xNN so the double-quoted YAML
      // stays valid instead of embedding a raw control byte the parser rejects.
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, (c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'))}"`;
  }
  return s;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
}

// Emit a mapping as YAML BLOCK lines at `depth` (2 spaces/level). A nested map or an array whose
// items are maps/arrays is emitted as real YAML structure — NOT a quoted JSON string — so a human's
// structured frontmatter (`meta:`/nested `links:`/lists of objects) round-trips through an agent
// rewrite untouched, honouring the "never reformat your notes" promise and keeping Obsidian/schema
// queries working. Scalars still go through yamlValue's careful type-safe quoting.
function emitMapping(obj: Record<string, unknown>, depth: number): string[] {
  const pad = '  '.repeat(depth);
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    const key = yamlKey(k);
    if (v === null) {
      out.push(`${pad}${key}: null`);
    } else if (isPlainObject(v)) {
      const inner = emitMapping(v, depth + 1);
      if (inner.length) {
        out.push(`${pad}${key}:`);
        out.push(...inner);
      } else out.push(`${pad}${key}: {}`); // empty mapping round-trips as {}
    } else if (Array.isArray(v)) {
      out.push(...emitArray(key, v, depth));
    } else {
      out.push(`${pad}${key}: ${yamlValue(v)}`);
    }
  }
  return out;
}

// Emit an array as `key: [a, b, c]` flow style when every item is a scalar (compact, matches what
// humans write), or as a YAML block sequence when any item is a map/array (so lists-of-objects — and
// nested sequences of objects — survive instead of collapsing to a JSON string).
function emitArray(key: string, arr: unknown[], depth: number): string[] {
  const pad = '  '.repeat(depth);
  const items = arr.filter((x) => x !== undefined);
  const complex = items.some((x) => isPlainObject(x) || Array.isArray(x));
  if (!complex) return [`${pad}${key}: ${yamlValue(items)}`]; // flow style, via yamlValue's array branch
  const ipad = '  '.repeat(depth + 1);
  const out = [`${pad}${key}:`];
  for (const item of items) out.push(...emitSeqItem(item, ipad));
  return out;
}

// Emit ONE block-sequence item (a "- ..." line, plus continuation lines) at indent `ipad`. Recurses
// for maps AND for nested arrays that themselves contain maps/arrays — the case a flat handler would
// wrongly route through yamlValue's flow path and JSON-stringify. An all-scalar nested array stays
// compact flow (`- [a, b, c]`).
function emitSeqItem(item: unknown, ipad: string): string[] {
  if (isPlainObject(item)) {
    const inner = emitMapping(item, 0);
    if (!inner.length) return [`${ipad}- {}`];
    const out = [`${ipad}- ${inner[0]}`]; // first key sits on the "- " line
    for (let i = 1; i < inner.length; i++) out.push(`${ipad}  ${inner[i]}`); // remaining keys align under it
    return out;
  }
  if (Array.isArray(item)) {
    const sub = item.filter((x) => x !== undefined);
    if (!sub.some((x) => isPlainObject(x) || Array.isArray(x))) return [`${ipad}- ${yamlValue(sub)}`]; // scalar sub-array → flow
    const out = [`${ipad}-`]; // a nested block sub-sequence hangs under a bare dash
    for (const s of sub) out.push(...emitSeqItem(s, `${ipad}  `));
    return out;
  }
  if (item === null) return [`${ipad}- null`];
  return [`${ipad}- ${yamlValue(item)}`]; // scalar
}

export function serializeNote(note: Note): string {
  if (note.rawFile) return note.body;
  const lines = ['---', ...emitMapping(note.frontmatter as Record<string, unknown>, 0), '---', ''];
  const body = note.body.replace(/^\n/, '');
  return lines.join('\n') + body;
}

/** Today's date in the vault's `updated:` format (YYYY-MM-DD), in LOCAL time —
 *  toISOString() is UTC, so an evening write in a +offset timezone would stamp
 *  tomorrow's date (the same bug filing/engine.ts already avoids). */
export function isoDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
