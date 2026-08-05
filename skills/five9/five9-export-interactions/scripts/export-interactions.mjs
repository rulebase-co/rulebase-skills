#!/usr/bin/env node
/**
 * Exports Five9 interaction (call log) data to the canonical
 * conversations.jsonl shape, via the Five9 reporting SOAP API.
 *
 * Five9 has no REST list endpoint for historical interactions. The path is a
 * three-step asynchronous report:
 *
 *   runReport(folder, report, criteria)  -> identifier
 *   isReportRunning(identifier)          -> poll until false
 *   getReportResultCsv(identifier)       -> CSV
 *
 * Each report returns at most 50,000 records, so the export walks the requested
 * range in time windows and runs one report per window. Five9's own guidance is
 * to split large ranges rather than request them in one call.
 *
 * Report columns are defined by the report in your Five9 tenant, not by the API,
 * so column mapping is header-driven and tolerant: known headers map to canonical
 * fields, unrecognised ones are preserved under `extra`, and missing critical
 * headers are reported rather than silently nulled.
 *
 * No npm dependencies. Node 20+.
 *
 * Credentials (environment only):
 *   FIVE9_USERNAME     API user with the ADMIN and REPORTING roles
 *   FIVE9_PASSWORD
 *   FIVE9_WSDL_URL     full endpoint for your tenant's admin web service.
 *                      Tenant- and region-specific; take it from your Five9
 *                      documentation. There is no safe default.
 *
 * Optional:
 *   FIVE9_REPORT_FOLDER  default "Call Log Reports"
 *   FIVE9_REPORT_NAME    default "Call Log"
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Five9 caps a single report result at 50,000 records.
const REPORT_RECORD_CAP = 50_000;
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 15 * 60 * 1000;

function parseArgs(argv) {
  const opts = {
    start: null,
    end: null,
    out: './out/five9',
    windowHours: 24,
    resume: false,
    dedupeSegments: true,
    maxWindows: Infinity,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${arg} requires a value`);
      return v;
    };
    switch (arg) {
      case '--start': opts.start = next(); break;
      case '--end': opts.end = next(); break;
      case '--out': opts.out = next(); break;
      case '--window-hours': opts.windowHours = Number(next()); break;
      case '--max-windows': opts.maxWindows = Number(next()); break;
      case '--resume': opts.resume = true; break;
      case '--keep-segments': opts.dedupeSegments = false; break;
      case '--help': case '-h': usage(); process.exit(0);
      default: fail(`unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(opts.windowHours) || opts.windowHours <= 0) {
    fail('--window-hours must be a positive number');
  }
  return opts;
}

function usage() {
  process.stderr.write(`
Usage: node scripts/export-interactions.mjs --start <when> [--end <when>] [options]

  --start <when>        Required unless --resume. ISO date/timestamp, epoch
                        seconds, or a relative window like 30d / 12h.
  --end <when>          Defaults to now.
  --out <dir>           Output directory (default ./out/five9).
  --window-hours <n>    Hours per report window (default 24). Lower this if a
                        window hits the 50,000-record cap.
  --resume              Continue from checkpoint.json in --out.
  --keep-segments       Keep every call-log row. By default, rows sharing a call
                        id are collapsed into one interaction.
  --max-windows <n>     Stop after n windows. Use to sample.

Environment: FIVE9_USERNAME, FIVE9_PASSWORD, FIVE9_WSDL_URL
             FIVE9_REPORT_FOLDER, FIVE9_REPORT_NAME (optional)
`);
}

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function log(message) {
  process.stderr.write(`${message}\n`);
}

function resolveTime(input) {
  const relative = /^(\d+)([hdw])$/.exec(String(input).trim());
  if (relative) {
    const [, n, unit] = relative;
    const ms = { h: 3_600_000, d: 86_400_000, w: 604_800_000 }[unit];
    return new Date(Date.now() - Number(n) * ms);
  }
  if (/^\d{9,11}$/.test(String(input).trim())) return new Date(Number(input) * 1000);
  const parsed = Date.parse(input);
  if (Number.isNaN(parsed)) {
    fail(`could not parse time "${input}". Use 2026-01-01, an epoch, or 30d.`);
  }
  return new Date(parsed);
}

function requireEnv(name, hint = '') {
  const value = process.env[name];
  if (!value) fail(`${name} is not set.${hint ? ` ${hint}` : ''}`);
  return value;
}

const xmlEscape = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/**
 * Minimal SOAP client for the three reporting methods. Envelopes are built by
 * hand rather than from the WSDL: the method set is tiny and fixed, and a WSDL
 * parser would be a dependency for no benefit.
 */
