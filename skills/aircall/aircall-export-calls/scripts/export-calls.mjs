#!/usr/bin/env node
/**
 * Exports Aircall calls into conversations.jsonl in the canonical schema.
 * Voice-only: a call has no message list, so no messages.jsonl is written.
 *
 * Three verified Aircall limits drive the design:
 *
 *   1. GET /v1/calls returns at most 10,000 items even with pagination, with no
 *      error. So the export is windowed by time and any window whose meta.total
 *      exceeds the cap is recursively halved. Fixed-period windowing works until
 *      one day is busier than the cap, which is when it silently truncates.
 *   2. Only ~6 months of history is available without a special request, so a
 *      "full history" export silently starts six months ago. The earliest call
 *      retrieved is reported so that ceiling is visible.
 *   3. Recording URLs are valid for one hour, so they cannot be collected during
 *      a long run and downloaded afterwards. Downloads happen inline.
 *
 * Rate limits are read from X-AircallApi-* headers rather than hard-coded,
 * because the published figures disagree (120/min in the API reference, 60/min
 * in some help-centre material) and support can raise them per account.
 *
 * Credentials come from AIRCALL_API_ID and AIRCALL_API_TOKEN only.
 *
 * Usage:
 *   node export-calls.mjs --out ./out --from 2026-07-01 --to 2026-08-01
 *                         [--recordings ./out/recordings] [--resume]
 *                         [--max-window-calls 9000] [--min-window-hours 1]
 */

