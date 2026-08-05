#!/usr/bin/env node
/**
 * Computes true containment for an automated support channel, and the gap
 * between it and the naive "no handoff" rate that most vendor dashboards show.
 *
 * Every bot session lands in exactly one bucket:
 *
 *   handoff    escalated to a human inside the session
 *   leaked     no handoff, but the customer reached a human within the window
 *   abandoned  no handoff, no return, and no resolution signal
 *   contained  no handoff, no return, and a resolution signal
 *
 *   naive containment = (handoff-free sessions) / eligible
 *   true  containment = contained / eligible
 *
 * The difference between the two is the number the analysis exists to produce.
 *
 * No npm dependencies. Node 20+.
 *
 * Input: newline-delimited JSON, one record per customer contact — bot sessions
 * AND human contacts in the same file, so cross-channel returns are visible.
 *
 *   {
 *     "id": "c_1",                      required, unique
 *     "customer_id": "u_9",             required for return detection
 *     "started_at": "2026-03-01T10:00:00Z",  required (ISO 8601)
 *     "ended_at": "2026-03-01T10:04:00Z",    optional
 *     "handled_by": "bot" | "human",    required
 *     "channel": "chat",                optional
 *     "handed_off": false,              bot sessions only
 *     "intent": "refund_status",        optional; enables --strict-intent
 *     "resolved": true,                 optional; needed to split contained/abandoned
 *     "csat": 4                         optional
 *   }
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const DAY_MS = 86_400_000;

function parseArgs(argv) {
  const opts = { input: null, windowDays: 7, strictIntent: false, minSessions: 30, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${arg} requires a value`);
      return v;
    };
    switch (arg) {
      case '--input': opts.input = next(); break;
      case '--window-days': opts.windowDays = Number(next()); break;
      case '--min-sessions': opts.minSessions = Number(next()); break;
      case '--strict-intent': opts.strictIntent = true; break;
      case '--json': opts.json = true; break;
      case '--help': case '-h': usage(); process.exit(0);
      default:
        if (!opts.input && !arg.startsWith('-')) { opts.input = arg; break; }
        fail(`unknown argument: ${arg}`);
    }
  }
  if (!opts.input) fail('an input .jsonl path is required');
  if (!Number.isFinite(opts.windowDays) || opts.windowDays <= 0) {
    fail('--window-days must be a positive number');
  }
  return opts;
}

function usage() {
  process.stderr.write(`
Usage: node scripts/deflection-report.mjs <contacts.jsonl> [options]

  --window-days <n>    Return-contact window in days (default 7).
  --strict-intent      Only count a return as leakage when the intent label
                       matches. Produces the lower bound; the default (any
                       contact) produces the upper bound. Report both.
  --min-sessions <n>   Suppress per-intent breakdown below n sessions
                       (default 30) to avoid reporting noise.
  --json               Emit only JSON on stdout.

Input must contain both bot sessions and human contacts so that returns on
other channels are visible. See the header of this file for the record shape.
`);
}

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

async function readContacts(path) {
  const contacts = [];
  const problems = { badJson: 0, missingFields: 0, badDate: 0 };
  const stream = createReadStream(path, 'utf8').on('error', (err) =>
    fail(`could not read ${path}: ${err.message}`),
  );
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  let lineNo = 0;
  for await (const line of lines) {
    lineNo++;
    if (!line.trim()) continue;

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      problems.badJson++;
      continue;
    }

    if (!record.id || !record.customer_id || !record.started_at || !record.handled_by) {
      problems.missingFields++;
      continue;
    }
    const started = Date.parse(record.started_at);
    if (Number.isNaN(started)) {
      problems.badDate++;
      continue;
    }
    const ended = record.ended_at ? Date.parse(record.ended_at) : started;

    contacts.push({
      id: record.id,
      customerId: String(record.customer_id),
      started,
      ended: Number.isNaN(ended) ? started : ended,
      handledBy: record.handled_by,
      channel: record.channel ?? null,
      handedOff: record.handed_off === true,
      intent: record.intent ?? null,
      resolved: typeof record.resolved === 'boolean' ? record.resolved : null,
      csat: typeof record.csat === 'number' ? record.csat : null,
    });
  }

  return { contacts, problems, lineNo };
}

/**
 * Classifies each bot session. Human contacts are indexed per customer so
 * return detection is a bounded scan rather than a cross join.
 */
