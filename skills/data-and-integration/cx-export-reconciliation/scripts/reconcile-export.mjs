#!/usr/bin/env node
/**
 * Reconciles a canonical-schema conversation export against the source system's
 * own counts, and against internal consistency checks.
 *
 * The distinction the output insists on: internal consistency is not
 * completeness. An export with no duplicates and no date gaps is entirely
 * compatible with missing a third of the account behind a permission scope, so
 * without a source count the verdict is `unverified` rather than a pass.
 *
 * Read-only. Reports counts, ids and dates — never conversation content.
 *
 * Usage:
 *   node reconcile-export.mjs --dir ./out --expected expected.json
 *                             [--tolerance 0.01] [--max-list 25]
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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

const dir = opt('dir');
if (!dir || dir === true) die('--dir <export-directory> is required');
const expectedPath = opt('expected');
const tolerance = Number(opt('tolerance', 0));
if (!Number.isFinite(tolerance) || tolerance < 0) die('--tolerance must be a non-negative number');
const maxList = Number(opt('max-list', 25));

const DAY_MS = 86400000;

// ------------------------------------------------------------------- loading

function readJsonl(path) {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8').trim();
  if (raw === '') return [];
  return raw
    .split('\n')
    .map((l, i) => ({ line: i + 1, text: l.trim() }))
    .filter((r) => r.text !== '')
    .map((r) => {
      try {
        return JSON.parse(r.text);
      } catch (err) {
        die(`${path}:${r.line} is not valid JSON — ${err.message}`);
      }
    });
}

const conversations = readJsonl(join(dir, 'conversations.jsonl'));
if (conversations === null) die(`${join(dir, 'conversations.jsonl')} not found`);
const messages = readJsonl(join(dir, 'messages.jsonl'));

let expected = {};
if (expectedPath && expectedPath !== true) {
  if (!existsSync(String(expectedPath))) die(`expected file not found: ${expectedPath}`);
  try {
    expected = JSON.parse(readFileSync(String(expectedPath), 'utf8'));
  } catch (err) {
    die(`could not parse ${expectedPath} — ${err.message}`);
  }
}

const window = expected.window ?? null;
const holidays = new Set(expected.holidays ?? []);
const expectMessages = expected.expect_messages !== false;

// ------------------------------------------------------------------- helpers

const checks = [];
const add = (name, status, detail, extra = {}) => {
  checks.push({ check: name, status, detail, ...extra });
};

const dateKey = (iso) => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
};

const within = (a, b, tol) => (b === 0 ? a === 0 : Math.abs(a - b) / b <= tol);

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// ------------------------------------------------------- structural checks

// Duplicates. A re-run without an upsert key, or appended overlapping windows.
const idCounts = new Map();
for (const c of conversations) {
  const id = String(c.source_id ?? '');
  idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
}
const duplicates = [...idCounts.entries()].filter(([, n]) => n > 1).map(([id, n]) => ({ source_id: id, times: n }));
add(
  'duplicates',
  duplicates.length ? 'fail' : 'pass',
  duplicates.length
    ? `${duplicates.length} source_id(s) appear more than once — a re-run without an upsert key, or overlapping windows appended`
    : 'no duplicate source_ids',
  { count: duplicates.length, sample: duplicates.slice(0, maxList) },
);

// Records outside the requested window. Usually means the filter did not apply
// at all, which means the extract is unbounded rather than slightly wrong.
if (window?.from && window?.to) {
  const outside = conversations
    .map((c) => ({ id: String(c.source_id), day: dateKey(c.created_at) }))
    .filter((r) => r.day && (r.day < window.from || r.day > window.to));
  add(
    'window',
    outside.length ? 'fail' : 'pass',
    outside.length
      ? `${outside.length} conversation(s) fall outside ${window.from}..${window.to} — the window filter may not have applied`
      : `all conversations fall within ${window.from}..${window.to}`,
    { count: outside.length, sample: outside.slice(0, maxList) },
  );
} else {
  add('window', 'skip', 'no window in the expected file, so out-of-range records were not checked');
}

// Daily coverage: the clearest inferred signal of a failed run.
let gaps = { zeroDays: [], lowDays: [] };
const perDay = new Map();
for (const c of conversations) {
  const d = dateKey(c.created_at);
  if (d) perDay.set(d, (perDay.get(d) ?? 0) + 1);
}
if (window?.from && window?.to) {
  const days = [];
  for (let t = Date.parse(`${window.from}T00:00:00Z`); t <= Date.parse(`${window.to}T00:00:00Z`); t += DAY_MS) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  // Compare each day against the median for its own weekday, not against the
  // window as a whole. Support volume has a large day-of-week cycle, so a
  // window-wide median reports every weekend as a gap — and a flat threshold is
  // exactly the mistake this skill's own guidance warns about. Deriving the
  // baseline per weekday also handles an operation that does not work Fridays,
  // or a market with a different working week, without any configuration.
  const byWeekday = new Map();
  for (const d of days) {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (!byWeekday.has(dow)) byWeekday.set(dow, []);
    byWeekday.get(dow).push(perDay.get(d) ?? 0);
  }
  const weekdayMedian = new Map(
    [...byWeekday.entries()].map(([dow, counts]) => [dow, quantile([...counts].sort((a, b) => a - b), 0.5) ?? 0]),
  );

  for (const d of days) {
    if (holidays.has(d)) continue;
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    const baseline = weekdayMedian.get(dow) ?? 0;
    // A weekday that is typically zero (a non-working day for this operation) is
    // not evidence of a gap.
    if (baseline === 0) continue;
    const n = perDay.get(d) ?? 0;
    if (n === 0) gaps.zeroDays.push(d);
    // Well below its own weekday's norm: a partial run. A coarse heuristic that
    // flags for inspection rather than concluding.
    else if (n < baseline * 0.3) gaps.lowDays.push({ day: d, count: n, weekdayMedian: baseline });
  }

  const status = gaps.zeroDays.length ? 'fail' : gaps.lowDays.length ? 'warn' : 'pass';
  add(
    'daily_coverage',
    status,
    gaps.zeroDays.length
      ? `${gaps.zeroDays.length} day(s) have no conversations where that weekday normally has volume — likely failed runs`
      : gaps.lowDays.length
        ? `${gaps.lowDays.length} day(s) are below 30% of their own weekday's median — inspect for partial runs`
        : 'every day has plausible volume for its weekday',
    {
      zeroDays: gaps.zeroDays.slice(0, maxList),
      lowDays: gaps.lowDays.slice(0, maxList),
      weekdayMedians: Object.fromEntries([...weekdayMedian.entries()].map(([k, v]) => [k, v])),
    },
  );
} else {
  add('daily_coverage', 'skip', 'no window in the expected file, so daily coverage was not checked');
}

// ------------------------------------------------------------- count checks

let verdictHasSourceCount = false;

if (Number.isFinite(expected.total_conversations)) {
  verdictHasSourceCount = true;
  const exported = conversations.length;
  const source = Number(expected.total_conversations);
  const ok = within(exported, source, tolerance);
  add(
    'total_conversations',
    ok ? 'pass' : 'fail',
    `${exported} exported against ${source} at source (${exported - source >= 0 ? '+' : ''}${exported - source})`,
    { exported, source, difference: exported - source, relative: source ? (exported - source) / source : null },
  );
} else {
  add(
    'total_conversations',
    'skip',
    'no source count supplied — completeness is unproven, and internal consistency is not completeness',
  );
}

if (messages !== null && Number.isFinite(expected.total_messages)) {
  const ok = within(messages.length, Number(expected.total_messages), tolerance);
  add(
    'total_messages',
    ok ? 'pass' : 'fail',
    `${messages.length} exported against ${expected.total_messages} at source`,
    { exported: messages.length, source: Number(expected.total_messages) },
  );
}

// Per-segment counts. Where a permission scope excluded an inbox or a market,
// this is where it shows up — and it never produces an error at export time.
const segmentGaps = [];
if (expected.by_segment?.field && expected.by_segment?.counts) {
  verdictHasSourceCount = true;
  const field = expected.by_segment.field;
  const actual = new Map();
  for (const c of conversations) {
    const v = c[field] === undefined || c[field] === null ? '(null)' : String(c[field]);
    actual.set(v, (actual.get(v) ?? 0) + 1);
  }
  for (const [value, srcCount] of Object.entries(expected.by_segment.counts)) {
    const got = actual.get(value) ?? 0;
    if (!within(got, Number(srcCount), tolerance)) {
      segmentGaps.push({ segment: value, exported: got, source: Number(srcCount), difference: got - Number(srcCount) });
    }
  }
  const unexpected = [...actual.keys()].filter((k) => !(k in expected.by_segment.counts));
  add(
    'by_segment',
    segmentGaps.length ? 'fail' : 'pass',
    segmentGaps.length
      ? `${segmentGaps.length} of ${Object.keys(expected.by_segment.counts).length} ${field} segment(s) do not match — a permission scope is the usual cause`
      : `all ${field} segments match source counts`,
    { field, gaps: segmentGaps, valuesNotInExpected: unexpected },
  );
} else {
  add('by_segment', 'skip', 'no per-segment source counts supplied — a scope excluding one inbox or market would not be detected');
}

// ------------------------------------------------------------ message checks

if (messages === null) {
  add(
    'messages_file',
    expectMessages ? 'fail' : 'pass',
    expectMessages
      ? 'messages.jsonl is missing, but expect_messages is not false'
      : 'no messages.jsonl, as expected for a voice-only source',
  );
} else {
  const convIds = new Set(conversations.map((c) => String(c.source_id)));
  const orphans = messages.filter((m) => !convIds.has(String(m.conversation_source_id)));
  add(
    'orphan_messages',
    orphans.length ? 'fail' : 'pass',
    orphans.length
      ? `${orphans.length} message(s) reference a conversation that is not in the export — the two passes disagree`
      : 'every message resolves to a conversation',
    { count: orphans.length, sample: orphans.slice(0, maxList).map((m) => ({ source_id: String(m.source_id), conversation_source_id: String(m.conversation_source_id) })) },
  );

  const withMessages = new Set(messages.map((m) => String(m.conversation_source_id)));
  const empty = [...convIds].filter((id) => !withMessages.has(id));
  add(
    'empty_conversations',
    empty.length === 0 ? 'pass' : expectMessages ? 'warn' : 'pass',
    empty.length === 0
      ? 'every conversation has at least one message'
      : expectMessages
        ? `${empty.length} conversation(s) have no messages — expected for voice, a red flag for a text source`
        : `${empty.length} conversation(s) have no messages, as expected for this source`,
    { count: empty.length, sample: empty.slice(0, maxList) },
  );

  // A broken author mapping invalidates every response-time and turn-count
  // metric downstream, and nothing else detects it.
  const unknown = messages.filter((m) => m.author_type === 'unknown' || m.author_type === undefined).length;
  const share = messages.length ? unknown / messages.length : 0;
  add(
    'author_type_unknown',
    share > 0.05 ? 'warn' : 'pass',
    `${(share * 100).toFixed(1)}% of messages have an unresolved author_type${share > 0.05 ? ' — response-time and turn-count metrics are not trustworthy above ~5%' : ''}`,
    { unknown, total: messages.length, share },
  );
}

// ---------------------------------------------------------- population check

const populationShortfalls = [];
if (expected.min_population) {
  for (const [field, floor] of Object.entries(expected.min_population)) {
    const populated = conversations.filter((c) => c[field] !== null && c[field] !== undefined && c[field] !== '').length;
    const rate = conversations.length ? populated / conversations.length : 0;
    if (rate < Number(floor)) populationShortfalls.push({ field, rate, floor: Number(floor) });
  }
  add(
    'field_population',
    populationShortfalls.length ? 'fail' : 'pass',
    populationShortfalls.length
      ? `${populationShortfalls.length} field(s) below their population floor — an extract that skipped a hydration step`
      : 'all fields meet their population floors',
    { shortfalls: populationShortfalls },
  );
} else {
  add('field_population', 'skip', 'no min_population floors supplied');
}

// ----------------------------------------------------------------- verdict

const failed = checks.filter((c) => c.status === 'fail');
const warned = checks.filter((c) => c.status === 'warn');

let verdict;
if (failed.length) verdict = 'not_reconciled';
else if (!verdictHasSourceCount) verdict = 'unverified';
else if (warned.length) verdict = 'reconciled_with_gaps';
else verdict = 'reconciled';

const summary = {
  verdict,
  directory: dir,
  source: expected.source ?? null,
  window,
  sourceCountMethod: expected.source_count_method ?? null,
  tolerance,
  counts: { conversations: conversations.length, messages: messages === null ? null : messages.length },
  checks,
  gaps,
  segmentGaps,
  notes: [
    'Internal consistency is not completeness. Without a source count the verdict is `unverified`, which is not a pass.',
    'A small gap is frequently a definition difference — date field, status set, spam and deleted handling, timezone — rather than missing data. Reconcile the definitions before concluding data is lost.',
    'Do not fill a gap by re-running with a wider window and appending; that produces duplicates. Re-run into a clean directory, or upsert on source_id.',
    'Carry this verdict into anything built on the export. A caveat added later does not travel with the number.',
  ],
};

const label = { pass: 'ok  ', fail: 'FAIL', warn: 'warn', skip: 'skip' };
console.error(`${dir} — ${conversations.length} conversation(s)${messages === null ? '' : `, ${messages.length} message(s)`}`);
if (expected.source_count_method) console.error(`source count method: ${expected.source_count_method}`);
console.error('');
for (const c of checks) console.error(`${label[c.status]}  ${c.check}: ${c.detail}`);
console.error('');
console.error(`VERDICT  ${verdict}`);
if (verdict === 'unverified') {
  console.error('         No source count was supplied. The export is internally consistent and its completeness is unknown.');
}
if (gaps.zeroDays.length) console.error(`         re-run these days: ${gaps.zeroDays.slice(0, maxList).join(', ')}`);
for (const g of segmentGaps) {
  console.error(`         segment "${g.segment}" short by ${-g.difference} (${g.exported} of ${g.source})`);
}

console.log(JSON.stringify(summary, null, 2));

if (verdict === 'not_reconciled') process.exit(1);