import { writeFileSync, appendFileSync, readFileSync, existsSync, mkdirSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const API_BASE = (process.env.AIRCALL_BASE_URL || 'https://api.aircall.io/v1').replace(/\/$/, '');

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

const outDir = String(opt('out', './out'));
const recordingsDir = opt('recordings');
const resume = has('resume');
const maxWindowCalls = Number(opt('max-window-calls', 9000));
const minWindowHours = Number(opt('min-window-hours', 1));
const PER_PAGE = 50; // API maximum

if (!Number.isInteger(maxWindowCalls) || maxWindowCalls < 1 || maxWindowCalls > 10000) {
  die('--max-window-calls must be between 1 and 10000 (Aircall caps result sets at 10,000)');
}
if (!Number.isFinite(minWindowHours) || minWindowHours <= 0) die('--min-window-hours must be positive');

const apiId = process.env.AIRCALL_API_ID;
const apiToken = process.env.AIRCALL_API_TOKEN;
if (!apiId || !apiToken) die('AIRCALL_API_ID and AIRCALL_API_TOKEN must be set');

function parseStamp(v, label) {
  if (v === undefined || v === true) die(`--${label} is required (a date or ISO timestamp)`);
  const ms = Date.parse(String(v).length === 10 ? `${v}T00:00:00Z` : String(v));
  if (!Number.isFinite(ms)) die(`--${label} "${v}" is not a parseable date`);
  return Math.floor(ms / 1000);
}
const fromUnix = parseStamp(opt('from'), 'from');
const toUnix = parseStamp(opt('to'), 'to');
if (toUnix <= fromUnix) die('--to must be after --from');

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
if (recordingsDir && recordingsDir !== true && !existsSync(String(recordingsDir))) {
  mkdirSync(String(recordingsDir), { recursive: true });
}
const conversationsPath = join(outDir, 'conversations.jsonl');
const checkpointPath = join(outDir, '.aircall-checkpoint.json');

// ------------------------------------------------------------------ mapping

// `done` is a completed call. `answered` and `initial` are calls still in
// progress, which a historical export rarely sees but can catch at the edge.
const STATUS_MAP = { done: 'closed', answered: 'open', initial: 'open' };

const iso = (unixSeconds) =>
  unixSeconds === null || unixSeconds === undefined ? null : new Date(Number(unixSeconds) * 1000).toISOString();

function normalizeCall(c) {
  return {
    source: 'aircall',
    source_id: String(c.id),
    subject: null,
    status: STATUS_MAP[c.status] ?? 'open',
    status_raw: c.status ?? null,
    channel: 'voice',
    // Aircall has no channel concept — every record is a call — so there is no
    // vendor value to preserve here.
    channel_raw: null,
    customer_id: c.contact?.id != null ? String(c.contact.id) : null,
    assignee_id: c.user?.id != null ? String(c.user.id) : null,
    // teams[] is populated on inbound calls only.
    team_id: Array.isArray(c.teams) && c.teams[0]?.id != null ? String(c.teams[0].id) : null,
    account_id: null,
    created_at: iso(c.started_at),
    updated_at: iso(c.ended_at ?? c.started_at),
    resolved_at: iso(c.ended_at),
    // Not available on this endpoint.
    csat: null,
    csat_raw: null,
    priority: null,
    tags: (c.tags ?? []).map((t) => (typeof t === 'string' ? t : t?.name)).filter((v) => typeof v === 'string'),
    is_deleted: false,

    // Voice-specific values worth keeping. missed_call_reason in particular
    // distinguishes a customer who hung up in the IVR from one nobody answered,
    // which is the difference between an abandonment and a staffing finding.
    direction_raw: c.direction ?? null,
    answered: c.answered_at != null,
    answered_at: iso(c.answered_at),
    missed_call_reason_raw: c.missed_call_reason ?? null,
    duration_seconds: Number.isFinite(c.duration) ? c.duration : null,
    // raw_digits can be the literal string "anonymous"; never treat it as a
    // number and never let it become an identity key.
    raw_digits_present: typeof c.raw_digits === 'string' && c.raw_digits !== 'anonymous',
    has_recording: Boolean(c.recording),
    has_voicemail: Boolean(c.voicemail),
  };
}

// ------------------------------------------------------------------- client

const auth = 'Basic ' + Buffer.from(`${apiId}:${apiToken}`).toString('base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stats = {
  calls: 0,
  windows: 0,
  throttled: 0,
  throttleWaitMs: 0,
  rateLimit: null,
  recordings: { attempted: 0, downloaded: 0, expired: 0, failed: 0 },
  unsplittableWindows: [],
  byDirection: {},
  answeredCount: 0,
  missedReasons: {},
  earliestCall: null,
};

async function apiGet(path, attempt = 0) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: auth, Accept: 'application/json' },
  });

  const limit = res.headers.get('x-aircallapi-limit');
  const remaining = res.headers.get('x-aircallapi-remaining');
  if (limit) stats.rateLimit = { perMinute: Number(limit), remaining: Number(remaining) };

  if (res.status === 429) {
    if (attempt >= 8) die(`rate limited repeatedly on ${path}; giving up after ${attempt} attempts`);
    const reset = Number(res.headers.get('x-aircallapi-reset'));
    // The reset header is a UNIX timestamp for when the window refreshes.
    const waitMs = Number.isFinite(reset) && reset > 0
      ? Math.max(1000, reset * 1000 - Date.now())
      : Math.min(60000, 1000 * 2 ** attempt);
    stats.throttled += 1;
    stats.throttleWaitMs += waitMs;
    console.error(`  throttled — waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1})`);
    await sleep(waitMs);
    return apiGet(path, attempt + 1);
  }

  if (res.status >= 500) {
    if (attempt >= 5) die(`server error ${res.status} on ${path} after ${attempt} retries`);
    await sleep(Math.min(30000, 1000 * 2 ** attempt));
    return apiGet(path, attempt + 1);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    die(`GET ${path} failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return res.json();
}

/** Total calls in a window, from meta.total on a single-item request. */
async function windowTotal(from, to) {
  const payload = await apiGet(`/calls?from=${from}&to=${to}&per_page=1&page=1`);
  return Number(payload?.meta?.total ?? 0);
}

async function downloadRecording(url, destPath) {
  stats.recordings.attempted += 1;
  try {
    const res = await fetch(url);
    if (res.status === 403 || res.status === 404) {
      // The one-hour URL has already expired, or the asset is gone.
      stats.recordings.expired += 1;
      return { ok: false, reason: `expired or missing (${res.status})` };
    }
    if (!res.ok) {
      stats.recordings.failed += 1;
      return { ok: false, reason: `HTTP ${res.status}` };
    }
    await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath));
    stats.recordings.downloaded += 1;
    return { ok: true };
  } catch (err) {
    stats.recordings.failed += 1;
    return { ok: false, reason: String(err?.message || err) };
  }
}

// ---------------------------------------------------------------- checkpoint

function loadCheckpoint() {
  if (!resume || !existsSync(checkpointPath)) return { doneWindows: [] };
  try {
    return JSON.parse(readFileSync(checkpointPath, 'utf8'));
  } catch {
    return { doneWindows: [] };
  }
}
const checkpoint = loadCheckpoint();
const doneWindows = new Set(checkpoint.doneWindows ?? []);
const saveCheckpoint = () =>
  writeFileSync(checkpointPath, JSON.stringify({ doneWindows: [...doneWindows], updatedAt: new Date().toISOString() }));

if (!resume) writeFileSync(conversationsPath, '');

// --------------------------------------------------------------------- run

async function exportWindow(from, to, depth = 0) {
  const key = `${from}-${to}`;
  if (doneWindows.has(key)) return;

  const total = await windowTotal(from, to);
  if (total === 0) {
    doneWindows.add(key);
    return;
  }

  if (total > maxWindowCalls) {
    const spanHours = (to - from) / 3600;
    if (spanHours <= minWindowHours) {
      // Splitting further is not possible. Report it rather than paging into a
      // silent truncation at 10,000.
      stats.unsplittableWindows.push({ from: iso(from), to: iso(to), total, spanHours });
      console.error(
        `  WARNING window ${iso(from)}..${iso(to)} holds ${total} calls in ${spanHours}h and cannot be split below --min-window-hours; it will truncate at Aircall's 10,000 cap`,
      );
    } else {
      const mid = Math.floor((from + to) / 2);
      await exportWindow(from, mid, depth + 1);
      await exportWindow(mid, to, depth + 1);
      return;
    }
  }

  stats.windows += 1;
  let page = 1;
  let fetched = 0;

  while (true) {
    const payload = await apiGet(`/calls?from=${from}&to=${to}&per_page=${PER_PAGE}&page=${page}`);
    const batch = payload?.calls ?? [];
    if (batch.length === 0) break;

    for (const call of batch) {
      const record = normalizeCall(call);
      appendFileSync(conversationsPath, `${JSON.stringify(record)}\n`);
      stats.calls += 1;
      fetched += 1;

      stats.byDirection[record.direction_raw ?? 'unknown'] =
        (stats.byDirection[record.direction_raw ?? 'unknown'] ?? 0) + 1;
      if (record.answered) stats.answeredCount += 1;
      if (record.missed_call_reason_raw) {
        stats.missedReasons[record.missed_call_reason_raw] =
          (stats.missedReasons[record.missed_call_reason_raw] ?? 0) + 1;
      }
      if (record.created_at && (!stats.earliestCall || record.created_at < stats.earliestCall)) {
        stats.earliestCall = record.created_at;
      }

      // Inline, because the URL is valid for an hour and a long run would
      // outlive it.
      if (recordingsDir && recordingsDir !== true) {
        if (call.recording) {
          await downloadRecording(call.recording, join(String(recordingsDir), `${call.id}.mp3`));
        }
        if (call.voicemail) {
          await downloadRecording(call.voicemail, join(String(recordingsDir), `${call.id}-voicemail.mp3`));
        }
      }
    }

    if (!payload?.meta?.next_page_link) break;
    page += 1;
  }

  doneWindows.add(key);
  saveCheckpoint();
  console.error(`  ${iso(from)}..${iso(to)} — ${fetched} call(s) (${stats.calls} total)`);
}

