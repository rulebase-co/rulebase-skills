#!/usr/bin/env node
/**
 * Computes grader agreement for support QA between exactly two graders, and
 * separates systematic severity (bias) from unpredictable disagreement (noise).
 *
 * Reports raw agreement, Cohen's kappa AND Gwet's AC1 together, because QA data
 * has extreme prevalence — most criteria pass most of the time — and that is
 * precisely where kappa's chance-correction term explodes. The same data can
 * give kappa = -0.05 and AC1 = 0.89. Reporting either alone is misleading.
 *
 * Usage:
 *   node agreement.mjs --input verdicts.jsonl
 *   node agreement.mjs --input v.jsonl --ordinal not_met,partial,met --by channel
 *   node agreement.mjs --input v.jsonl --ordinal fail,pass --weights quadratic
 *
 *   --label-a / --label-b   Names for the graders in output.
 *   --bootstrap N           Bootstrap resamples for intervals. Default 2000.
 *   --seed N                Bootstrap seed, so reruns match. Default 42.
 *   --min-cell N            Suppress breakdowns below N items. Default 20.
 */

import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
function opt(name, fallback = undefined) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) return true;
  return v;
}
const die = (msg) => {
  console.error(`error: ${msg}`);
  process.exit(2);
};

const inputPath = opt('input');
if (!inputPath || inputPath === true) die('--input <file> is required');

const labelA = String(opt('label-a', 'rater_a'));
const labelB = String(opt('label-b', 'rater_b'));
const bootstrapN = Number(opt('bootstrap', 2000));
const seed = Number(opt('seed', 42));
const minCell = Number(opt('min-cell', 20));
const byField = opt('by');
const segmentField = byField && byField !== true ? String(byField) : null;

const ordinalArg = opt('ordinal');
const ordinal = ordinalArg && ordinalArg !== true ? String(ordinalArg).split(',').map((s) => s.trim()) : null;
if (ordinal && ordinal.length < 2) die('--ordinal needs at least two comma-separated categories, lowest first');

const weightsArg = String(opt('weights', ordinal ? 'linear' : 'none'));
if (!['none', 'linear', 'quadratic'].includes(weightsArg)) die('--weights must be none, linear or quadratic');
if (weightsArg !== 'none' && !ordinal) die('--weights requires --ordinal, since weighting needs a category order');

// ------------------------------------------------------------------- input

const raw = readFileSync(inputPath, 'utf8').trim();
let records;
if (raw.startsWith('[')) {
  try {
    records = JSON.parse(raw);
  } catch (err) {
    die(`${inputPath} is not valid JSON — ${err.message}`);
  }
} else {
  records = raw
    .split('\n')
    .map((l, i) => ({ line: i + 1, text: l.trim() }))
    .filter((r) => r.text !== '')
    .map((r) => {
      try {
        return JSON.parse(r.text);
      } catch (err) {
        die(`${inputPath}:${r.line} is not valid JSON — ${err.message}`);
      }
    });
}
if (!Array.isArray(records) || records.length === 0) die('input has no records');

const blank = (v) => v === undefined || v === null || v === '';
const excluded = records.filter((r) => blank(r.rater_a) || blank(r.rater_b));
const items = records
  .filter((r) => !blank(r.rater_a) && !blank(r.rater_b))
  .map((r, i) => ({
    id: String(r.id ?? i + 1),
    a: String(r.rater_a),
    b: String(r.rater_b),
    criterion: r.criterion === undefined ? null : String(r.criterion),
    segment: segmentField ? String(r[segmentField] ?? '(unset)') : null,
  }));

if (items.length === 0) die('no records have both verdicts');

// Category universe. With --ordinal, unknown labels are an error rather than a
// silent append, because an unrecognised label would break the severity order.
let categories;
if (ordinal) {
  categories = ordinal;
  const known = new Set(ordinal);
  const unknown = new Set();
  for (const it of items) {
    if (!known.has(it.a)) unknown.add(it.a);
    if (!known.has(it.b)) unknown.add(it.b);
  }
  if (unknown.size) {
    die(`verdict(s) not in --ordinal: ${[...unknown].join(', ')}. Add them in the right position or drop --ordinal.`);
  }
} else {
  categories = [...new Set(items.flatMap((it) => [it.a, it.b]))].sort();
}
const q = categories.length;
const index = new Map(categories.map((c, i) => [c, i]));