class Five9Client {
  constructor({ username, password, wsdlUrl }) {
    this.endpoint = wsdlUrl.replace(/\?wsdl.*$/i, '');
    this.auth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    this.requestCount = 0;
  }

  #envelope(bodyXml) {
    return (
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" ' +
      'xmlns:ser="http://service.admin.ws.five9.com/">' +
      '<soapenv:Header/><soapenv:Body>' +
      bodyXml +
      '</soapenv:Body></soapenv:Envelope>'
    );
  }

  async #call(action, bodyXml, attempt = 1) {
    this.requestCount++;
    let res;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: this.auth,
          'Content-Type': 'text/xml; charset=utf-8',
          SOAPAction: action,
        },
        body: this.#envelope(bodyXml),
      });
    } catch (err) {
      if (attempt > 4) fail(`network error after 4 attempts: ${err.message}`);
      const backoff = 2 ** attempt * 1000;
      log(`  network error (${err.message}); retrying in ${backoff / 1000}s`);
      await new Promise((r) => setTimeout(r, backoff));
      return this.#call(action, bodyXml, attempt + 1);
    }

    const text = await res.text();

    if (res.status === 401 || res.status === 403) {
      fail(
        `${res.status} from Five9. Check FIVE9_USERNAME / FIVE9_PASSWORD, that the user holds both ` +
          `the ADMIN and REPORTING roles, and that FIVE9_WSDL_URL is the endpoint for your tenant's ` +
          `region — a valid user against the wrong region's host also returns 401.`,
      );
    }

    if (res.status === 429 || res.status >= 500) {
      // SOAP faults arrive with a 500, so distinguish a fault from a transport
      // error before retrying.
      const fault = extractTag(text, 'faultstring');
      if (fault && res.status === 500) {
        fail(`Five9 SOAP fault on ${action}: ${fault}`);
      }
      if (attempt > 4) fail(`Five9 returned ${res.status} four times on ${action}; aborting`);
      const backoff = 2 ** attempt * 1000;
      log(`  ${res.status} from Five9; retrying in ${backoff / 1000}s`);
      await new Promise((r) => setTimeout(r, backoff));
      return this.#call(action, bodyXml, attempt + 1);
    }

    if (!res.ok) {
      const fault = extractTag(text, 'faultstring');
      fail(`${res.status} on ${action}${fault ? `: ${fault}` : `\n${text.slice(0, 500)}`}`);
    }

    return text;
  }

  /** Five9 expects local-tenant ISO timestamps without a trailing Z. */
  static formatTime(date) {
    return date.toISOString().replace(/\.\d{3}Z$/, '.000');
  }

  async runReport(folder, report, start, end) {
    const body =
      '<ser:runReport>' +
      `<folderName>${xmlEscape(folder)}</folderName>` +
      `<reportName>${xmlEscape(report)}</reportName>` +
      '<criteria>' +
      '<time>' +
      `<start>${Five9Client.formatTime(start)}</start>` +
      `<end>${Five9Client.formatTime(end)}</end>` +
      '</time>' +
      '</criteria>' +
      '</ser:runReport>';

    const xml = await this.#call('runReport', body);
    const identifier = extractTag(xml, 'return');
    if (!identifier) {
      fail(`runReport returned no identifier. Response began: ${xml.slice(0, 300)}`);
    }
    return identifier;
  }

  async isReportRunning(identifier) {
    const body =
      '<ser:isReportRunning>' +
      `<identifier>${xmlEscape(identifier)}</identifier>` +
      '<timeout>10</timeout>' +
      '</ser:isReportRunning>';
    const xml = await this.#call('isReportRunning', body);
    return extractTag(xml, 'return') === 'true';
  }

  async getReportResultCsv(identifier) {
    const body =
      '<ser:getReportResultCsv>' +
      `<identifier>${xmlEscape(identifier)}</identifier>` +
      '</ser:getReportResultCsv>';
    const xml = await this.#call('getReportResultCsv', body);
    const csv = extractTag(xml, 'return');
    if (csv === null) {
      fail(`getReportResultCsv returned no payload. Response began: ${xml.slice(0, 300)}`);
    }
    return unescapeXml(csv);
  }

  async waitForReport(identifier) {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    for (;;) {
      if (!(await this.isReportRunning(identifier))) return;
      if (Date.now() > deadline) {
        fail(
          `report ${identifier} still running after ${POLL_TIMEOUT_MS / 60000} minutes. ` +
            `Reduce --window-hours so each report covers less data.`,
        );
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }
}

/** Pulls the text of the first matching tag, ignoring namespace prefixes. */
function extractTag(xml, tag) {
  const match = new RegExp(`<(?:[a-zA-Z0-9_-]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[a-zA-Z0-9_-]+:)?${tag}>`).exec(xml);
  return match ? match[1] : null;
}

function unescapeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#13;/g, '\r')
    .replace(/&#10;/g, '\n')
    .replace(/&amp;/g, '&');
}

/**
 * RFC 4180 CSV parser. Report cells routinely contain commas (dispositions,
 * notes) and embedded newlines, so a split(',') implementation corrupts rows
 * silently — which is worse than failing.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\r') {
      // Swallow; the \n branch closes the row.
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((c) => c !== ''));
}

/**
 * Header aliases for the columns this export needs. Five9 report columns are
 * configurable per tenant, so several spellings are accepted and anything
 * unmatched is preserved rather than dropped.
 */
const COLUMN_ALIASES = {
  call_id: ['call id', 'callid', 'call_id', 'session id', 'sessionid'],
  timestamp: ['timestamp', 'date', 'call time', 'start time', 'datetime'],
  agent: ['agent', 'agent name', 'agent full name'],
  customer: ['ani', 'customer', 'customer phone', 'from', 'caller id'],
  dnis: ['dnis', 'to', 'dialed number'],
  campaign: ['campaign', 'campaign name'],
  skill: ['skill', 'skill name', 'queue'],
  disposition: ['disposition', 'disposition name', 'call disposition'],
  call_type: ['call type', 'calltype', 'direction'],
  talk_time: ['talk time', 'talktime'],
  handle_time: ['handle time', 'handletime'],
  queue_time: ['queue wait time', 'queue time', 'wait time'],
  duration: ['call time', 'duration', 'total duration'],
};

const norm = (h) => String(h).trim().toLowerCase().replace(/\s+/g, ' ');

function buildColumnMap(headers) {
  const normalized = headers.map(norm);
  const map = {};
  const used = new Set();

  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const alias of aliases) {
      const index = normalized.indexOf(alias);
      if (index !== -1 && !used.has(index)) {
        map[field] = index;
        used.add(index);
        break;
      }
    }
  }

  const extras = headers
    .map((h, i) => ({ header: h.trim(), index: i }))
    .filter(({ index }) => !used.has(index) && headers[index].trim() !== '');

  return { map, extras };
}

