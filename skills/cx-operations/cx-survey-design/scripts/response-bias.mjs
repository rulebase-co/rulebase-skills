#!/usr/bin/env node
/**
 * Tests whether your survey respondents look like your contacts.
 *
 * A CSAT score is a statistic about the people who answered. If they differ
 * systematically from the people who didn't, the score is biased and no sample
 * size fixes it. Almost nobody checks, because the check requires data about
 * non-respondents — which you have, and which the survey tool doesn't.
 *
 * Method: compare respondents against non-respondents on covariates you observe
 * for everyone (channel, handle time, message count, agent, repeat contact). For
 * numeric covariates it reports the standardised mean difference (SMD); for
 * categorical ones, the difference in proportions. |SMD| > 0.1 is the
 * conventional threshold for a meaningful imbalance.
 *
 * An imbalance does not prove the score is wrong. It proves the sample is not
 * representative on that dimension, which is the thing you are entitled to
 * assume otherwise.
 *
 * No npm dependencies. Node 20+.
 *
 * Input: newline-delimited JSON, one record per eligible contact — surveyed or
 * not. Records need a response flag, optionally a score, and any covariates.
 *
 *   {
 *     "id": "c_1",
 *     "responded": true,          required (or "survey_responded")
 *     "score": 5,                 optional, respondents only
 *     "channel": "email",         covariates: any scalar field
 *     "handle_time_seconds": 420,
 *     "message_count": 3,
 *     "agent_id": "a_7",
 *     "repeat_contact": false
 *   }
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

// Conventional threshold for a meaningful covariate imbalance.
const SMD_THRESHOLD = 0.1;
// Below this, per-group statistics are too noisy to interpret.
const MIN_GROUP = 30;
// Categorical fields with more levels than this are summarised, not enumerated.
const MAX_LEVELS = 12;

const RESPONSE_KEYS = ['responded', 'survey_responded', 'has_response', 'answered'];
const SCORE_KEYS = ['score', 'csat', 'csat_score', 'rating', 'nps'];
const IGNORED_KEYS = new Set(['id', 'source_id', 'conversation_id', ...RESPONSE_KEYS, ...SCORE_KEYS]);

function parseArgs(argv) {
  const opts = { input: null, covariates: null, json: false, minGroup: MIN_GROUP };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${arg} requires a value`);
      return v;
    };
    switch (arg) {
      case '--input': opts.input = next(); break;
      case '--covariates': opts.covariates = next().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--min-group': opts.minGroup = Number(next()); break;
      case '--json': opts.json = true; break;
      case '--help': case '-h': usage(); process.exit(0);
      default:
        if (!opts.input && !arg.startsWith('-')) { opts.input = arg; break; }
        fail(`unknown argument: ${arg}`);
    }
  }
  if (!opts.input) fail('an input .jsonl path is required');
  return opts;
}

function usage() {
  process.stderr.write(`
Usage: node scripts/response-bias.mjs <contacts.jsonl> [options]

  --covariates <list>   Comma-separated fields to test. Default: every scalar
                        field present on the records.
  --min-group <n>       Suppress statistics below this group size (default ${MIN_GROUP}).
  --json                Emit only JSON on stdout.

Input must include NON-respondents. A file of survey responses alone cannot
measure response bias — that is the whole point.
`);
}

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function firstKey(record, keys) {
  for (const key of keys) {
    if (record[key] !== undefined) return key;
  }
  return null;
}

const truthy = (v) => v === true || v === 1 || v === 'true' || v === 'yes' || v === 'Y';

async function readContacts(path) {
  const records = [];
  const problems = { badJson: 0, missingFlag: 0 };
  const stream = createReadStream(path, 'utf8').on('error', (err) =>
    fail(`could not read ${path}: ${err.message}`),
  );
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  let responseKey = null;
  let scoreKey = null;

  for await (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      problems.badJson++;
      continue;
    }
    responseKey ??= firstKey(record, RESPONSE_KEYS);
    scoreKey ??= firstKey(record, SCORE_KEYS);

    if (responseKey === null || record[responseKey] === undefined) {
      problems.missingFlag++;
      continue;
    }
    records.push(record);
  }

  return { records, problems, responseKey, scoreKey };
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

function variance(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
}

/**
 * Standardised mean difference, pooled. Scale-free, so covariates measured in
 * seconds and counts are comparable against one threshold.
 */
function smd(a, b) {
  if (a.length < 2 || b.length < 2) return null;
  const pooled = Math.sqrt((variance(a) + variance(b)) / 2);
  if (pooled === 0) return 0;
  return (mean(a) - mean(b)) / pooled;
}

