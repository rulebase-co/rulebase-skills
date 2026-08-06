#!/usr/bin/env node
/**
 * Computes regulated complaint deadlines against a configured business calendar
 * and reports breaches, at-risk cases, and identification lag.
 *
 * Deliberately hard-codes no deadline lengths. Deadlines vary by jurisdiction,
 * sector, product and complaint type and they change; they come from config, and
 * the config's `source` field is echoed into the output so a reader can check
 * where each one came from.
 *
 * Two defaults are chosen against convenience on purpose:
 *   - the clock starts at received_at, not at identified_at, because in most
 *     regimes it starts when the complaint reaches the firm rather than when
 *     someone recognised it;
 *   - pauses are off, because many complaint regimes do not let the clock stop
 *     while you wait for the customer, even though support SLAs do.
 *
 * Read-only. Determining whether a breach is reportable is a compliance and legal
 * decision, not this script's.
 *
 * Usage:
 *   node complaint-clock.mjs --input complaints.jsonl --config clock-config.json
 *                            [--as-of 2026-08-06] [--json]
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
const configPath = opt('config');
if (!inputPath || inputPath === true) die('--input <file> is required');
if (!configPath || configPath === true) die('--config <file> is required');

const asOfArg = opt('as-of');
const DAY_MS = 86400000;

// ------------------------------------------------------------------- config

let config;
try {
  config = JSON.parse(readFileSync(String(configPath), 'utf8'));
} catch (err) {
  die(`could not read config: ${err.message}`);
}

const offsetMinutes = Number(config.timezone_offset_minutes ?? 0);
if (!Number.isFinite(offsetMinutes)) die('timezone_offset_minutes must be a number');

const workingDays = new Set(config.working_days ?? [1, 2, 3, 4, 5]);
if (workingDays.size === 0) die('working_days cannot be empty — every day would be a non-working day');
for (const d of workingDays) {
  if (!Number.isInteger(d) || d < 1 || d > 7) die(`working_days entries must be ISO weekdays 1-7, got ${d}`);
}

const holidays = {};
for (const [market, list] of Object.entries(config.holidays ?? {})) {
  holidays[market] = new Set(list ?? []);
}

const clockStart = String(config.clock_start ?? 'received_at');
const countFrom = String(config.count_from ?? 'next_working_day');
if (!['next_working_day', 'same_day'].includes(countFrom)) {
  die('count_from must be "next_working_day" or "same_day"');
}
const allowPauses = config.allow_pauses === true;

const deadlines = config.deadlines ?? [];
if (deadlines.length === 0) die('config has no deadlines');
const UNITS = new Set(['working_days', 'calendar_days', 'weeks', 'months']);
for (const d of deadlines) {
  if (!d.name) die('every deadline needs a name');
  if (!UNITS.has(d.unit)) die(`deadline "${d.name}": unit must be one of ${[...UNITS].join(', ')}`);
  if (!Number.isFinite(Number(d.length)) || Number(d.length) <= 0) {
    die(`deadline "${d.name}": length must be a positive number`);
  }
  if (!d.from) die(`deadline "${d.name}": needs a \`from\` field`);
  if (!d.satisfied_by) die(`deadline "${d.name}": needs a \`satisfied_by\` field`);
}

const warnings = [];
if (clockStart !== 'received_at') {
  warnings.push(
    `clock_start is "${clockStart}", not "received_at". In most complaint regimes the clock starts when the complaint reaches the firm, not when it was recognised, so this will usually understate age.`,
  );
}
if (allowPauses) {
  warnings.push(
    'allow_pauses is true. Many complaint regimes do not permit the clock to stop while awaiting information from the customer. Confirm your rules allow it; deducted time is labelled per case.',
  );
}
for (const d of deadlines) {
  if (!d.source) warnings.push(`deadline "${d.name}" has no \`source\`. Record where the length came from.`);
}

// ------------------------------------------------------------ date handling

/** Calendar date (YYYY-MM-DD) of an instant, in the configured offset. */
function localDateKey(ms) {
  return new Date(ms + offsetMinutes * 60000).toISOString().slice(0, 10);
}

