#!/usr/bin/env node
/**
 * Exports satisfaction survey responses from a support platform to one canonical
 * shape, so CSAT analysis is written once.
 *
 * Every conversation export in this catalog sets `csat: null` and says CSAT is a
 * separate resource. This is that resource. It is a single skill covering several
 * platforms rather than one skill per vendor, because the hard part is not the
 * endpoints — it is that satisfaction scales differ, and several are
 * account-configurable.
 *
 * On scales, the rule this script follows: normalise only where the scale is
 * FIXED by the platform. Where it is configurable, emit the raw value and a
 * distribution, and require an explicit --scale-map. A guessed mapping produces a
 * number that looks like CSAT and is not.
 *
 * No npm dependencies. Node 20+.
 *
 *   node scripts/export-satisfaction.mjs --platform zendesk --start 90d
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PLATFORMS = ['zendesk', 'freshdesk', 'gorgias', 'hubspot'];

/**
 * Per-platform adapters. `fixedScale: true` means the platform defines the scale
 * and normalising is safe. `fixedScale: false` means the account defines it and
 * a mapping must be supplied.
 */
const ADAPTERS = {
  zendesk: {
    fixedScale: true,
    env: ['ZENDESK_SUBDOMAIN', 'ZENDESK_EMAIL', 'ZENDESK_API_TOKEN'],
    baseUrl: () => process.env.ZENDESK_BASE_URL || `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com`,
    authHeader: () =>
      'Basic ' +
      Buffer.from(`${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_API_TOKEN}`).toString('base64'),
    firstPath: (startEpoch) =>
      `/api/v2/satisfaction_ratings.json?start_time=${startEpoch}&per_page=100`,
    extract: (page) => ({
      records: page.satisfaction_ratings ?? [],
      next: page.next_page ?? null,
    }),
    normalize: (r) => ({
      conversation_source_id: r.ticket_id != null ? String(r.ticket_id) : null,
      response_source_id: String(r.id),
      customer_id: r.requester_id != null ? String(r.requester_id) : null,
      assignee_id: r.assignee_id != null ? String(r.assignee_id) : null,
      created_at: r.created_at ?? null,
      score_raw: r.score ?? null,
      // Fixed by Zendesk: good/bad are the only actual scores. `offered` and
      // `unoffered` mean a survey was or wasn't sent — mapping them to 0 would
      // fabricate negative feedback.
      score: r.score === 'good' ? 1 : r.score === 'bad' ? 0 : null,
      scale: 'binary',
      is_response: r.score === 'good' || r.score === 'bad',
      comment: r.comment ?? null,
    }),
  },

  freshdesk: {
    fixedScale: false,
    env: ['FRESHDESK_DOMAIN', 'FRESHDESK_API_KEY'],
    baseUrl: () => process.env.FRESHDESK_API_BASE || `https://${process.env.FRESHDESK_DOMAIN}.freshdesk.com`,
    authHeader: () => 'Basic ' + Buffer.from(`${process.env.FRESHDESK_API_KEY}:X`).toString('base64'),
    firstPath: (startEpoch) =>
      `/api/v2/surveys/satisfaction_ratings?created_since=${encodeURIComponent(
        new Date(startEpoch * 1000).toISOString(),
      )}&per_page=100&page=1`,
    extract: (page, { pageNumber }) => ({
      records: Array.isArray(page) ? page : [],
      // Freshdesk paginates by page number and gives no next link.
      next: Array.isArray(page) && page.length === 100 ? { pageNumber: pageNumber + 1 } : null,
    }),
    pagePath: (startEpoch, cursor) =>
      `/api/v2/surveys/satisfaction_ratings?created_since=${encodeURIComponent(
        new Date(startEpoch * 1000).toISOString(),
      )}&per_page=100&page=${cursor.pageNumber}`,
    normalize: (r) => {
      // Freshdesk returns a ratings object keyed by question id; the default
      // question is the overall one. Values and their meaning are configurable
      // per account, so no normalisation is attempted.
      const ratings = r.ratings ?? {};
      const keys = Object.keys(ratings);
      const primary = keys.length > 0 ? ratings[keys[0]] : null;
      return {
        conversation_source_id: r.ticket_id != null ? String(r.ticket_id) : null,
        response_source_id: String(r.id),
        customer_id: r.user_id != null ? String(r.user_id) : null,
        assignee_id: r.agent_id != null ? String(r.agent_id) : null,
        created_at: r.created_at ?? null,
        score_raw: primary,
        score: null,
        scale: 'account_configurable',
        is_response: primary !== null && primary !== undefined,
        comment: r.feedback ?? null,
        ratings_raw: ratings,
      };
    },
  },

  gorgias: {
    fixedScale: false,
    env: ['GORGIAS_DOMAIN', 'GORGIAS_EMAIL', 'GORGIAS_API_KEY'],
    baseUrl: () => process.env.GORGIAS_API_BASE || `https://${process.env.GORGIAS_DOMAIN}.gorgias.com`,
    authHeader: () =>
      'Basic ' +
      Buffer.from(`${process.env.GORGIAS_EMAIL}:${process.env.GORGIAS_API_KEY}`).toString('base64'),
    firstPath: () => `/api/satisfaction-surveys?limit=100`,
    extract: (page) => ({
      records: page.data ?? [],
      next: page.meta?.next_cursor ? { cursor: page.meta.next_cursor } : null,
    }),
    pagePath: (startEpoch, cursor) =>
      `/api/satisfaction-surveys?limit=100&cursor=${encodeURIComponent(cursor.cursor)}`,
    normalize: (r) => ({
      conversation_source_id: r.ticket_id != null ? String(r.ticket_id) : null,
      response_source_id: String(r.id),
      customer_id: r.customer_id != null ? String(r.customer_id) : null,
      assignee_id: null,
      created_at: r.created_datetime ?? r.created_at ?? null,
      score_raw: r.score ?? null,
      score: null,
      scale: 'account_configurable',
      is_response: r.score !== null && r.score !== undefined,
      comment: r.body_text ?? r.comment ?? null,
    }),
  },

  hubspot: {
    fixedScale: false,
    env: ['HUBSPOT_ACCESS_TOKEN'],
    baseUrl: () => process.env.HUBSPOT_API_BASE || 'https://api.hubapi.com',
    authHeader: () => `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
    bearer: true,
    firstPath: () =>
      `/crm/v3/objects/feedback_submissions?limit=100&properties=` +
      `hs_survey_type,hs_value,hs_response_group,hs_submission_timestamp,hs_content,hs_survey_id`,
    extract: (page) => ({
      records: page.results ?? [],
      next: page.paging?.next?.after ? { after: page.paging.next.after } : null,
    }),
    pagePath: (startEpoch, cursor) =>
      `/crm/v3/objects/feedback_submissions?limit=100&after=${encodeURIComponent(cursor.after)}` +
      `&properties=hs_survey_type,hs_value,hs_response_group,hs_submission_timestamp,hs_content,hs_survey_id`,
    normalize: (r) => {
      const p = r.properties ?? {};
      return {
        conversation_source_id: null, // Association requires a separate call.
        response_source_id: String(r.id),
        customer_id: null,
        assignee_id: null,
        created_at: p.hs_submission_timestamp ?? r.createdAt ?? null,
        score_raw: p.hs_value ?? null,
        score: null,
        scale: 'account_configurable',
        is_response: p.hs_value !== null && p.hs_value !== undefined && p.hs_value !== '',
        comment: p.hs_content ?? null,
        survey_type: p.hs_survey_type ?? null,
        response_group: p.hs_response_group ?? null,
      };
    },
  },
};

function parseArgs(argv) {
  const opts = {
    platform: null,
    start: null,
    out: null,
    scaleMap: null,
    maxPages: Infinity,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${arg} requires a value`);
      return v;
    };
    switch (arg) {
      case '--platform': opts.platform = next(); break;
      case '--start': opts.start = next(); break;
      case '--out': opts.out = next(); break;
      case '--scale-map': opts.scaleMap = next(); break;
      case '--max-pages': opts.maxPages = Number(next()); break;
      case '--json': opts.json = true; break;
      case '--help': case '-h': usage(); process.exit(0);
      default: fail(`unknown argument: ${arg}`);
    }
  }
  if (!opts.platform) fail(`--platform is required (one of: ${PLATFORMS.join(', ')})`);
  if (!PLATFORMS.includes(opts.platform)) {
    fail(`--platform must be one of: ${PLATFORMS.join(', ')}`);
  }
  if (!opts.start) fail('--start is required');
  opts.out ??= `./out/${opts.platform}-satisfaction`;
  return opts;
}