function classify(records, field) {
  let numeric = 0;
  let present = 0;
  const levels = new Set();
  for (const record of records) {
    const value = record[field];
    if (value === null || value === undefined || value === '') continue;
    present++;
    if (typeof value === 'number' && Number.isFinite(value)) numeric++;
    else if (typeof value === 'boolean') levels.add(String(value));
    else levels.add(String(value));
  }
  if (present === 0) return { kind: 'empty' };
  // Treat a numeric field as numeric only when it is consistently numeric.
  if (numeric / present > 0.9) return { kind: 'numeric', present };
  return { kind: 'categorical', present, levels: levels.size };
}

function analyseNumeric(respondents, nonRespondents, field) {
  const pick = (records) =>
    records
      .map((r) => r[field])
      .filter((v) => typeof v === 'number' && Number.isFinite(v));

  const a = pick(respondents);
  const b = pick(nonRespondents);
  if (a.length < 2 || b.length < 2) return null;

  const value = smd(a, b);
  return {
    covariate: field,
    kind: 'numeric',
    respondent_mean: Number(mean(a).toFixed(3)),
    non_respondent_mean: Number(mean(b).toFixed(3)),
    respondent_n: a.length,
    non_respondent_n: b.length,
    smd: value === null ? null : Number(value.toFixed(3)),
    imbalanced: value !== null && Math.abs(value) > SMD_THRESHOLD,
  };
}

function analyseCategorical(respondents, nonRespondents, field, minGroup) {
  const proportions = (records) => {
    const counts = {};
    let total = 0;
    for (const record of records) {
      const value = record[field];
      if (value === null || value === undefined || value === '') continue;
      const key = String(value);
      counts[key] = (counts[key] ?? 0) + 1;
      total++;
    }
    return { counts, total };
  };

  const a = proportions(respondents);
  const b = proportions(nonRespondents);
  if (a.total === 0 || b.total === 0) return null;

  const levels = [...new Set([...Object.keys(a.counts), ...Object.keys(b.counts)])];
  if (levels.length > MAX_LEVELS) {
    return {
      covariate: field,
      kind: 'categorical',
      levels: levels.length,
      skipped: `too many levels (${levels.length}) to compare directly`,
      imbalanced: false,
    };
  }

  const rows = levels
    .map((level) => {
      const pa = (a.counts[level] ?? 0) / a.total;
      const pb = (b.counts[level] ?? 0) / b.total;
      const n = (a.counts[level] ?? 0) + (b.counts[level] ?? 0);
      // Response rate within this level is the most interpretable form.
      const levelResponseRate = n === 0 ? null : (a.counts[level] ?? 0) / n;
      return {
        level,
        respondent_share: Number(pa.toFixed(4)),
        non_respondent_share: Number(pb.toFixed(4)),
        difference: Number((pa - pb).toFixed(4)),
        n,
        response_rate: levelResponseRate === null ? null : Number(levelResponseRate.toFixed(4)),
        reliable: n >= minGroup,
      };
    })
    .sort((x, y) => Math.abs(y.difference) - Math.abs(x.difference));

  const worst = rows.find((r) => r.reliable) ?? rows[0];
  return {
    covariate: field,
    kind: 'categorical',
    levels: rows,
    // 10 percentage points of composition shift is the categorical analogue of
    // the SMD threshold.
    imbalanced: rows.some((r) => r.reliable && Math.abs(r.difference) > 0.1),
    largest_difference: worst ? worst.difference : null,
  };
}

function scoreStats(respondents, scoreKey) {
  if (!scoreKey) return null;
  const scores = respondents
    .map((r) => r[scoreKey])
    .filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (scores.length === 0) return null;

  const sorted = [...scores].sort((a, b) => a - b);
  const distribution = {};
  for (const score of scores) distribution[score] = (distribution[score] ?? 0) + 1;

  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const extremes = scores.filter((s) => s === min || s === max).length;

  return {
    field: scoreKey,
    n: scores.length,
    mean: Number(mean(scores).toFixed(3)),
    min,
    max,
    distribution,
    // Bimodality is the fingerprint of self-selected response: delighted and
    // furious answer, the indifferent middle does not.
    extreme_share: Number((extremes / scores.length).toFixed(3)),
  };
}