// ------------------------------------------------------------------ weights

function weight(i, j) {
  if (weightsArg === 'none') return i === j ? 1 : 0;
  const d = Math.abs(i - j) / (q - 1);
  return weightsArg === 'linear' ? 1 - d : 1 - d * d;
}
const W = Array.from({ length: q }, (_, i) => Array.from({ length: q }, (_, j) => weight(i, j)));

// --------------------------------------------------------------- statistics

/** Observed and both chance-corrected coefficients from a set of items. */
function coefficients(set) {
  const n = set.length;
  if (n === 0) return null;

  const O = Array.from({ length: q }, () => new Array(q).fill(0));
  for (const it of set) O[index.get(it.a)][index.get(it.b)] += 1;

  let po = 0;
  for (let i = 0; i < q; i++) for (let j = 0; j < q; j++) po += W[i][j] * O[i][j];
  po /= n;

  const rowMarg = O.map((row) => row.reduce((a, b) => a + b, 0) / n);
  const colMarg = Array.from({ length: q }, (_, j) => O.reduce((s, row) => s + row[j], 0) / n);

  // Cohen: chance from the product of each grader's own marginals.
  let peK = 0;
  for (let i = 0; i < q; i++) for (let j = 0; j < q; j++) peK += W[i][j] * rowMarg[i] * colMarg[j];

  // Gwet AC1: chance from the averaged marginal, which stays bounded under
  // extreme prevalence.
  const pi = Array.from({ length: q }, (_, k) => (rowMarg[k] + colMarg[k]) / 2);
  let peG = 0;
  for (let k = 0; k < q; k++) peG += pi[k] * (1 - pi[k]);
  peG /= q - 1;

  const coef = (pe) => (1 - pe === 0 ? null : (po - pe) / (1 - pe));

  return {
    n,
    observedAgreement: po,
    cohenKappa: coef(peK),
    gwetAC1: coef(peG),
    chance: { cohen: peK, gwet: peG },
    marginals: Object.fromEntries(categories.map((c, k) => [c, { [labelA]: rowMarg[k], [labelB]: colMarg[k] }])),
    matrix: { categories, counts: O },
  };
}

/** Which grader was harsher, among disagreements. Needs an ordinal scale. */
function asymmetry(set) {
  if (!ordinal) return null;
  let aHarsher = 0;
  let bHarsher = 0;
  for (const it of set) {
    const ia = index.get(it.a);
    const ib = index.get(it.b);
    if (ia < ib) aHarsher += 1;
    else if (ib < ia) bHarsher += 1;
  }
  const d = aHarsher + bHarsher;
  return {
    disagreements: d,
    [`${labelA}_harsher`]: aHarsher,
    [`${labelB}_harsher`]: bHarsher,
    pValue: d === 0 ? null : exactBinomialTwoSided(Math.max(aHarsher, bHarsher), d),
  };
}

/** Exact two-sided binomial test against p=0.5. */
function exactBinomialTwoSided(k, n) {
  // Σ over outcomes at least as extreme as k, doubled and capped at 1.
  const logFact = [0];
  for (let i = 1; i <= n; i++) logFact[i] = logFact[i - 1] + Math.log(i);
  const logChoose = (a, b) => logFact[a] - logFact[b] - logFact[a - b];
  let tail = 0;
  for (let i = k; i <= n; i++) tail += Math.exp(logChoose(n, i) - n * Math.log(2));
  return Math.min(1, 2 * tail);
}