/**
 * Every call-log row is a call that already ended, so the canonical status is
 * always `closed`. The interesting distinction — answered vs abandoned vs
 * voicemail — lives in the disposition, which is preserved verbatim in
 * `status_raw` rather than being flattened into the canonical enum.
 */
const CANONICAL_STATUS = 'closed';

/** True when the disposition indicates the customer never reached an agent. */
function isAbandoned(disposition) {
  return /abandon|dropped|no answer|busy|cancel/i.test(String(disposition ?? ''));
}

const toIso = (value) => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
};

function rowToConversation(row, { map, extras }) {
  const at = (field) => (map[field] === undefined ? null : (row[map[field]] ?? null) || null);

  const extra = {};
  for (const { header, index } of extras) {
    const value = row[index];
    if (value !== undefined && value !== '') extra[header] = value;
  }

  const disposition = at('disposition');
  const timestamp = toIso(at('timestamp'));

  return {
    source: 'five9',
    source_id: at('call_id'),
    subject: at('campaign') ?? at('skill') ?? null,
    status: CANONICAL_STATUS,
    status_raw: disposition,
    abandoned: isAbandoned(disposition),
    // Five9 is a voice platform; every interaction here is a call.
    channel: 'voice',
    channel_raw: at('call_type'),
    customer_id: at('customer'),
    assignee_id: at('agent'),
    team_id: at('skill'),
    account_id: null,
    created_at: timestamp,
    updated_at: timestamp,
    resolved_at: timestamp,
    // Five9 post-call survey data lives in a separate report; not inferred here.
    csat: null,
    csat_raw: null,
    priority: null,
    tags: [at('campaign'), at('skill')].filter(Boolean),
    is_deleted: false,
    extra,
  };
}

