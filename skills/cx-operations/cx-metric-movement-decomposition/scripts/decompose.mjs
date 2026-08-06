#!/usr/bin/env node
/**
 * Decomposes a period-over-period move in an aggregate CX metric into a rate
 * effect, a mix effect, and the contribution of segments that entered or left.
 *
 * Uses the symmetric (average-weight) decomposition:
 *
 *   rate effect = Σ ((w0+w1)/2)(r1-r0)
 *   mix  effect = Σ (w1-w0)((r0+r1)/2)
 *
 * which sums to ΔR exactly, with no residual and no arbitrary base period. The
 * base-weighted alternative needs a third interaction term that nobody can
 * interpret and whose size depends on which period you called the base.
 *
 * Reports the noise interval first, because most metric movements people ask
 * about are not distinguishable from sampling error, and a driver narrative for
 * noise is worse than no answer.
 *
 * Usage:
 *   node decompose.mjs --input segments.json [--metric rate|mean]
 *                      [--format json|csv] [--label-0 "W30"] [--label-1 "W31"]
 *                      [--top N] [--confidence 0.95]
 */

import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
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

const metric = String(opt('metric', 'rate'));
if (metric !== 'rate' && metric !== 'mean') die('--metric must be "rate" or "mean"');

const format = String(opt('format', inputPath.endsWith('.csv') ? 'csv' : 'json'));
const label0 = String(opt('label-0', 'period 0'));
const label1 = String(opt('label-1', 'period 1'));
const topN = Number(opt('top', 10));
const confidence = Number(opt('confidence', 0.95));
if (!(confidence > 0 && confidence < 1)) die('--confidence must be between 0 and 1');

// Two-sided normal critical values for the confidence levels anyone actually
// asks for. Avoids shipping an inverse-normal implementation for three cases.
const Z = { 0.9: 1.6449, 0.95: 1.9600, 0.98: 2.3263, 0.99: 2.5758 };
const z = Z[confidence] ?? 1.96;

// ------------------------------------------------------------------- parsing

function parseCsv(text) {
  const lines = text.trim().split('\n').filter((l) => l.trim() !== '');
  if (lines.length < 2) die('csv input needs a header row and at least one data row');
  const headers = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(',').map((c) => c.trim());
    const row = {};
    headers.forEach((h, i) => {
      const raw = cells[i];
      if (raw === undefined || raw === '') return;
      row[h] = h === 'segment' ? raw : Number(raw);
    });
    return row;
  });
}

const raw = readFileSync(inputPath, 'utf8');
let rows;
if (format === 'csv') {
  rows = parseCsv(raw);
} else {
  try {
    rows = JSON.parse(raw);
  } catch (err) {
    die(`${inputPath} is not valid JSON — ${err.message}`);
  }
}
if (!Array.isArray(rows) || rows.length === 0) die('input must be a non-empty array of segments');

// -------------------------------------------------------------- normalisation

const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

/** Resolves a period's n and r for one segment, preferring counts over rates. */
function period(row, suffix) {
  const n = num(row[`n${suffix}`]);
  const k = num(row[`k${suffix}`]);
  let r = num(row[`r${suffix}`]);

  if (n === null || !Number.isFinite(n)) return null;
  if (n < 0) die(`segment "${row.segment}": n${suffix} cannot be negative`);
  if (n === 0) return null;

  if (k !== null && Number.isFinite(k)) {
    if (k < 0 || k > n) die(`segment "${row.segment}": k${suffix}=${k} must be between 0 and n${suffix}=${n}`);
    r = k / n;
  }
  if (r === null || !Number.isFinite(r)) {
    die(`segment "${row.segment}": needs r${suffix} or k${suffix} alongside n${suffix}`);
  }
  if (metric === 'rate' && (r < 0 || r > 1)) {
    die(
      `segment "${row.segment}": r${suffix}=${r} is outside 0..1. Rate mode expects proportions, not percentages — ` +
        'pass 0.91 rather than 91, or use --metric mean.',
    );
  }
  const sd = num(row[`sd${suffix}`]);
  return { n, r, k, sd };
}

const segments = rows.map((row) => {
  if (!row.segment) die('every row needs a `segment` label');
  return { segment: String(row.segment), p0: period(row, 0), p1: period(row, 1) };
});