/** ISO weekday (Mon=1..Sun=7) of a date key. */
function isoWeekday(dateKey) {
  const day = new Date(`${dateKey}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

function addCalendarDays(dateKey, n) {
  return new Date(Date.parse(`${dateKey}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

function isWorkingDay(dateKey, market) {
  if (!workingDays.has(isoWeekday(dateKey))) return false;
  const set = holidays[market] ?? holidays.default;
  return !(set && set.has(dateKey));
}

/**
 * Adds `n` working days. `count_from: next_working_day` means day one is the
 * first working day strictly after the start date; `same_day` means the start
 * date counts as day one when it is itself a working day.
 */
function addWorkingDays(startKey, n, market) {
  let cursor = startKey;
  let counted = 0;

  if (countFrom === 'same_day' && isWorkingDay(cursor, market)) counted = 1;

  // Guard against a calendar that makes every day non-working.
  let guard = 0;
  while (counted < n) {
    cursor = addCalendarDays(cursor, 1);
    if (isWorkingDay(cursor, market)) counted += 1;
    if (++guard > 20000) die(`could not advance ${n} working days from ${startKey}: check working_days and holidays`);
  }
  return cursor;
}

/** Calendar months, clamped to month end: one month from 31 Jan is 28/29 Feb. */
function addMonths(dateKey, n) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const targetMonthIndex = m - 1 + n;
  const targetYear = y + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function dueDateKey(startKey, deadline, market) {
  const n = Number(deadline.length);
  switch (deadline.unit) {
    case 'working_days':
      return addWorkingDays(startKey, n, market);
    case 'calendar_days':
      return addCalendarDays(startKey, countFrom === 'same_day' ? n - 1 : n);
    case 'weeks':
      return addCalendarDays(startKey, n * 7);
    case 'months':
      return addMonths(startKey, n);
    default:
      return die(`unknown unit ${deadline.unit}`);
  }
}

/** Working days between two date keys, exclusive of the first, inclusive of the last. */
function workingDaysBetween(fromKey, toKey, market) {
  if (fromKey === toKey) return 0;
  const sign = fromKey < toKey ? 1 : -1;
  let cursor = fromKey;
  let count = 0;
  let guard = 0;
  while (cursor !== toKey) {
    cursor = addCalendarDays(cursor, sign);
    if (isWorkingDay(cursor, market)) count += sign;
    if (++guard > 20000) break;
  }
  return count;
}

// -------------------------------------------------------------------- input

const raw = readFileSync(String(inputPath), 'utf8').trim();
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
if (!Array.isArray(records) || records.length === 0) die('input has no complaints');

const seen = new Set();
for (const r of records) {
  const id = String(r.id ?? '');
  if (!id) die('every complaint needs an id');
  if (seen.has(id)) {
    die(`duplicate complaint id "${id}". One record per complaint — collapse per-ticket rows first, or ageing is understated.`);
  }
  seen.add(id);
}

const asOfMs = asOfArg && asOfArg !== true ? Date.parse(String(asOfArg)) : Date.now();
if (!Number.isFinite(asOfMs)) die(`--as-of "${asOfArg}" is not a parseable date`);
const asOfKey = localDateKey(asOfMs);

// ---------------------------------------------------------------- evaluate

const results = [];
const problems = [];

for (const rec of records) {
  const market = String(rec.market ?? 'default');
  const startRaw = rec[clockStart];
  if (!startRaw) {
    problems.push({ id: String(rec.id), issue: `missing clock start field "${clockStart}"` });
    continue;
  }
  const startMs = Date.parse(startRaw);
  if (!Number.isFinite(startMs)) {
    problems.push({ id: String(rec.id), issue: `unparseable ${clockStart}: ${startRaw}` });
    continue;
  }

  // Identification lag: how long before the complaint was recognised. Reported
  // separately because it is where hidden breaches concentrate.
  let identificationLagWorkingDays = null;
  if (rec.received_at && rec.identified_at) {
    const recvKey = localDateKey(Date.parse(rec.received_at));
    const identKey = localDateKey(Date.parse(rec.identified_at));
    if (recvKey && identKey) identificationLagWorkingDays = workingDaysBetween(recvKey, identKey, market);
  }

  // Pauses, only when explicitly permitted, and always surfaced.
  let pausedDays = 0;
  if (allowPauses && Array.isArray(rec.pauses)) {
    for (const p of rec.pauses) {
      const a = Date.parse(p?.from);
      const b = Date.parse(p?.to ?? new Date(asOfMs).toISOString());
      if (Number.isFinite(a) && Number.isFinite(b) && b > a) {
        pausedDays += workingDaysBetween(localDateKey(a), localDateKey(b), market);
      }
    }
  }

  const perDeadline = deadlines.map((d) => {
    const fromRaw = rec[d.from];
    if (!fromRaw) {
      return { deadline: d.name, status: 'not_applicable', reason: `record has no "${d.from}"` };
    }
    const fromKey = localDateKey(Date.parse(fromRaw));
    let due = dueDateKey(fromKey, d, market);
    if (pausedDays > 0) {
      due = d.unit === 'working_days' ? addWorkingDays(due, pausedDays, market) : addCalendarDays(due, pausedDays);
    }

    const satisfiedRaw = rec[d.satisfied_by];
    const remaining =
      d.unit === 'working_days'
        ? workingDaysBetween(asOfKey, due, market)
        : Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${asOfKey}T00:00:00Z`)) / DAY_MS);

    if (satisfiedRaw) {
      const satKey = localDateKey(Date.parse(satisfiedRaw));
      const met = satKey <= due;
      return {
        deadline: d.name,
        due_at: due,
        satisfied_at: satKey,
        status: met ? 'met' : 'breached',
        overdue_by: met ? 0 : d.unit === 'working_days' ? workingDaysBetween(due, satKey, market) : Math.round((Date.parse(`${satKey}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / DAY_MS),
        paused_days_added: pausedDays || undefined,
      };
    }

    const warnAt = Number(d.warn_at_days_remaining ?? 0);
    const status = remaining < 0 ? 'breached_open' : remaining <= warnAt ? 'at_risk' : 'open';
    return {
      deadline: d.name,
      due_at: due,
      satisfied_at: null,
      status,
      remaining_days: remaining,
      paused_days_added: pausedDays || undefined,
    };
  });

  results.push({
    id: String(rec.id),
    market,
    owner: rec.owner ?? null,
    clock_start_at: localDateKey(startMs),
    identification_lag_working_days: identificationLagWorkingDays,
    deadlines: perDeadline,
  });
}