console.error(`exporting Aircall calls ${iso(fromUnix)}..${iso(toUnix)}`);
console.error(`windowing at ${maxWindowCalls} calls, floor ${minWindowHours}h, recordings ${recordingsDir && recordingsDir !== true ? 'ON' : 'off'}`);
console.error('');

await exportWindow(fromUnix, toUnix);

// A ceiling near six months back is Aircall's default history limit, not the
// account's age. Flag it so the export is not read as complete history.
const sixMonthsAgoMs = Date.now() - 183 * 86400000;
const historyCeilingLikely =
  stats.earliestCall !== null &&
  fromUnix * 1000 < sixMonthsAgoMs &&
  Date.parse(stats.earliestCall) - sixMonthsAgoMs < 7 * 86400000;

const summary = {
  source: 'aircall',
  requestedWindow: { from: iso(fromUnix), to: iso(toUnix) },
  earliestCallRetrieved: stats.earliestCall,
  historyCeilingLikely,
  calls: stats.calls,
  windowsFetched: stats.windows,
  byDirection: stats.byDirection,
  answered: stats.answeredCount,
  missed: stats.calls - stats.answeredCount,
  missedReasons: stats.missedReasons,
  recordings: recordingsDir && recordingsDir !== true ? stats.recordings : null,
  unsplittableWindows: stats.unsplittableWindows,
  rateLimit: stats.rateLimit,
  throttled: stats.throttled,
  throttleWaitSeconds: Math.round(stats.throttleWaitMs / 1000),
  output: { conversations: conversationsPath },
  notes: [
    'Aircall caps any result set at 10,000 items with no error, so this export windows by time and recursively halves any window over the cap.',
    'Roughly six months of history is available without a special request to Aircall. An earliest call near that boundary is the ceiling, not the start of the account.',
    'Recording URLs are valid for one hour, so they are downloaded inline and never persisted into the dataset. Store the call id and re-fetch instead.',
    'Voice-only source: no messages.jsonl is produced, per the canonical schema.',
    'missed_call_reason is preserved because it separates an abandonment problem from a staffing one.',
    'raw_digits can be the literal string "anonymous" and must not be used as an identity key.',
    'Recordings are production PII. Do not commit the output.',
  ],
};

console.error('');
console.error(`done: ${stats.calls} call(s) across ${stats.windows} window(s)`);
if (historyCeilingLikely) {
  console.error(`      NOTE earliest call is ${stats.earliestCall} — close to Aircall's ~6 month default history limit.`);
  console.error('           This is the API ceiling, not the start of your account.');
}
if (stats.unsplittableWindows.length) {
  console.error(`      WARNING ${stats.unsplittableWindows.length} window(s) exceed the cap and could not be split — data may be missing`);
}
if (summary.recordings) {
  const r = summary.recordings;
  console.error(`      recordings: ${r.downloaded} downloaded, ${r.expired} expired, ${r.failed} failed of ${r.attempted} attempted`);
}

console.log(JSON.stringify(summary, null, 2));

if (stats.unsplittableWindows.length) process.exit(1);