const dupes = segments.map((s) => s.segment).filter((s, i, a) => a.indexOf(s) !== i);
if (dupes.length) die(`duplicate segment label(s): ${[...new Set(dupes)].join(', ')}`);

const both = segments.filter((s) => s.p0 && s.p1);
const entrants = segments.filter((s) => !s.p0 && s.p1);
const exits = segments.filter((s) => s.p0 && !s.p1);
if (segments.some((s) => !s.p0 && !s.p1)) die('a segment has no data in either period');
if (both.length === 0) die('no segment is present in both periods — there is nothing to decompose');

// ------------------------------------------------------------------ aggregates

const sum = (xs) => xs.reduce((a, b) => a + b, 0);

const N0 = sum(segments.filter((s) => s.p0).map((s) => s.p0.n));
const N1 = sum(segments.filter((s) => s.p1).map((s) => s.p1.n));
if (N0 === 0 || N1 === 0) die('one period has no observations at all');

const R0 = sum(segments.filter((s) => s.p0).map((s) => s.p0.n * s.p0.r)) / N0;
const R1 = sum(segments.filter((s) => s.p1).map((s) => s.p1.n * s.p1.r)) / N1;
const delta = R1 - R0;

// -------------------------------------------------------------- noise interval

let se = null;
let seNote = null;
if (metric === 'rate') {
  se = Math.sqrt((R0 * (1 - R0)) / N0 + (R1 * (1 - R1)) / N1);
  seNote =
    'Binomial approximation treating observations as independent. Repeated evaluations of the same agent are correlated, so the true interval is wider — treat a borderline result as noise.';
} else {
  const pooled = (suffix, key) => {
    const rowsWith = segments.filter((s) => s[key] && s[key].sd !== null && Number.isFinite(s[key].sd));
    if (rowsWith.length === 0) return null;
    const n = sum(rowsWith.map((s) => s[key].n));
    // Within-segment variance only; between-segment spread is the mix effect,
    // not sampling error in the aggregate.
    const ss = sum(rowsWith.map((s) => s[key].sd ** 2 * (s[key].n - 1)));
    return n > rowsWith.length ? ss / (n - rowsWith.length) : null;
  };
  const v0 = pooled(0, 'p0');
  const v1 = pooled(1, 'p1');
  if (v0 !== null && v1 !== null) {
    se = Math.sqrt(v0 / N0 + v1 / N1);
    seNote = 'Pooled within-segment variance. Supply sd0/sd1 on every segment for a complete interval.';
  } else {
    seNote = 'No sd0/sd1 supplied, so the movement cannot be tested against sampling noise. Supply them.';
  }
}

const moe = se === null ? null : z * se;
const isNoise = moe === null ? null : Math.abs(delta) < moe;

// ------------------------------------------------------------- decomposition

const contributions = both.map((s) => {
  const w0 = s.p0.n / N0;
  const w1 = s.p1.n / N1;
  const rateEffect = ((w0 + w1) / 2) * (s.p1.r - s.p0.r);
  const mixEffect = (w1 - w0) * ((s.p0.r + s.p1.r) / 2);
  return {
    segment: s.segment,
    n0: s.p0.n,
    n1: s.p1.n,
    share0: w0,
    share1: w1,
    r0: s.p0.r,
    r1: s.p1.r,
    rateChange: s.p1.r - s.p0.r,
    rateEffect,
    mixEffect,
    totalEffect: rateEffect + mixEffect,
  };
});

const entrantEffects = entrants.map((s) => ({
  segment: s.segment,
  kind: 'entrant',
  n1: s.p1.n,
  share1: s.p1.n / N1,
  r1: s.p1.r,
  totalEffect: (s.p1.n / N1) * s.p1.r,
}));

const exitEffects = exits.map((s) => ({
  segment: s.segment,
  kind: 'exit',
  n0: s.p0.n,
  share0: s.p0.n / N0,
  r0: s.p0.r,
  totalEffect: -(s.p0.n / N0) * s.p0.r,
}));

