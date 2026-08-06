/**
 * `rulebase doctor` — work out which region your credential belongs to, and
 * what is reachable.
 *
 * The reason this is the flagship command: a valid API key sent to the wrong
 * region returns `401 {"error":"Unauthorized"}`, which is byte-identical to what
 * a revoked or mistyped key returns. Nothing in the response distinguishes them,
 * so people burn hours on a credentials problem they do not have.
 *
 * So doctor does not trust the region it was given. It tries both and tells you
 * which one answers.
 */

import { REGIONS, hostsFor, apiKey, redactKey, requestedRegion } from '../config.js';
import { probe, bearer } from '../http.js';

/**
 * Cheapest authenticated read on v2. It only lists, so it is safe to run against
 * a live organization, and it returns an envelope even when nothing has been
 * uploaded.
 */
const V2_PROBE = '/conversation_uploads?limit=1';

async function checkRegion(region, key) {
  const hosts = hostsFor(region);
  const result = { region, hosts, api: null, mcp: null };

  if (key) {
    const res = await probe(`${hosts.apiV2}${V2_PROBE}`, { headers: bearer(key) });
    if (!res.ok) {
      result.api = { state: 'unreachable', detail: res.error };
    } else if (res.status === 200) {
      result.api = { state: 'authenticated', detail: `200 from ${hosts.apiV2}` };
    } else if (res.status === 401) {
      result.api = { state: 'rejected', detail: '401 Unauthorized' };
    } else {
      result.api = { state: 'unexpected', detail: `HTTP ${res.status}` };
    }
  }

  // The MCP server's own 401 body differs from the REST API's, which is how you
  // tell you have reached the right surface: "No token provided" is MCP,
  // "Unauthorized" is REST.
  const mcp = await probe(`${hosts.mcp}/.well-known/oauth-protected-resource`);
  if (!mcp.ok) {
    result.mcp = { state: 'unreachable', detail: mcp.error };
  } else if (mcp.status === 200 && mcp.json?.resource) {
    result.mcp = {
      state: 'reachable',
      detail: `${mcp.json.resource}`,
      authorizationServer: mcp.json.authorization_servers?.[0] ?? null,
    };
  } else {
    result.mcp = { state: 'unexpected', detail: `HTTP ${mcp.status} from discovery` };
  }

  return result;
}

export async function doctor(flags) {
  const asked = requestedRegion(flags);
  const key = apiKey();
  const lines = [];
  const say = (s = '') => lines.push(s);

  say('');
  say('Rulebase doctor');
  say('');

  if (!key.present) {
    say('  api key   not set (RULEBASE_API_KEY)');
    say('            Reading a workspace over MCP needs no key. Only set one if you push data in.');
  } else if (!key.valid) {
    say(`  api key   PRESENT BUT BROKEN — ${key.reason}`);
  } else {
    say(`  api key   ${redactKey(key.key)}${key.looksLikeLiveKey ? '' : '  (does not start with rk_live_)'}`);
  }
  say(`  region    ${asked ? `${asked} (requested)` : 'not specified — probing both'}`);
  say('');

  const results = [];
  for (const region of REGIONS) results.push(await checkRegion(region, key.valid ? key.key : null));

  for (const r of results) {
    const marks = [];
    if (r.api) marks.push(`api ${r.api.state}`);
    marks.push(`mcp ${r.mcp.state}`);
    say(`  ${r.region.toUpperCase().padEnd(4)} ${marks.join(' · ')}`);
    if (r.api && r.api.state !== 'authenticated' && r.api.state !== 'rejected') {
      say(`       ${r.api.detail}`);
    }
    if (r.mcp.state !== 'reachable') say(`       ${r.mcp.detail}`);
  }

  const authenticated = results.filter((r) => r.api?.state === 'authenticated').map((r) => r.region);
  const verdict = { regionsAuthenticated: authenticated, requestedRegion: asked, results };

  say('');
  if (!key.present) {
    verdict.verdict = 'no_key';
    say('  No key to test. MCP reachability above is all this could check.');
  } else if (!key.valid) {
    verdict.verdict = 'key_malformed';
    say('  Fix the key before anything else: strip the whitespace and re-export it.');
  } else if (authenticated.length === 1) {
    const [found] = authenticated;
    verdict.verdict = 'ok';
    verdict.region = found;
    say(`  Your key belongs to ${found.toUpperCase()}.`);
    if (asked && asked !== found) {
      verdict.verdict = 'wrong_region_requested';
      say(`  You asked for ${asked.toUpperCase()}, which rejected it. That 401 is indistinguishable`);
      say(`  from a bad key, so use --region ${found} (or RULEBASE_REGION=${found}).`);
    } else {
      say(`  Use --region ${found}, or set RULEBASE_REGION=${found}.`);
    }
    const hosts = hostsFor(found);
    say('');
    say(`  app       ${hosts.app}`);
    say(`  api v1    ${hosts.apiV1}`);
    say(`  api v2    ${hosts.apiV2}`);
    say(`  mcp       ${hosts.mcp}/mcp`);
  } else if (authenticated.length === 0) {
    verdict.verdict = 'rejected_everywhere';
    say('  Both regions rejected the key. It has been revoked, mistyped, or copied incompletely.');
    say('  Check its first 16 characters against Settings > Connections > API keys.');
  } else {
    // Should not happen — regions have separate credential stores.
    verdict.verdict = 'ambiguous';
    say(`  Both regions accepted the key (${authenticated.join(', ')}), which should not be possible.`);
  }
  say('');
  say('  Org identity is not exposed to API keys. To confirm which workspace you are');
  say('  pointed at, use the MCP server and call get_current_organization.');
  say('');

  return { text: lines.join('\n'), json: verdict, exitCode: ['ok'].includes(verdict.verdict) || verdict.verdict === 'no_key' ? 0 : 1 };
}