/** mulberry32 — small, well-distributed, and seeded so reruns are identical. */
function rng(s) {
  let t = s >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** Nonparametric bootstrap over items. Analytic SEs for kappa are unreliable
 *  at the prevalences and sample sizes QA calibration actually uses. */
function bootstrapCi(set, key) {
  if (set.length < 5 || bootstrapN <= 0) return { low: null, high: null };
  const rand = rng(seed);
  const draws = [];
  for (let b = 0; b < bootstrapN; b++) {
    const sample = new Array(set.length);
    for (let i = 0; i < set.length; i++) sample[i] = set[(rand() * set.length) | 0];
    const c = coefficients(sample);
    const v = c?.[key];
    if (v !== null && v !== undefined && Number.isFinite(v)) draws.push(v);
  }
  if (draws.length < 20) return { low: null, high: null };
  draws.sort((x, y) => x - y);
  const pick = (p) => draws[Math.min(draws.length - 1, Math.max(0, Math.round(p * (draws.length - 1))))];
  return { low: pick(0.025), high: pick(0.975) };
}

/** Max marginal share — the paradox condition when it is extreme. */
function maxPrevalence(c) {
  return Math.max(...Object.values(c.marginals).map((m) => (m[labelA] + m[labelB]) / 2));
}

function diagnose(c, asym) {
  const prev = maxPrevalence(c);
  const gap = Math.max(
    ...Object.values(c.marginals).map((m) => Math.abs(m[labelA] - m[labelB])),
  );
  const paradox = prev > 0.85 && c.cohenKappa !== null && c.gwetAC1 !== null && c.gwetAC1 - c.cohenKappa > 0.2;
  const biased = (asym && asym.pValue !== null && asym.pValue < 0.05) || gap > 0.05;
  const strong = (c.gwetAC1 ?? 0) >= 0.7;

  if (paradox) {
    return {
      verdict: 'kappa-paradox',
      maxPrevalence: prev,
      marginalGap: gap,
      reading:
        'Kappa is uninterpretable here: one category dominates. Trust AC1. The real finding is that this criterion rarely varies, which is a scorecard-design issue rather than an agreement problem.',
    };
  }
  if (strong && !biased) {
    return { verdict: 'agreement-ok', maxPrevalence: prev, marginalGap: gap, reading: 'Working. Monitor at cadence.' };
  }
  if (strong && biased) {
    return {
      verdict: 'bias',
      maxPrevalence: prev,
      marginalGap: gap,
      reading:
        'They rank items alike but one threshold is harsher. Recalibrate the threshold or adjudicate; rewriting the criterion will not close a marginal gap.',
    };
  }
  if (!strong && biased) {
    return {
      verdict: 'bias-and-noise',
      maxPrevalence: prev,
      marginalGap: gap,
      reading: 'Both problems. Fix the criterion first, then re-measure before touching thresholds.',
    };
  }
  return {
    verdict: 'noise',
    maxPrevalence: prev,
    marginalGap: gap,
    reading:
      'Unpredictable disagreement in both directions. The criterion is ambiguous — rewrite it as an observable decision rule. This is a specification bug, not a grader problem.',
  };
}

// -------------------------------------------------------------------- run

function analyse(set) {
  const c = coefficients(set);
  if (!c) return null;
  const asym = asymmetry(set);
  return {
    ...c,
    asymmetry: asym,
    ci95: { cohenKappa: bootstrapCi(set, 'cohenKappa'), gwetAC1: bootstrapCi(set, 'gwetAC1') },
    diagnosis: diagnose(c, asym),
  };
}

function group(set, keyFn) {
  const m = new Map();
  for (const it of set) {
    const k = keyFn(it);
    if (k === null) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(it);
  }
  return m;
}

const overall = analyse(items);

const byCriterion = [...group(items, (it) => it.criterion).entries()]
  .map(([name, set]) => ({
    criterion: name,
    ...(set.length >= minCell
      ? analyse(set)
      : { n: set.length, suppressed: true, reason: `below --min-cell ${minCell}` }),
  }))
  .sort((x, y) => (x.gwetAC1 ?? 2) - (y.gwetAC1 ?? 2));

const bySegment = segmentField
  ? [...group(items, (it) => it.segment).entries()]
      .map(([name, set]) => ({
        segment: name,
        ...(set.length >= minCell
          ? analyse(set)
          : { n: set.length, suppressed: true, reason: `below --min-cell ${minCell}` }),
      }))
      .sort((x, y) => (x.gwetAC1 ?? 2) - (y.gwetAC1 ?? 2))
  : [];

// Differential reliability across segments is a fairness finding that outranks
// the headline number, so surface it explicitly.
const assessed = bySegment.filter((s) => !s.suppressed && s.gwetAC1 !== null);
const differential =
  assessed.length >= 2
    ? (() => {
        const vals = assessed.map((s) => s.gwetAC1);
        const spread = Math.max(...vals) - Math.min(...vals);
        return {
          spread,
          material: spread > 0.15,
          weakest: assessed[0].segment,
          strongest: assessed[assessed.length - 1].segment,
        };
      })()
    : null;

// ---------------------------------------------------------------- reporting

const f3 = (x) => (x === null || x === undefined ? 'n/a' : x.toFixed(3));
const pctf = (x) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`);

console.error(`${items.length} item(s) with both verdicts${excluded.length ? `, ${excluded.length} excluded for a missing verdict` : ''}`);
console.error(`categories: ${categories.join(' < ')}${ordinal ? ' (ordinal)' : ' (nominal)'}, weights: ${weightsArg}`);
console.error('');
console.error(`raw agreement      ${pctf(overall.observedAgreement)}`);
console.error(
  `Cohen's kappa      ${f3(overall.cohenKappa)}   [${f3(overall.ci95.cohenKappa.low)}, ${f3(overall.ci95.cohenKappa.high)}]`,
);
console.error(
  `Gwet's AC1         ${f3(overall.gwetAC1)}   [${f3(overall.ci95.gwetAC1.low)}, ${f3(overall.ci95.gwetAC1.high)}]`,
);
console.error('');
console.error('marginals:');
for (const [cat, m] of Object.entries(overall.marginals)) {
  console.error(`  ${cat.padEnd(14)} ${labelA} ${pctf(m[labelA]).padStart(7)}   ${labelB} ${pctf(m[labelB]).padStart(7)}`);
}
if (overall.asymmetry) {
  const a = overall.asymmetry;
  console.error('');
  console.error(
    `disagreements      ${a.disagreements}  (${labelA} harsher ${a[`${labelA}_harsher`]}, ${labelB} harsher ${a[`${labelB}_harsher`]}, p=${
      a.pValue === null ? 'n/a' : a.pValue.toFixed(4)
    })`,
  );
}
console.error('');
console.error(`DIAGNOSIS  ${overall.diagnosis.verdict}`);
console.error(`           ${overall.diagnosis.reading}`);