function classify(contacts, { windowDays, strictIntent }) {
  const windowMs = windowDays * DAY_MS;

  const humanByCustomer = new Map();
  for (const c of contacts) {
    if (c.handledBy !== 'human') continue;
    if (!humanByCustomer.has(c.customerId)) humanByCustomer.set(c.customerId, []);
    humanByCustomer.get(c.customerId).push(c);
  }
  for (const list of humanByCustomer.values()) list.sort((a, b) => a.started - b.started);

  const botSessions = contacts.filter((c) => c.handledBy === 'bot');
  const results = [];

  for (const session of botSessions) {
    let bucket;
    let returnedVia = null;

    if (session.handedOff) {
      bucket = 'handoff';
    } else {
      // A return is a human contact starting after this session ended, inside
      // the window. Contacts that begin during the session are treated as the
      // same episode, not a return.
      const candidates = humanByCustomer.get(session.customerId) ?? [];
      const found = candidates.find((h) => {
        if (h.started <= session.ended) return false;
        if (h.started > session.ended + windowMs) return false;
        if (strictIntent && session.intent && h.intent) return h.intent === session.intent;
        if (strictIntent) return false; // cannot confirm the intent match
        return true;
      });

      if (found) {
        bucket = 'leaked';
        returnedVia = found.channel;
      } else if (session.resolved === true) {
        bucket = 'contained';
      } else if (session.resolved === false) {
        bucket = 'abandoned';
      } else {
        // No resolution signal in the data: cannot tell a silent success from a
        // customer who gave up. Tracked separately rather than assumed either way.
        bucket = 'unknown';
      }
    }

    results.push({ session, bucket, returnedVia });
  }

  return results;
}

function summarise(results) {
  const counts = { handoff: 0, leaked: 0, abandoned: 0, contained: 0, unknown: 0 };
  for (const r of results) counts[r.bucket]++;
  const total = results.length;

  const noHandoff = total - counts.handoff;
  const rate = (n) => (total === 0 ? null : Number((n / total).toFixed(4)));

  return {
    eligible_sessions: total,
    counts,
    naive_containment_rate: rate(noHandoff),
    true_containment_rate: rate(counts.contained),
    // The share of "deflected" sessions the naive number credits but that either
    // came back or went quiet.
    overstatement_pp:
      total === 0 ? null : Number((((noHandoff - counts.contained) / total) * 100).toFixed(2)),
    leak_rate: rate(counts.leaked),
    abandon_rate: rate(counts.abandoned),
    unclassified_rate: rate(counts.unknown),
  };
}

function byIntent(results, minSessions) {
  const groups = new Map();
  for (const r of results) {
    const key = r.session.intent ?? '(no intent label)';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const rows = [];
  let suppressed = 0;
  for (const [intent, group] of groups) {
    if (group.length < minSessions) {
      suppressed += group.length;
      continue;
    }
    const s = summarise(group);
    rows.push({
      intent,
      sessions: group.length,
      naive: s.naive_containment_rate,
      true_containment: s.true_containment_rate,
      overstatement_pp: s.overstatement_pp,
      leak_rate: s.leak_rate,
    });
  }
  rows.sort((a, b) => b.sessions - a.sessions);
  return { rows, suppressed_sessions: suppressed, min_sessions: minSessions };
}

function csatComparison(results) {
  const buckets = {};
  for (const r of results) {
    const scores = (buckets[r.bucket] ??= []);
    if (r.session.csat !== null) scores.push(r.session.csat);
  }
  const out = {};
  for (const [bucket, scores] of Object.entries(buckets)) {
    out[bucket] =
      scores.length === 0
        ? { n: 0, mean: null }
        : { n: scores.length, mean: Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(3)) };
  }
  return out;
}