function usage() {
  process.stderr.write(`
Usage: node scripts/export-satisfaction.mjs --platform <p> --start <when> [options]

  --platform <p>       ${PLATFORMS.join(' | ')}
  --start <when>       ISO date, epoch seconds, or a relative window like 90d.
  --out <dir>          Output directory. Default ./out/<platform>-satisfaction.
  --scale-map <path>   JSON mapping raw score values to a 0-1 fraction, for
                       platforms whose scale is account-configurable.
                       e.g. {"103": 1, "102": 0.75, "-103": 0}
  --max-pages <n>      Stop after n pages. Use to sample.

Intercom is not listed: its rating is on the conversation object and is already
captured by intercom-export-conversations. Front has no native CSAT. Five9
surveys come from a separate report.
`);
}

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function log(message) {
  process.stderr.write(`${message}\n`);
}

function resolveStart(input) {
  const relative = /^(\d+)([hdw])$/.exec(String(input).trim());
  if (relative) {
    const [, n, unit] = relative;
    const ms = { h: 3_600_000, d: 86_400_000, w: 604_800_000 }[unit];
    return Math.floor((Date.now() - Number(n) * ms) / 1000);
  }
  if (/^\d{9,11}$/.test(String(input).trim())) return Number(input);
  const parsed = Date.parse(input);
  if (Number.isNaN(parsed)) fail(`could not parse --start "${input}"`);
  return Math.floor(parsed / 1000);
}

