#!/usr/bin/env node
/**
 * Sweeps candidate SLA thresholds over a set of per-conversation clocks and
 * reports attainment with correct handling of unresolved (right-censored)
 * conversations.
 *
 * The point of the script is the censoring: an open conversation whose clock has
 * already passed the threshold is a *certain* breach, and only an open
 * conversation still inside the threshold is genuinely unknown. Dropping open
 * conversations — the usual approach — biases attainment upward, because being
 * slow is why they are still open.
 *
 * Business-hours conversion and spam exclusion happen upstream; this script sees
 * one elapsed number per conversation and cannot know your schedule.
 *
 * Usage:
 *   node simulate-sla.mjs --input clocks.jsonl --thresholds 60,120,240,480
 *   node simulate-sla.mjs --input clocks.json --sweep 30:600:30 --by priority
 *   node simulate-sla.mjs --input clocks.jsonl --thresholds 120 --target 0.9
 *
 *   --unit minutes|hours   Units of --thresholds/--sweep. Default minutes.
 *   --target A             Also report how many tickets must be faster to reach A.
 *   --max-marginal N       Cap breaching ids listed per threshold. Default 20.
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

const unit = String(opt('unit', 'minutes'));
if (unit !== 'minutes' && unit !== 'hours') die('--unit must be "minutes" or "hours"');
const unitScale = unit === 'hours' ? 60 : 1;

const by = opt('by');
const segmentField = by && by !== true ? String(by) : null;
const maxMarginal = Number(opt('max-marginal', 20));
const targetRaw = opt('target');
const target = targetRaw === undefined ? null : Number(targetRaw);
if (target !== null && !(target > 0 && target <= 1)) die('--target must be a proportion between 0 and 1');

// --- thresholds ---

let thresholds = [];
const thresholdsArg = opt('thresholds');
const sweepArg = opt('sweep');

if (thresholdsArg && thresholdsArg !== true) {
  thresholds = String(thresholdsArg)
    .split(',')
    .map((s) => Number(s.trim()) * unitScale);
} else if (sweepArg && sweepArg !== true) {
  const [min, max, step] = String(sweepArg).split(':').map(Number);
  if (![min, max, step].every(Number.isFinite) || step <= 0 || max < min) {
    die('--sweep must look like min:max:step, e.g. 30:600:30');
  }
  for (let t = min; t <= max; t += step) thresholds.push(t * unitScale);
} else {
  die('one of --thresholds <a,b,c> or --sweep <min:max:step> is required');
}
if (thresholds.some((t) => !Number.isFinite(t) || t <= 0)) die('thresholds must be positive numbers');
thresholds = [...new Set(thresholds)].sort((a, b) => a - b);

// --- input ---

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

const clocks = records.map((r, i) => {
  const elapsed = Number(r.elapsed_minutes);
  if (!Number.isFinite(elapsed) || elapsed < 0) {
    die(`record ${i + 1} (${r.id ?? 'no id'}): elapsed_minutes must be a non-negative number`);
  }
  if (typeof r.resolved !== 'boolean') {
    die(
      `record ${i + 1} (${r.id ?? 'no id'}): \`resolved\` must be true or false. ` +
        'Omitting it would silently drop censored conversations, which is the bias this script exists to avoid.',
    );
  }
  return {
    id: String(r.id ?? i + 1),
    elapsed,
    resolved: r.resolved,
    segment: segmentField ? String(r[segmentField] ?? '(unset)') : 'all',
  };
});

// --- statistics ---

const Z = 1.96;

/**
 * Wilson score interval. Preferred over the normal approximation because
 * attainment figures sit near 1, where the normal interval overshoots past 100%
 * and understates uncertainty on small n.
 */