const rateEffectTotal = sum(contributions.map((c) => c.rateEffect));
const mixEffectTotal = sum(contributions.map((c) => c.mixEffect));
const compositionTotal = sum([...entrantEffects, ...exitEffects].map((c) => c.totalEffect));

// The identity holds exactly only when the same segments span both periods.
// With entrants or exits the shares are drawn from different universes, so we
// report the reconciliation gap rather than pretending it closes.
const accounted = rateEffectTotal + mixEffectTotal + compositionTotal;
const residual = delta - accounted;

const ranked = [...contributions, ...entrantEffects, ...exitEffects].sort(
  (a, b) => Math.abs(b.totalEffect) - Math.abs(a.totalEffect),
);

// ------------------------------------------------------------------- reporting

const pp = (x) => (x === null ? 'n/a' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}`);
const pct = (x) => `${(x * 100).toFixed(1)}%`;

console.error(`${label0}: ${metric === 'rate' ? pct(R0) : R0.toFixed(3)} (n=${N0})`);
console.error(`${label1}: ${metric === 'rate' ? pct(R1) : R1.toFixed(3)} (n=${N1})`);
console.error(`change: ${pp(delta)} ${metric === 'rate' ? 'points' : 'units'}`);
console.error('');

if (isNoise === null) {
  console.error(`NOISE CHECK  not run — ${seNote}`);
} else if (isNoise) {
  console.error(
    `NOISE CHECK  the movement of ${pp(delta)} is INSIDE the ${pct(confidence)} interval of ±${pp(moe).replace('+', '')}.`,
  );
  console.error('             This movement is not distinguishable from sampling error. Do not explain it.');
} else {
  console.error(
    `NOISE CHECK  the movement of ${pp(delta)} exceeds the ${pct(confidence)} interval of ±${pp(moe).replace('+', '')} — treat as real.`,
  );
}
console.error('');
console.error(`rate effect        ${pp(rateEffectTotal)}   (segments performing differently)`);
console.error(`mix effect         ${pp(mixEffectTotal)}   (volume shifting between segments)`);
if (entrantEffects.length || exitEffects.length) {
  console.error(`composition        ${pp(compositionTotal)}   (${entrantEffects.length} entrant(s), ${exitEffects.length} exit(s))`);
}
if (Math.abs(residual) > 1e-9) {
  console.error(`unreconciled       ${pp(residual)}   (entrants/exits shift both universes; see notes)`);
}
console.error('');
console.error(`top contributors by absolute effect (of ${ranked.length}):`);
for (const c of ranked.slice(0, topN)) {
  const detail =
    c.kind === 'entrant'
      ? `entered at ${pct(c.share1)} of mix, ${metric === 'rate' ? pct(c.r1) : c.r1.toFixed(3)}`
      : c.kind === 'exit'
        ? `left, was ${pct(c.share0)} of mix`
        : `share ${pct(c.share0)}->${pct(c.share1)}, rate ${pp(c.rateChange)}`;
  console.error(`  ${pp(c.totalEffect).padStart(7)}  ${c.segment.padEnd(24)} ${detail}`);
}

const output = {
  metric,
  labels: { period0: label0, period1: label1 },
  aggregate: { r0: R0, r1: R1, n0: N0, n1: N1, delta },
  noise: { standardError: se, confidence, marginOfError: moe, withinNoise: isNoise, note: seNote },
  effects: {
    rate: rateEffectTotal,
    mix: mixEffectTotal,
    composition: compositionTotal,
    unreconciled: residual,
  },
  segments: contributions,
  entrants: entrantEffects,
  exits: exitEffects,
  notes: [
    'Symmetric decomposition: rate = Σ((w0+w1)/2)(r1-r0), mix = Σ(w1-w0)((r0+r1)/2).',
    'Rate and mix sum to the aggregate change exactly when the same segments span both periods.',
    'Entrants and exits are reported separately; they have no counterpart rate, so they cannot appear in a rate effect. Their presence also changes both periods\' shares, which is what `unreconciled` captures.',
    'This decomposition describes arithmetic, not causation. A large mix effect says volume moved, not why.',
    'It cannot see a coverage change: if which items got measured shifted, the segment rates themselves are affected. Compare measured composition against eligible composition separately.',
  ],
};

console.log(JSON.stringify(output, null, 2));