if (byCriterion.length > 1) {
  console.error('');
  console.error('by criterion (worst first):');
  for (const c of byCriterion) {
    if (c.suppressed) {
      console.error(`  ${String(c.criterion).padEnd(24)} n=${String(c.n).padEnd(5)} suppressed (${c.reason})`);
    } else {
      console.error(
        `  ${String(c.criterion).padEnd(24)} n=${String(c.n).padEnd(5)} AC1 ${f3(c.gwetAC1)}  k ${f3(c.cohenKappa)}  ${c.diagnosis.verdict}`,
      );
    }
  }
}

if (segmentField && bySegment.length) {
  console.error('');
  console.error(`by ${segmentField} (worst first):`);
  for (const s of bySegment) {
    if (s.suppressed) {
      console.error(`  ${s.segment.padEnd(24)} n=${String(s.n).padEnd(5)} suppressed (${s.reason})`);
    } else {
      console.error(`  ${s.segment.padEnd(24)} n=${String(s.n).padEnd(5)} AC1 ${f3(s.gwetAC1)}  ${s.diagnosis.verdict}`);
    }
  }
  if (differential?.material) {
    console.error('');
    console.error(
      `FAIRNESS   AC1 spans ${differential.spread.toFixed(3)} across ${segmentField} (weakest "${differential.weakest}", strongest "${differential.strongest}").`,
    );
    console.error(
      '           The instrument is materially less reliable in some segments, so scores are not comparable across them until fixed.',
    );
  }
}

console.log(
  JSON.stringify(
    {
      labels: { a: labelA, b: labelB },
      categories,
      ordinal: Boolean(ordinal),
      weights: weightsArg,
      itemCount: items.length,
      excludedForMissingVerdict: excluded.length,
      overall,
      byCriterion,
      segmentedBy: segmentField,
      bySegment,
      differentialReliability: differential,
      notes: [
        "Cohen's kappa and Gwet's AC1 are both reported because QA prevalence is extreme. Where one category exceeds ~85%, kappa is uninterpretable rather than bad — trust AC1.",
        'Raw agreement is never sufficient: at a 95% pass rate two independent random graders agree about 90% of the time.',
        'Agreement is symmetric and says nothing about which grader is correct. Accuracy against a reference standard is a different question needing defined ground truth.',
        'Handles exactly two graders. For a panel use Fleiss kappa or Krippendorff alpha.',
        'No statistic here repairs selection bias. If items did not enter the sample at random, report how they did.',
        'Intervals are a seeded nonparametric bootstrap over items.',
      ],
    },
    null,
    2,
  ),
);