/**
 * One customer call can produce several call-log rows (transfer, conference,
 * consult). Collapsing on call id gives one interaction per call, which is what
 * volume and containment analyses need.
 */
function dedupeBySegment(conversations) {
  const byId = new Map();
  let collapsed = 0;

  for (const c of conversations) {
    if (!c.source_id) continue;
    const existing = byId.get(c.source_id);
    if (!existing) {
      byId.set(c.source_id, { ...c, segment_count: 1 });
      continue;
    }
    collapsed++;
    existing.segment_count++;
    // Keep the earliest start and the last agent to touch the call.
    if (c.created_at && (!existing.created_at || c.created_at < existing.created_at)) {
      existing.created_at = c.created_at;
    }
    if (c.updated_at && (!existing.updated_at || c.updated_at > existing.updated_at)) {
      existing.updated_at = c.updated_at;
      existing.resolved_at = c.updated_at;
      if (c.assignee_id) existing.assignee_id = c.assignee_id;
      if (c.status_raw) existing.status_raw = c.status_raw;
    }
  }

  return { conversations: [...byId.values()], collapsed };
}

function* timeWindows(start, end, windowHours) {
  const step = windowHours * 3_600_000;
  let cursor = start.getTime();
  while (cursor < end.getTime()) {
    const windowEnd = new Date(Math.min(cursor + step, end.getTime()));
    yield { start: new Date(cursor), end: windowEnd };
    cursor = windowEnd.getTime();
  }
}

