# The reranker, and why it is gone

*Engine white paper section. Measured 25 July 2026 on the full 15,000-scenario CallosiumBench against a real 9,795-chunk brain.*

Callosium shipped a cross-encoder reranker (`Xenova/bge-reranker-base`, local ONNX, q8) as a second-stage precision pass. It ran after the honesty gate, scored (query, best-section) pairs for the top 15 fused candidates, and RRF-blended its ranking with fusion's. It is now removed. This section records why, in enough detail that nobody re-derives it.

## The headline

| | overall | p50 | p90 | p99 |
|---|---|---|---|---|
| reranker OFF (certified) | **96.4%** (14454/15000) | 50ms | 91ms | **143ms** |
| reranker ON (gated) | **94.0%** (14102/15000) | 51ms | 1732ms | **2439ms** |

Turning it on cost 2.4 points of accuracy and multiplied p99 latency by 17.

## Where it helped and where it hurt

Per-scenario diff of the two runs: **71 wins, 423 losses, net −352.**

| family | OFF | ON | delta | wins | losses |
|---|---|---|---|---|---|
| ambiguous:ar | 100.0% | 68.4% | **−31.6** | 0 | 166 |
| content:en | 95.6% | 87.0% | **−8.7** | 15 | 108 |
| content:ar | 94.8% | 86.9% | **−7.9** | 15 | 100 |
| compare:en | 95.1% | 92.4% | −2.7 | 0 | 19 |
| compare:ar | 93.9% | 92.1% | −1.7 | 0 | 12 |
| typo:ar | 92.5% | 93.3% | +0.8 | 19 | 10 |
| typo:en | 92.5% | 93.2% | +0.7 | 16 | 8 |
| negative:ar | 99.3% | 100.0% | +0.7 | 5 | 0 |
| known / temporal / richness / ambiguous:en | — | — | 0.0 | 0 | 0 |

Three mechanisms explain the whole table:

1. **Rare-body-word recall (`content`, −8pt).** These queries are won by a literal match on a rare term. The cross-encoder reads a 1,200-char section and judges *topical* relevance, which second-guesses a correct exact hit and demotes the right note. The reranker is solving a problem the lexical lane had already solved.
2. **Arabic ambiguity (`ambiguous:ar`, −31pt).** That family passes when the engine either fires a clarify prompt or surfaces ≥2 siblings in the top 5. The cross-encoder is *confident*: it breaks the near-tie the clarify logic depends on and scatters the sibling set out of the top 5, converting an honest "which one did you mean?" into one assertive pick. Clarify fire rate on ambiguous queries fell from 100% to 50%.
3. **Typos (+0.8pt), its one real win.** When a query token is mangled the lexical signal genuinely *is* corrupted, so a semantic read adds information. This is the only regime where a cross-encoder should help, and it does — just not nearly enough to pay for the rest.

The pattern is consistent: a reranker is a fix for a weak first-stage ranker. Callosium's first stage is not weak. At 96.4% there is very little for a second stage to correct, and plenty for it to break.

## Why the gate could not be narrowed

The obvious rescue is to fire only where it wins. We tested that properly rather than assuming.

The gate fired on **2,373 of 15,000 queries (15.8%)** — within that set, 69 wins against 387 losses. Every computable feature at the gate was captured for all 15,000 queries and joined to the flip set.

**The features carry no signal.** Wins and losses are statistically indistinguishable on everything the gate can see:

| | wins (n=71) | losses (n=422) |
|---|---|---|
| closeRace | 89% | 89% |
| median gateCov | 1.00 | 1.00 |
| median runner-up ratio | 0.98 | 0.98 |
| no literal filename match | 56% | 47% |

**Close-race and ambiguity are the same signal.** `closeRace` (runner-up ≥ 0.9× top) is a strict subset of the near-tie set the clarify path uses (≥ 0.88×): the band `closeRace AND nearTie < 2` contains **zero** scenarios. You cannot fire on close races without firing on the ambiguity cases the reranker destroys. The hypothesised "close-race multi-hop but not ambiguous" band does not exist.

**Latency sets a hard ceiling on fire rate.** p99 is the 14,850th of 15,000 sorted latencies. For a ~2.2s stage to leave p99 at the non-reranked ~143ms, it must fire on **fewer than 150 queries (<1%)** — a 94% cut from the current 15.8%.