function buildFindings(report, opts) {
  const findings = [];
  const rate = report.response_rate;

  if (rate !== null && rate < 0.3) {
    findings.push(
      `Response rate is ${(rate * 100).toFixed(1)}%. At this level the score describes a ` +
        `self-selected minority. Non-response bias, not sampling error, is the dominant ` +
        `uncertainty — a larger sample will not reduce it.`,
    );
  }

  const imbalanced = report.covariates.filter((c) => c.imbalanced);
  if (imbalanced.length > 0) {
    findings.push(
      `${imbalanced.length} covariate(s) are imbalanced between respondents and non-respondents: ` +
        `${imbalanced.map((c) => c.covariate).join(', ')}. Respondents are not a random sample of ` +
        `contacts, so segment comparisons and trends over time can move for reasons unrelated to ` +
        `experience.`,
    );
  } else if (report.covariates.length > 0) {
    findings.push(
      `No covariate imbalance detected above |SMD| ${SMD_THRESHOLD}. That is reassuring but not ` +
        `proof of representativeness — it only covers the covariates supplied. Sentiment itself is ` +
        `never observable for non-respondents.`,
    );
  }

  if (report.score && report.score.extreme_share > 0.7) {
    findings.push(
      `${(report.score.extreme_share * 100).toFixed(0)}% of scores are at the extremes of the ` +
        `scale. This bimodality is characteristic of self-selected response and means the mean is ` +
        `a poor summary — report the distribution or top-box rate instead.`,
    );
  }

  if (report.counts.respondents < opts.minGroup) {
    findings.push(
      `Only ${report.counts.respondents} respondents. Below ~${opts.minGroup} the comparisons ` +
        `above are themselves unreliable.`,
    );
  }

  findings.push(
    'Covariate balance cannot rule out bias on the thing you actually care about. Customers with ' +
      'a strong opinion respond more often, and that is unobservable by construction. Treat the ' +
      'score as a tripwire and the verbatims as the evidence.',
  );

  return findings;
}

function render(report) {
  const pct = (v) => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);
  const lines = [''];

  lines.push(`contacts:       ${report.counts.total}`);
  lines.push(`respondents:    ${report.counts.respondents}`);
  lines.push(`response rate:  ${pct(report.response_rate)}`);

  if (report.score) {
    lines.push('');
    lines.push(
      `score (${report.score.field}): mean ${report.score.mean} over ${report.score.n} responses, ` +
        `${pct(report.score.extreme_share)} at scale extremes`,
    );
  }

  const numeric = report.covariates.filter((c) => c.kind === 'numeric');
  if (numeric.length > 0) {
    lines.push('');
    lines.push('  numeric covariates (respondent vs non-respondent)');
    lines.push('    covariate                 respondents  non-resp.      SMD  flag');
    for (const c of numeric) {
      lines.push(
        `    ${c.covariate.slice(0, 24).padEnd(24)}  ${String(c.respondent_mean).padStart(11)}  ` +
          `${String(c.non_respondent_mean).padStart(9)}  ${String(c.smd).padStart(7)}  ` +
          `${c.imbalanced ? 'IMBALANCED' : 'ok'}`,
      );
    }
  }

  const categorical = report.covariates.filter((c) => c.kind === 'categorical' && c.levels?.length);
  for (const c of categorical) {
    lines.push('');
    lines.push(`  ${c.covariate} — response rate by level`);
    for (const level of c.levels.slice(0, MAX_LEVELS)) {
      lines.push(
        `    ${level.level.slice(0, 24).padEnd(24)}  n=${String(level.n).padStart(7)}  ` +
          `resp rate ${pct(level.response_rate).padStart(7)}  ` +
          `share diff ${(level.difference > 0 ? '+' : '') + (level.difference * 100).toFixed(1)}pp` +
          `${level.reliable ? '' : '  (small n)'}`,
      );
    }
    if (c.imbalanced) lines.push(`    -> IMBALANCED on ${c.covariate}`);
  }

  lines.push('');
  lines.push('  findings');
  for (const finding of report.findings) lines.push(`    - ${finding}`);
  lines.push('');

  return lines.join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { records, problems, responseKey, scoreKey } = await readContacts(opts.input);

  if (records.length === 0) {
    fail(
      'no usable records. Every record needs a response flag ' +
        `(one of: ${RESPONSE_KEYS.join(', ')}).`,
    );
  }

  const respondents = records.filter((r) => truthy(r[responseKey]));
  const nonRespondents = records.filter((r) => !truthy(r[responseKey]));

  if (nonRespondents.length === 0) {
    fail(
      'every record is a respondent, so response bias cannot be measured. Export all eligible ' +
        'contacts, not just survey responses — the non-respondents are the comparison group.',
    );
  }

  const fields =
    opts.covariates ??
    [...new Set(records.flatMap((r) => Object.keys(r)))].filter((k) => !IGNORED_KEYS.has(k));

  const covariates = [];
  for (const field of fields) {
    const kind = classify(records, field);
    if (kind.kind === 'empty') continue;
    const result =
      kind.kind === 'numeric'
        ? analyseNumeric(respondents, nonRespondents, field)
        : analyseCategorical(respondents, nonRespondents, field, opts.minGroup);
    if (result) covariates.push(result);
  }

  const report = {
    input: opts.input,
    counts: {
      total: records.length,
      respondents: respondents.length,
      non_respondents: nonRespondents.length,
      dropped_rows: problems,
    },
    response_rate: Number((respondents.length / records.length).toFixed(4)),
    response_flag_field: responseKey,
    score: scoreStats(respondents, scoreKey),
    smd_threshold: SMD_THRESHOLD,
    covariates,
  };
  report.findings = buildFindings(report, opts);
  report.representative = covariates.length > 0 && !covariates.some((c) => c.imbalanced);

  if (!opts.json) process.stderr.write(render(report));
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

await main();
