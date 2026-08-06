#!/usr/bin/env node
/**
 * Verifies Rulebase access from the outside: that the region's hosts resolve,
 * that the MCP endpoint is really an MCP endpoint, and that an API key (if one
 * is set) authenticates against the REST API.
 *
 * Read-only. Creates nothing, changes nothing.
 *
 * The key is read from RULEBASE_API_KEY and is never printed, logged, or
 * included in the JSON output — argv and stdout both end up in shell history
 * and chat transcripts.
 *
 * Usage:
 *   RULEBASE_API_KEY=... node scripts/verify-access.mjs --region us
 *   node scripts/verify-access.mjs --region eu        # MCP reachability only
 *
 *   --region us|eu   Which deployment to test. Default: $RULEBASE_REGION or us.
 *   --timeout MS     Per-request timeout. Default 15000.
 */

const args = process.argv.slice(2);

function flag(name, fallback = undefined) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) return true;
  return v;
}

const region = String(flag('region', process.env.RULEBASE_REGION || 'us')).toLowerCase();
if (region !== 'us' && region !== 'eu') {
  console.error(`error: --region must be "us" or "eu" (got "${region}")`);
  process.exit(2);
}
const timeoutMs = Number(flag('timeout', 15000));
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  console.error('error: --timeout must be a positive number of milliseconds');
  process.exit(2);
}

const prefix = region === 'eu' ? 'eu.' : '';

// Origin overrides exist so this script can be exercised against a mock in CI.
// Leave them unset in normal use; the region determines the real hosts.
const mcpOrigin = (process.env.RULEBASE_MCP_ORIGIN || `https://${prefix}mcp.rulebase.co`).replace(/\/$/, '');
const apiV2Origin = (process.env.RULEBASE_API2_ORIGIN || `https://${prefix}api2.rulebase.co`).replace(/\/$/, '');

const hosts = {
  app: `https://${prefix}app.rulebase.co`,
  mcp: `${mcpOrigin}/mcp`,
  apiV1: `https://${prefix}api.rulebase.co`,
  apiV2: apiV2Origin,
};

const apiKey = process.env.RULEBASE_API_KEY;

/** Fetch with a hard timeout, returning a result object instead of throwing. */
async function probe(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal, redirect: 'manual' });
    const text = await res.text().catch(() => '');
    return { ok: true, status: res.status, body: text.slice(0, 400) };
  } catch (err) {
    const reason = err?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : String(err?.message || err);
    return { ok: false, status: null, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const checks = [];
const note = (name, status, detail, extra = {}) => {
  checks.push({ check: name, status, detail, ...extra });
  const label = status === 'pass' ? 'ok  ' : status === 'skip' ? 'skip' : 'FAIL';
  console.error(`${label}  ${name}: ${detail}`);
};

// --- 1. MCP host is reachable and advertises itself as a protected resource ---

const prmUrl = `${mcpOrigin}/.well-known/oauth-protected-resource`;
const prm = await probe(prmUrl);

if (!prm.ok) {
  note('mcp.discovery', 'fail', `could not reach ${prmUrl} — ${prm.error}`);
} else if (prm.status !== 200) {
  note('mcp.discovery', 'fail', `${prmUrl} returned ${prm.status}, expected 200`);
} else {
  const doc = parseJson(prm.body);
  const authServers = Array.isArray(doc?.authorization_servers) ? doc.authorization_servers : [];
  if (!doc?.resource) {
    note('mcp.discovery', 'fail', 'discovery document has no `resource` field');
  } else {
    note(
      'mcp.discovery',
      'pass',
      `resource ${doc.resource}, authorization server ${authServers[0] ?? '(none advertised)'}`,
      { resource: doc.resource, authorizationServers: authServers },
    );
  }
}

// --- 2. The MCP endpoint is the MCP surface (unauthenticated probe) ---
//
// A 401 here is the expected, healthy answer: the server is refusing an
// anonymous caller. What we are really checking is that this hostname is the
// MCP server and not the REST API, because the two return different bodies and
// crossing them over is the most common setup mistake.

const mcpProbe = await probe(hosts.mcp, { method: 'GET', headers: { Accept: 'application/json' } });

if (!mcpProbe.ok) {
  note('mcp.endpoint', 'fail', `could not reach ${hosts.mcp} — ${mcpProbe.error}`);
} else {
  const body = parseJson(mcpProbe.body);
  const err = typeof body?.error === 'string' ? body.error : '';
  if (mcpProbe.status === 401 && /no token/i.test(err)) {
    note('mcp.endpoint', 'pass', `${hosts.mcp} is the MCP surface and requires OAuth (401 "${err}")`);
  } else if (mcpProbe.status === 401 && /unauthoriz/i.test(err)) {
    note(
      'mcp.endpoint',
      'fail',
      `${hosts.mcp} answered like the REST API ("${err}"), not the MCP server — check the hostname`,
    );
  } else if (mcpProbe.status === 401 || mcpProbe.status === 403) {
    note('mcp.endpoint', 'pass', `${hosts.mcp} requires authentication (${mcpProbe.status})`);
  } else {
    note(
      'mcp.endpoint',
      'fail',
      `${hosts.mcp} returned ${mcpProbe.status}; expected 401 from an unauthenticated probe`,
    );
  }
}

// --- 3. API key against REST v2 ---

if (!apiKey) {
  note(
    'api.v2',
    'skip',
    'RULEBASE_API_KEY is not set — skipped. Reading via MCP needs no key; only set one if you push data in.',
  );
} else if (apiKey !== apiKey.trim()) {
  // A trailing newline from `export KEY=$(cat file)` breaks the header and
  // returns the same 401 as a wrong key. Catch it here rather than let the
  // user debug a phantom credential problem.
  note('api.v2', 'fail', 'RULEBASE_API_KEY has leading or trailing whitespace, which breaks the Authorization header');
} else {
  const res = await probe(`${hosts.apiV2}/conversation_uploads?limit=1`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  });

  if (!res.ok) {
    note('api.v2', 'fail', `could not reach ${hosts.apiV2} — ${res.error}`);
  } else if (res.status === 200) {
    const body = parseJson(res.body);
    const shape = body && Object.prototype.hasOwnProperty.call(body, 'data') ? 'envelope present' : 'unexpected body shape';
    note('api.v2', 'pass', `key authenticates against ${hosts.apiV2} (200, ${shape})`);
  } else if (res.status === 401) {
    note(
      'api.v2',
      'fail',
      `401 from ${hosts.apiV2}. Check the region host first (this run tested "${region}"), then the header, then whether the key was revoked`,
    );
  } else {
    note('api.v2', 'fail', `${hosts.apiV2} returned ${res.status}`);
  }
}

// --- summary ---

const failed = checks.filter((c) => c.status === 'fail');
const summary = {
  region,
  hosts,
  // Presence and prefix family only. The key itself never appears here.
  apiKey: apiKey ? { present: true, looksLikeLiveKey: apiKey.startsWith('rk_live_') } : { present: false },
  checks,
  passed: checks.filter((c) => c.status === 'pass').length,
  failed: failed.length,
  skipped: checks.filter((c) => c.status === 'skip').length,
};

console.log(JSON.stringify(summary, null, 2));

if (failed.length > 0) {
  console.error(
    `\n${failed.length} check(s) failed. If the region is wrong, every REST call returns 401 with no hint — re-run with --region ${region === 'us' ? 'eu' : 'us'} to rule it out.`,
  );
  process.exit(1);
}
console.error(`\nAll attempted checks passed (${summary.passed} passed, ${summary.skipped} skipped).`);