**Exhaustive search finds nothing shippable.** We enumerated 23,100 gate bands over coverage × runner-up ratio × near-tie count × literal-match count (plus typo-correction state), scoring each on real per-scenario outcomes, capped at ≤150 fires. The single best band was `gateCov < 0.5 AND ratio ≥ 0.93`: 62 fires, 9 wins, 1 loss, **net +8 scenarios = +0.05pt → 96.41%**.

That band does not survive scrutiny:

- **It is 3 retrieval cases, not 9 wins.** Five of the nine are one Arabic nonsense-entity template repeated with five different numeric suffixes — identical coverage, identical ratio, identical candidate list. (The tokens are deliberately not reproduced here; see the ⚠️ rule below.) The other four are two target notes asked twice each (EN + AR phrasings).
- **Those five are not the cross-encoder working.** They are refusals. The reranker runs *after* the honesty gate and cannot cause one. They come from the `reranked` branch feeding a different candidate set to the clarify-refusal check — an accidental side effect, reproducible far more cheaply by changing that check directly.
- **It does not generalise.** Fit the search on half the scenarios and score the winner on the held-out half: one fold lands at **net −169**, the other fires 3 times. The band is an artifact of fitting.
- **The permutation test is misleading here.** Shuffling labels and re-running the full search yields max +5 (median +2), which scores the observed +8 at p=0.005 — but that test assumes independent samples, and the bench contains near-duplicate scenarios. Once collapsed to distinct retrieval cases the effect disappears.

Stripping the side-effect refusals, the best gate obtainable from 23,100 candidates genuinely improves **two** retrieval situations, at the cost of a 300MB model download and ~2.2s on the queries it touches.

**Even a perfect gate is not worth it.** An oracle that fires only on the 71 true wins reaches 96.83% (+0.47pt) — and still fires 71 times, so p99 remains ~2.4s. There is no version of this feature that clears "beat 96.4%, no family regressing >0.5pt, p99 well under 300ms."

## Decision

Retired rather than carried default-off. A disabled stage still costs: model provisioning and a 300MB download path, ONNX/`onnxruntime` behaviour across three OSes, version pinning, fail-open branches through the ranking code, and a second ordering that the clarify and confidence-label logic must both reason about. None of that is worth a feature measured at −2.4pt whose best possible narrow gate is worth two queries.

The honesty gate's position is unchanged and non-negotiable: it runs **before** any reordering, so a refusal is always judged on the original best lexical match. The reranker was deliberately placed after it — running it first was measured to collapse negatives-refused from 18.8% to 6.3% for +1.2pt of positives, and a confident false answer is the cardinal sin. Any future precision stage goes after the gate too.

## If this is revisited

The lever is not a better cross-encoder. It is the same lesson the embedding-model A/B produced (e5-base scored *worse* than e5-small on the same set): a bigger or better second-stage model cannot rescue what the first stage never surfaced, and it actively damages what the first stage already got right. Two things would change the calculus:

- **A first stage that is actually weak somewhere.** The typo family is the one such pocket. A cheap, typo-only precision pass (no 300MB cross-encoder) is the shape worth trying.
- **A latency budget that fits.** At ~2.2s/query on CPU, any stage firing above 1% of queries breaks the p99 target. A precision stage needs to be ~50ms to be gateable at useful volume.

## Reproducing these numbers

Run `test/run-bench-v2.mjs` against `test/scenarios-v4-current.json`; the OFF baseline is `test/gold/15k-offfix.json` and the ON run is `test/gold/15k-onfix.json`.

⚠️ **Never quote the bench's invented entities into the brain you benchmark against.** The `negative` family asserts that certain nonsense entities are *absent* from the corpus. An engine note that quotes one verbatim makes it present, and those scenarios then correctly stop refusing — the negative family collapses and the overall score falls with it. This bit during this very study: one research note quoting an invented entity cost **106 negative scenarios (−0.7pt overall) with zero code change**. Symptom to recognise: every family identical to baseline **except** `negative`. Describe the bench's fake entities; never reproduce the tokens.

Retirement was verified against exactly this hazard: the retired engine and HEAD-with-reranker-off were run back-to-back on the identical (contaminated) corpus and agreed on **all 15,000 scenarios** — 0 pass/fail differences, both 14348/15000. The change is also a provable no-op by inspection: with `reranked` permanently false, `!reranked && X` ≡ `X`, `reranked ? A : B` ≡ `B`, and `if (!reranked)` is unconditional.