function leakChannels(results) {
  const counts = {};
  for (const r of results) {
    if (r.bucket !== 'leaked') continue;
    const key = r.returnedVia ?? '(unknown channel)';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function buildCaveats(summary, problems, hasResolved, hasIntent, strictIntent) {
  const caveats = [];

  if (!hasResolved) {
    caveats.push(
      'No `resolved` field found on bot sessions, so contained and abandoned sessions cannot ' +
        'be separated. Every non-handoff, non-return session is reported as "unknown" and true ' +
        'containment is therefore a floor, not an estimate. Add a terminal resolution signal.',
    );
  }
  if (!hasIntent) {
    caveats.push(
      'No `intent` labels found, so returns are matched on customer and time only. The leak rate ' +
        'is an upper bound; some returns are unrelated new issues.',
    );
  } else if (strictIntent) {
    caveats.push(
      'Running with --strict-intent: returns count as leakage only when intent labels match, so ' +
        'the leak rate is a lower bound. Run without the flag for the upper bound and report both.',
    );
  }
  if (summary.unclassified_rate) {
    caveats.push(
      `${(summary.unclassified_rate * 100).toFixed(1)}% of sessions could not be classified as ` +
        'contained or abandoned. Treat true containment as bounded below by the reported figure.',
    );
  }
  const dropped = problems.badJson + problems.missingFields + problems.badDate;
  if (dropped > 0) {
    caveats.push(
      `${dropped} input rows were dropped (${problems.badJson} unparseable, ` +
        `${problems.missingFields} missing required fields, ${problems.badDate} bad dates).`,
    );
  }
  caveats.push(
    'Containment measures what happened to sessions that occurred. It does not establish that ' +
      'the automation reduced total contact volume — some contained sessions would never have ' +
      'become human contacts. Only a randomised holdout answers that.',
  );

  return caveats;
}

function renderText(report) {
  const pct = (v) => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);
  const s = report.summary;
  const lines = [];

  lines.push('');
  lines.push(`Sessions analysed: ${s.eligible_sessions}`);
  lines.push(`Return window:     ${report.parameters.window_days} days`);
  lines.push('');
  lines.push(`  naive containment (no handoff)  ${pct(s.naive_containment_rate)}`);
  lines.push(`  true containment                ${pct(s.true_containment_rate)}`);
  lines.push(`  overstatement                   ${s.overstatement_pp} pp`);
  lines.push('');
  lines.push('  breakdown');
  for (const [bucket, n] of Object.entries(s.counts)) {
    const share = s.eligible_sessions ? ((n / s.eligible_sessions) * 100).toFixed(1) : '0.0';
    lines.push(`    ${bucket.padEnd(10)} ${String(n).padStart(7)}  ${share.padStart(5)}%`);
  }

  if (Object.keys(report.leak_channels).length > 0) {
    lines.push('');
    lines.push('  customers returned via');
    for (const [channel, n] of Object.entries(report.leak_channels).sort((a, b) => b[1] - a[1])) {
      lines.push(`    ${channel.padEnd(20)} ${n}`);
    }
  }

  if (report.by_intent.rows.length > 0) {
    lines.push('');
    lines.push('  by intent (naive -> true, overstatement)');
    for (const row of report.by_intent.rows.slice(0, 15)) {
      lines.push(
        `    ${row.intent.slice(0, 28).padEnd(30)} n=${String(row.sessions).padStart(6)}  ` +
          `${pct(row.naive).padStart(6)} -> ${pct(row.true_containment).padStart(6)}  ` +
          `(+${row.overstatement_pp} pp)`,
      );
    }
    if (report.by_intent.suppressed_sessions > 0) {
      lines.push(
        `    ${report.by_intent.suppressed_sessions} sessions in intents below the ` +
          `${report.by_intent.min_sessions}-session floor are not shown`,
      );
    }
  }

  lines.push('');
  lines.push('  caveats');
  for (const caveat of report.caveats) lines.push(`    - ${caveat}`);
  lines.push('');

  return lines.join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { contacts, problems } = await readContacts(opts.input);

  if (contacts.length === 0) fail('no valid contact records found');

  const botSessions = contacts.filter((c) => c.handledBy === 'bot');
  if (botSessions.length === 0) {
    fail('no records with handled_by="bot"; nothing to measure containment for');
  }
  if (!contacts.some((c) => c.handledBy === 'human')) {
    fail(
      'no records with handled_by="human". Return detection needs human contacts in the same ' +
        'file, otherwise leakage is invisible and the result would just restate the naive rate.',
    );
  }

  const results = classify(contacts, opts);
  const summary = summarise(results);

  const report = {
    parameters: {
      window_days: opts.windowDays,
      strict_intent: opts.strictIntent,
      input: opts.input,
    },
    input: {
      total_records: contacts.length,
      bot_sessions: botSessions.length,
      human_contacts: contacts.length - botSessions.length,
      dropped_rows: problems,
    },
    summary,
    leak_channels: leakChannels(results),
    csat_by_bucket: csatComparison(results),
    by_intent: byIntent(results, opts.minSessions),
    caveats: buildCaveats(
      summary,
      problems,
      botSessions.some((s) => s.resolved !== null),
      contacts.some((c) => c.intent !== null),
      opts.strictIntent,
    ),
  };

  if (!opts.json) process.stderr.write(renderText(report));
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

await main();