async function fetchPage(adapter, path, attempt = 1) {
  const url = path.startsWith('http') ? path : `${adapter.baseUrl()}${path}`;
  let res;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: adapter.authHeader(),
        Accept: 'application/json',
      },
    });
  } catch (err) {
    if (attempt > 4) fail(`network error after 4 attempts: ${err.message}`);
    await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
    return fetchPage(adapter, path, attempt + 1);
  }

  if (res.status === 429) {
    const header = Number(res.headers.get('retry-after'));
    const wait = Number.isFinite(header) && header >= 0 ? header : 30;
    log(`  rate limited; waiting ${wait}s`);
    await new Promise((r) => setTimeout(r, (wait + 1) * 1000));
    return fetchPage(adapter, path, attempt);
  }
  if (res.status === 401 || res.status === 403) {
    fail(
      `${res.status} from the platform. Satisfaction data often needs a scope or permission ` +
        `separate from ticket read access — check that first.`,
    );
  }
  if (res.status === 404) {
    fail(
      `404 on ${path}. This platform's satisfaction resource may be unavailable on your plan, or ` +
        `surveys may not be enabled on the account.`,
    );
  }
  if (!res.ok) fail(`${res.status} ${res.statusText} on ${path}: ${(await res.text()).slice(0, 300)}`);

  return res.json();
}