class Checkpoint {
  constructor(dir) {
    this.path = join(dir, 'checkpoint.json');
    this.state = { start: null, end: null, windowHours: null, completedWindows: [] };
  }
  load() {
    if (!existsSync(this.path)) fail(`--resume passed but no checkpoint at ${this.path}`);
    this.state = JSON.parse(readFileSync(this.path, 'utf8'));
    return this.state;
  }
  save(patch) {
    Object.assign(this.state, patch, { updatedAt: new Date().toISOString() });
    writeFileSync(this.path, JSON.stringify(this.state, null, 2));
  }
  isDone(key) {
    return (this.state.completedWindows ?? []).includes(key);
  }
  complete(key) {
    (this.state.completedWindows ??= []).push(key);
    this.save({});
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const client = new Five9Client({
    username: requireEnv('FIVE9_USERNAME'),
    password: requireEnv('FIVE9_PASSWORD'),
    wsdlUrl: requireEnv(
      'FIVE9_WSDL_URL',
      'This is tenant- and region-specific; take it from your Five9 documentation. There is no safe default.',
    ),
  });

  const folder = process.env.FIVE9_REPORT_FOLDER || 'Call Log Reports';
  const report = process.env.FIVE9_REPORT_NAME || 'Call Log';

  mkdirSync(opts.out, { recursive: true });
  const ckpt = new Checkpoint(opts.out);

  let start;
  let end;
  if (opts.resume) {
    ckpt.load();
    start = new Date(ckpt.state.start);
    end = new Date(ckpt.state.end);
    opts.windowHours = ckpt.state.windowHours ?? opts.windowHours;
    log(`resuming from ${ckpt.path} (${ckpt.state.completedWindows.length} windows done)`);
  } else {
    if (!opts.start) fail('--start is required (or use --resume)');
    start = resolveTime(opts.start);
    end = opts.end ? resolveTime(opts.end) : new Date();
    if (start >= end) fail('--start must be before --end');
    ckpt.save({
      start: start.toISOString(),
      end: end.toISOString(),
      windowHours: opts.windowHours,
      completedWindows: [],
    });
  }

  const windows = [...timeWindows(start, end, opts.windowHours)];
  log(`Five9 export ${start.toISOString()} -> ${end.toISOString()}`);
  log(`report "${folder}" / "${report}", ${windows.length} window(s) of ${opts.windowHours}h`);

  const conversationsPath = join(opts.out, 'conversations.jsonl');
  const started = Date.now();
  let totalRows = 0;
  let totalConversations = 0;
  let totalCollapsed = 0;
  let cappedWindows = 0;
  let processed = 0;
  let columnsReported = false;

  for (const window of windows) {
    if (processed >= opts.maxWindows) break;
    const key = `${window.start.toISOString()}_${window.end.toISOString()}`;
    if (ckpt.isDone(key)) continue;

    log(`  window ${window.start.toISOString()} -> ${window.end.toISOString()}`);
    const identifier = await client.runReport(folder, report, window.start, window.end);
    await client.waitForReport(identifier);
    const csv = await client.getReportResultCsv(identifier);

    const rows = parseCsv(csv);
    if (rows.length === 0) {
      log('    no rows');
      ckpt.complete(key);
      processed++;
      continue;
    }

    const [headers, ...dataRows] = rows;
    const columns = buildColumnMap(headers);

    if (!columnsReported) {
      const missing = ['call_id', 'timestamp'].filter((f) => columns.map[f] === undefined);
      if (missing.length > 0) {
        log(
          `    WARNING: report is missing expected column(s): ${missing.join(', ')}. ` +
            `Headers seen: ${headers.map((h) => h.trim()).filter(Boolean).join(', ')}`,
        );
        if (columns.map.call_id === undefined && opts.dedupeSegments) {
          fail(
            'no call id column found, so call segments cannot be collapsed. Add a Call ID column ' +
              'to the report, or re-run with --keep-segments to export raw rows.',
          );
        }
      }
      log(`    mapped columns: ${Object.keys(columns.map).join(', ')}`);
      columnsReported = true;
    }

    let conversations = dataRows.map((row) => rowToConversation(row, columns));
    totalRows += dataRows.length;

    if (opts.dedupeSegments) {
      const result = dedupeBySegment(conversations);
      conversations = result.conversations;
      totalCollapsed += result.collapsed;
    }

    if (conversations.length > 0) {
      appendFileSync(
        conversationsPath,
        conversations.map((c) => JSON.stringify(c)).join('\n') + '\n',
      );
    }
    totalConversations += conversations.length;

    // A window at exactly the cap is almost certainly truncated.
    if (dataRows.length >= REPORT_RECORD_CAP) {
      cappedWindows++;
      log(
        `    WARNING: this window returned ${dataRows.length} rows, at or above Five9's ` +
          `${REPORT_RECORD_CAP}-record cap. Data is likely truncated — re-run with a smaller ` +
          `--window-hours.`,
      );
    }

    log(`    ${dataRows.length} rows -> ${conversations.length} interactions`);
    ckpt.complete(key);
    processed++;
  }

  const elapsed = Math.round((Date.now() - started) / 1000);
  log(
    `done in ${elapsed}s using ${client.requestCount} SOAP calls ` +
      `(${totalRows} rows, ${totalConversations} interactions)`,
  );
  if (cappedWindows > 0) {
    log(`WARNING: ${cappedWindows} window(s) hit the record cap; the export is incomplete.`);
  }

  process.stdout.write(
    JSON.stringify(
      {
        rows: totalRows,
        conversations: totalConversations,
        segments_collapsed: totalCollapsed,
        capped_windows: cappedWindows,
        windows_completed: ckpt.state.completedWindows.length,
        windows_total: windows.length,
        complete: cappedWindows === 0 && ckpt.state.completedWindows.length === windows.length,
        out_dir: opts.out,
        report: { folder, name: report },
        soap_calls: client.requestCount,
        elapsed_seconds: elapsed,
      },
      null,
      2,
    ) + '\n',
  );
}

// Allow the CSV parser to be imported by tests without running the export.
if (process.argv[1] && process.argv[1].endsWith('export-interactions.mjs')) {
  await main();
}
