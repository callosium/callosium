// Shared query/document tokenization. Filler is discarded here — the
// vocabulary of ASKING ("tell me", "find the note on") must carry zero
// ranking weight or chatty logs outrank the actual notes.

const STOP = new Set(
  ('a an and are as at be but by did do does for from had has have how i in is it its me my of on or our ' +
    're so that the their them then there these they this to us was we what when where which who why will with you your ' +
    'used use uses using talk talked about last week month year say said know need want get got ' +
    'tell find show give remind remember recall note notes info details detail anything something ' +
    'mention mentioned ever thing stuff look check search bring pull whats again please kindly ' +
    // Arabic stop-words + question-filler (same principle: the vocabulary of
    // asking carries no content signal)
    'في من على إلى الى عن أن ان هذا هذه ذلك التي الذي كان كانت هل ما ماذا لما لماذا متى أين اين وين كيف ' +
    'مع بعد قبل عند لقد قد كل بين تم يتم او أو ثم حتى اذا إذا لكن لا نعم شو ايش وش هو هي انا أنا انت أنت ' +
    'تتذكر تذكر ذكرني اعطني أعطني ورجع رجعلي ورجعلي ابغى أبغى ابي بدي عايز عاوز قولي وريني بخصوص الوضع قلنا قلت ' +
    // temporal/colloquial filler — absent from a mostly-English corpus, these
    // were tripping the honesty gate on Arabic questions
    'امس أمس اليوم البارح البارحة سوينا وقفنا صار يصير شي حاجة موضوع وضع خبر جديد اخر آخر اخير أخير مؤخرا مؤخراً ملف اراجع أراجع قارن الفرق كامل لحد هالاسبوع هالشهر').split(' '),
);

export function tokenize(q: string): string[] {
  // Drop HTML comments before anything else — Callosium's invisible per-block
  // attribution markers (<!-- ✍ written by X on DATE -->) carry real words that
  // would otherwise be indexed as note content and skew recall. A no-op for
  // queries (they never contain comments).
  q = q.replace(/<!--[\s\S]*?-->/g, ' ');
  // Arabic PUNCTUATION (؟ ؛ ، ۔ ٪) lives inside the ؀-ۿ block — strip it
  // before splitting or "callosium؟" becomes one unknown token and the
  // honesty gate refuses the whole question.
  // Fold Arabic-Indic (٠-٩) and Extended (۰-۹) digits to ASCII so \d tests and
  // combo-token/date detection work — otherwise Arabic numerals survive as
  // their own tokens but never match \d, and get dropped or mis-gated.
  const foldDigits = (t: string) =>
    t.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  // Split on a Unicode-aware "not a letter/number" class rather than a
  // hand-enumerated a-z0-9 + Arabic-block range. The old class treated ANY
  // other script's letters (accented Latin é/ü/ñ, Cyrillic, Hebrew, CJK…) as
  // separators, shredding e.g. "Zürich" → ["z","rich"] and leaving a bogus
  // "rich" term that defeated the honesty gate. Tatweel (U+0640) is an in-word
  // stretch character (category Lm, so \p{L}) — strip it to '' first so
  // "محـمد" collapses to "محمد" instead of surviving as its own fused token.
  const raw = foldDigits(q.normalize('NFC').toLowerCase())
    .replace(/ـ/g, '')
    // Arabic tashkeel (harakat) are OPTIONAL vocalization marks: قَرَار and قرار are the
    // same word, and a vault mixes both freely (a pasted Quran/poetry line is vocalized,
    // a typed note is not). Strip them so the two forms produce identical tokens.
    // U+064B-065F fathatan..marks, U+0670 superscript alef, U+06D6-06ED Quranic marks.
    // NOT the same as the \p{M} class below: these are decoration, whereas an Indic
    // matra changes the word and must survive.
    .replace(/[ً-ٰٟۖ-ۭ]/g, '')
    .replace(/[؟؛،۔٪٬]/g, ' ')
    // Ordinal dates: "16th of july" must meet "Session 16 July" — strip the
    // English ordinal suffix from NUMBERS only ("16th"→"16", "3rd"→"3";
    // words like "worth"/"first" are untouched by the \d requirement).
    .replace(/\b(\d+)(?:st|nd|rd|th)\b/g, '$1')
    // \p{M} (combining marks) belongs with the letters, not with the separators. Without
    // it every remaining mark acted as a word boundary and shredded the word around it —
    // Hebrew niqqud and Indic matras came out as fragments, and a Devanagari word split
    // at every vowel sign. Arabic is already handled above by stripping tashkeel; this
    // keeps every OTHER script's marks attached to the base letter they modify.
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const w = raw[i];
    // Pure single DIGITS survive (days 1-9: "5th of july" strips to "5", and
    // dropping it made every early-month date query land on the wrong day —
    // idf keeps lone digits from carrying weight where they shouldn't).
    // Single LETTERS stay dropped except as part of the combo rule below.
    if ((w.length > 1 || /^\d$/.test(w)) && !STOP.has(w)) out.push(w);
    // "phase 2", "top 5": alpha word + short number is one rare term
    if (/^\p{L}+$/u.test(w) && !STOP.has(w) && i + 1 < raw.length && /^\d{1,3}$/.test(raw[i + 1])) {
      out.push(w + ' ' + raw[i + 1]);
    }
  }
  return out;
}

// Date-ish tokens LOCATE a note via its filename/path but rarely appear in
// its body — they count for scoring and are excluded from coverage
// verification.
export const MONTHS_SET = new Set(
  ('jan feb mar apr may jun jul aug sep oct nov dec january february march april june july august september october november december ' +
    'يناير فبراير مارس أبريل ابريل مايو يونيو يوليو أغسطس اغسطس سبتمبر أكتوبر اكتوبر نوفمبر ديسمبر').split(' '),
);
// NB: \w is ASCII-only — an Arabic combo token ("مرحلة 2") would never match
// and would stay in the strict coverage set, over-tightening the honesty gate
// for Arabic. Script-aware class matches tokenize()'s own combo-token rule.
// \d{1,3} (not \d{1,2}) so standalone 3-digit numbers get the same lenient
// treatment as the "word 250" combo they can split from.
export const isDateish = (w: string) => /^(\d{1,3}|\d{4})$/.test(w) || MONTHS_SET.has(w) || /^\p{L}+ \d{1,3}$/u.test(w);

// Episodic intent: the user is explicitly recalling past conversations —
// archived memory records are NOT demoted for these.
export const EPISODIC_RE = /(discussed?|conversation|memor(y|ies)|remember|talked|chat(ted)?|we (said|spoke)|did we)/i;