function loadScaleMap(path) {
  if (!existsSync(path)) fail(`--scale-map ${path} does not exist`);
  let map;
  try {
    map = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(`--scale-map is not valid JSON: ${err.message}`);
  }
  for (const [key, value] of Object.entries(map)) {
    if (typeof value !== 'number' || value < 0 || value > 1) {
      fail(`--scale-map value for "${key}" must be a number between 0 and 1`);
    }
  }
  return map;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const adapter = ADAPTERS[opts.platform];

  for (const name of adapter.env) {
    if (!process.env[name]) fail(`${name} is not set for --platform ${opts.platform}`);
  }

  const startEpoch = resolveStart(opts.start);
  const scaleMap = opts.scaleMap ? loadScaleMap(opts.scaleMap) : null;

  mkdirSync(opts.out, { recursive: true });
  const outPath = join(opts.out, 'satisfaction.jsonl');
  writeFileSync(outPath, '');

  log(`${opts.platform} satisfaction export since ${new Date(startEpoch * 1000).toISOString()}`);
  log(`output: ${outPath}`);

  let path = adapter.firstPath(startEpoch);
  let cursor = { pageNumber: 1 };
  let pages = 0;
  let total = 0;
  let responses = 0;
  const rawDistribution = {};
  const started = Date.now();

  while (path && pages < opts.maxPages) {
    const page = await fetchPage(adapter, path);
    const { records, next } = adapter.extract(page, cursor);
    pages++;

    const normalized = records.map((r) => {
      const record = { source: opts.platform, ...adapter.normalize(r) };
      // Apply the operator-supplied mapping where the platform's scale is not fixed.
      if (record.score === null && scaleMap && record.score_raw !== null) {
        const mapped = scaleMap[String(record.score_raw)];
        if (typeof mapped === 'number') {
          record.score = mapped;
          record.scale = 'mapped';
        }
      }
      if (record.score_raw !== null && record.score_raw !== undefined) {
        const key = String(record.score_raw);
        rawDistribution[key] = (rawDistribution[key] ?? 0) + 1;
      }
      if (record.is_response) responses++;
      return record;
    });

    if (normalized.length > 0) {
      appendFileSync(outPath, normalized.map((r) => JSON.stringify(r)).join('\n') + '\n');
    }
    total += normalized.length;
    log(`  page ${pages}: ${normalized.length} records (${total} total)`);

    if (!next) break;
    if (typeof next === 'string') {
      path = next;
    } else {
      cursor = next;
      if (!adapter.pagePath) break;
      path = adapter.pagePath(startEpoch, cursor);
    }
  }

  const unmapped = Object.keys(rawDistribution).filter(
    (key) => !scaleMap || typeof scaleMap[key] !== 'number',
  );
  const needsMapping = !adapter.fixedScale && (!scaleMap || unmapped.length > 0);

  const summary = {
    platform: opts.platform,
    out_dir: opts.out,
    out_path: outPath,
    since: new Date(startEpoch * 1000).toISOString(),
    pages,
    records: total,
    responses,
    scale_is_fixed_by_platform: adapter.fixedScale,
    scale_map_supplied: Boolean(scaleMap),
    raw_score_distribution: rawDistribution,
    unmapped_raw_values: needsMapping ? unmapped : [],
    // Boolean(): `scaleMap && …` yields null when no map was supplied, and a
    // consumer checking `=== false` would miss it.
    normalised: Boolean(adapter.fixedScale || (scaleMap && unmapped.length === 0)),
    elapsed_seconds: Math.round((Date.now() - started) / 1000),
    caveats: buildCaveats(opts, adapter, { total, responses, rawDistribution, needsMapping, unmapped }),
  };

  if (!opts.json) process.stderr.write(render(summary));
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

function buildCaveats(opts, adapter, { total, responses, rawDistribution, needsMapping, unmapped }) {
  const caveats = [];

  if (needsMapping) {
    caveats.push(
      `${opts.platform} satisfaction scales are configured per account, so no normalised score was ` +
        `produced. Observed raw values: ${unmapped.join(', ') || '(none)'}. Supply --scale-map to ` +
        `translate them to a 0-1 fraction. A guessed mapping would produce a number that looks ` +
        `like CSAT and is not.`,
    );
  }
  if (opts.platform === 'zendesk') {
    caveats.push(
      'Zendesk `offered` and `unoffered` are not scores — they record that a survey was or was not ' +
        'sent. They are exported with score null and is_response false. Counting them as negative ' +
        'fabricates dissatisfaction; counting them in the denominator of a response rate is correct.',
    );
  }
  if (opts.platform === 'hubspot') {
    caveats.push(
      'HubSpot feedback submissions carry no conversation or contact id in this export; the ' +
        'associations API is a separate call. Without it, responses cannot be joined to ' +
        'conversations or customers.',
    );
  }
  if (total > 0 && responses === 0) {
    caveats.push(
      'No records carry an actual score. Either surveys are configured but unanswered, or the ' +
        'score field differs on this account — inspect a raw record before trusting the count.',
    );
  }
  caveats.push(
    'This is the response set only. Response bias is the dominant uncertainty in any survey ' +
      'metric, and measuring it needs the contacts that did NOT respond. See cx-survey-design.',
  );

  return caveats;
}

function render(summary) {
  const lines = [''];
  lines.push(`platform:   ${summary.platform}`);
  lines.push(`records:    ${summary.records} (${summary.responses} with an actual score)`);
  lines.push(`normalised: ${summary.normalised ? 'yes' : 'NO — raw values only'}`);

  const entries = Object.entries(summary.raw_score_distribution).sort((a, b) => b[1] - a[1]);
  if (entries.length > 0) {
    lines.push('');
    lines.push('  raw score distribution');
    for (const [value, count] of entries.slice(0, 15)) {
      lines.push(`    ${String(value).padEnd(20)} ${count}`);
    }
  }

  lines.push('');
  lines.push('  caveats');
  for (const caveat of summary.caveats) lines.push(`    - ${caveat}`);
  lines.push('');

  return lines.join('\n');
}

await main();