function wilson(successes, n) {
  if (n === 0) return { low: null, high: null };
  const p = successes / n;
  const denom = 1 + (Z * Z) / n;
  const center = (p + (Z * Z) / (2 * n)) / denom;
  const half = (Z / denom) * Math.sqrt((p * (1 - p)) / n + (Z * Z) / (4 * n * n));
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Classifies one clock against a threshold.
 *
 *   resolved  && elapsed <= T  -> met
 *   resolved  && elapsed >  T  -> breach
 *   !resolved && elapsed >  T  -> breach   (certain; already blown)
 *   !resolved && elapsed <= T  -> unknown  (may still make it)
 */
function classify(clock, T) {
  // Past the threshold is a breach either way: a resolved conversation missed it,
  // and an open one has already missed it regardless of when it eventually closes.
  if (clock.elapsed > T) return 'breach';
  return clock.resolved ? 'met' : 'unknown';
}

function evaluate(set, T) {
  let met = 0;
  let breach = 0;
  let unknown = 0;
  const marginal = [];

  for (const c of set) {
    const verdict = classify(c, T);
    if (verdict === 'met') met += 1;
    else if (verdict === 'unknown') unknown += 1;
    else {
      breach += 1;
      if (marginal.length < maxMarginal) marginal.push({ id: c.id, elapsed: c.elapsed, resolved: c.resolved });
    }
  }

  const n = set.length;
  const decided = met + breach;
  const attainmentDecided = decided === 0 ? null : met / decided;
  const ci = decided === 0 ? { low: null, high: null } : wilson(met, decided);

  const result = {
    thresholdMinutes: T,
    n,
    met,
    breach,
    unknown,
    decided,
    unknownShare: n === 0 ? null : unknown / n,
    attainmentDecided,
    attainmentLower: n === 0 ? null : met / n,
    attainmentUpper: n === 0 ? null : (met + unknown) / n,
    ci95: ci,
    marginalBreaches: marginal,
    marginalTruncated: breach > marginal.length ? breach - marginal.length : 0,
  };

  if (target !== null && n > 0) {
    // How many currently-breaching conversations would have had to finish inside
    // T for the target attainment to be met, counting unknowns pessimistically.
    const needed = Math.ceil(target * n) - met;
    result.toReachTarget = { target, additionalWithinThreshold: Math.max(0, needed) };
  }

  return result;
}

// --- run ---

const bySegment = new Map();
for (const c of clocks) {
  if (!bySegment.has(c.segment)) bySegment.set(c.segment, []);
  bySegment.get(c.segment).push(c);
}

const elapsedAll = clocks.map((c) => c.elapsed).sort((a, b) => a - b);
const censoredShare = clocks.filter((c) => !c.resolved).length / clocks.length;

const distribution = {
  n: clocks.length,
  censored: clocks.filter((c) => !c.resolved).length,
  censoredShare,
  // Percentiles over resolved conversations only: an unresolved clock is a lower
  // bound on its final time, so mixing them in understates the tail.
  resolvedOnly: (() => {
    const r = clocks.filter((c) => c.resolved).map((c) => c.elapsed).sort((a, b) => a - b);
    return { n: r.length, p50: quantile(r, 0.5), p90: quantile(r, 0.9), p95: quantile(r, 0.95) };
  })(),
};

const fmtPct = (x) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const fmtT = (m) => (unit === 'hours' ? `${(m / 60).toFixed(m % 60 === 0 ? 0 : 1)}h` : `${m}m`);

console.error(`${clocks.length} conversation(s), ${distribution.censored} still open (${fmtPct(censoredShare)})`);
console.error(
  `resolved percentiles: p50 ${fmtT(distribution.resolvedOnly.p50 ?? 0)}, p90 ${fmtT(
    distribution.resolvedOnly.p90 ?? 0,
  )}, p95 ${fmtT(distribution.resolvedOnly.p95 ?? 0)}`,
);
console.error('');

const overall = thresholds.map((T) => evaluate(clocks, T));

console.error('threshold   attainment(decided)   95% CI            bounds(all)        unknown');
for (const r of overall) {
  console.error(
    `${fmtT(r.thresholdMinutes).padStart(8)}   ${fmtPct(r.attainmentDecided).padStart(19)}   ` +
      `${`${fmtPct(r.ci95.low)}-${fmtPct(r.ci95.high)}`.padStart(15)}   ` +
      `${`${fmtPct(r.attainmentLower)}-${fmtPct(r.attainmentUpper)}`.padStart(15)}   ${r.unknown}`,
  );
}

const widest = overall.reduce(
  (worst, r) =>
    r.attainmentUpper !== null && r.attainmentLower !== null && r.attainmentUpper - r.attainmentLower > worst
      ? r.attainmentUpper - r.attainmentLower
      : worst,
  0,
);
if (widest > 0.02) {
  console.error('');
  console.error(
    `WARNING  the bounds span up to ${(widest * 100).toFixed(1)} points because ${fmtPct(censoredShare)} of ` +
      'conversations are still open. Use a window old enough that nearly everything has resolved before quoting a figure.',
  );
}

const segments = segmentField
  ? [...bySegment.entries()].map(([name, set]) => ({
      segment: name,
      n: set.length,
      thresholds: thresholds.map((T) => evaluate(set, T)),
    }))
  : [];

if (segmentField) {
  console.error('');
  console.error(`by ${segmentField}:`);
  for (const s of segments) {
    const cells = s.thresholds.map((r) => `${fmtT(r.thresholdMinutes)}=${fmtPct(r.attainmentDecided)}`).join('  ');
    console.error(`  ${s.segment.padEnd(18)} n=${String(s.n).padEnd(6)} ${cells}`);
  }
}

console.log(
  JSON.stringify(
    {
      unit,
      distribution,
      thresholds: overall,
      segmentedBy: segmentField,
      segments,
      notes: [
        'An open conversation whose clock already exceeds the threshold is counted as a certain breach; only open conversations still inside the threshold are unknown.',
        'attainmentDecided = met / (met + breach). attainmentLower and attainmentUpper bound it by resolving unknowns pessimistically and optimistically.',
        'Percentiles are computed over resolved conversations only, since an open clock is a lower bound on its final value.',
        'Business-hours conversion, pause policy and spam exclusion happen upstream. This script thresholds the number it is given.',
        'This applies a new threshold to historical behaviour. A real target changes behaviour, so treat this as the pessimistic bound on attainment and the optimistic bound on required change.',
      ],
    },
    null,
    2,
  ),
);