// Cases closed with no response artefact look like successes in a status report.
const closedWithoutResponse = records
  .filter((r) => {
    const closed = r.closed_at || r.status === 'closed';
    if (!closed) return false;
    return deadlines.some((d) => /final/i.test(d.name) && !r[d.satisfied_by]);
  })
  .map((r) => String(r.id));

// ----------------------------------------------------------------- summary

const byStatus = {};
const atRisk = [];
const breached = [];
for (const r of results) {
  for (const d of r.deadlines) {
    byStatus[d.deadline] ??= { met: 0, breached: 0, breached_open: 0, at_risk: 0, open: 0, not_applicable: 0 };
    byStatus[d.deadline][d.status] += 1;
    if (d.status === 'at_risk') atRisk.push({ id: r.id, deadline: d.deadline, due_at: d.due_at, remaining_days: d.remaining_days, owner: r.owner });
    if (d.status === 'breached' || d.status === 'breached_open') {
      breached.push({ id: r.id, deadline: d.deadline, due_at: d.due_at, status: d.status, owner: r.owner });
    }
  }
}
atRisk.sort((a, b) => a.remaining_days - b.remaining_days);

const lags = results.map((r) => r.identification_lag_working_days).filter((v) => v !== null && Number.isFinite(v));
lags.sort((a, b) => a - b);
const pick = (q) => (lags.length ? lags[Math.min(lags.length - 1, Math.round(q * (lags.length - 1)))] : null);

const unowned = results.filter((r) => !r.owner).map((r) => r.id);

const summary = {
  asOf: asOfKey,
  config: {
    clock_start: clockStart,
    count_from: countFrom,
    allow_pauses: allowPauses,
    working_days: [...workingDays],
    markets_with_holidays: Object.keys(holidays),
    deadlines: deadlines.map((d) => ({ name: d.name, length: d.length, unit: d.unit, from: d.from, satisfied_by: d.satisfied_by, source: d.source ?? null })),
  },
  complaints: results.length,
  byDeadlineStatus: byStatus,
  breached,
  atRisk,
  closedWithoutFinalResponse: closedWithoutResponse,
  unownedComplaints: unowned,
  identificationLag: { n: lags.length, p50: pick(0.5), p90: pick(0.9), max: lags.length ? lags[lags.length - 1] : null },
  inputProblems: problems,
  warnings,
  notes: [
    'Deadline lengths come from config and are not asserted by this script. Check each deadline\'s `source`.',
    'Whether a breach is reportable is a compliance and legal determination, not an output of this script.',
    'Absolute counts matter more than rates here: complaint volumes are low enough that a percentage can hide a single breach.',
    'Complaints arriving through channels outside this dataset (reviews, social, letters, regulator portals) are not counted. Their absence is not compliance.',
  ],
};

// ---------------------------------------------------------------- reporting

if (!argv.includes('--json')) {
  console.error(`as of ${asOfKey} — ${results.length} complaint(s)`);
  for (const w of warnings) console.error(`WARNING  ${w}`);
  console.error('');
  for (const [name, counts] of Object.entries(byStatus)) {
    const total = Object.values(counts).reduce((a, b) => a + b, 0) - counts.not_applicable;
    const breaches = counts.breached + counts.breached_open;
    console.error(
      `${name.padEnd(20)} met ${counts.met}  breached ${breaches} (${counts.breached_open} still open)  at risk ${counts.at_risk}  open ${counts.open}  of ${total}`,
    );
  }
  if (atRisk.length) {
    console.error('');
    console.error('at risk, soonest first:');
    for (const a of atRisk.slice(0, 20)) {
      console.error(`  ${String(a.remaining_days).padStart(4)}d  ${a.id.padEnd(12)} ${a.deadline.padEnd(18)} due ${a.due_at}  ${a.owner ?? 'UNOWNED'}`);
    }
  }
  if (closedWithoutResponse.length) {
    console.error('');
    console.error(`${closedWithoutResponse.length} complaint(s) closed with no final response recorded — these look like successes in a status report:`);
    console.error(`  ${closedWithoutResponse.slice(0, 20).join(', ')}`);
  }
  if (lags.length) {
    console.error('');
    console.error(`identification lag (working days): p50 ${pick(0.5)}, p90 ${pick(0.9)}, max ${lags[lags.length - 1]}`);
  }
  if (problems.length) {
    console.error('');
    console.error(`${problems.length} record(s) could not be evaluated:`);
    for (const p of problems.slice(0, 10)) console.error(`  ${p.id}: ${p.issue}`);
  }
}

console.log(JSON.stringify(summary, null, 2));

if (breached.length > 0 || closedWithoutResponse.length > 0) process.exit(1);
