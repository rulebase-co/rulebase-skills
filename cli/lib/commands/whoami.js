/**
 * `rulebase whoami` — what can actually be known about the current credential.
 *
 * Which is less than the name suggests, and the command says so rather than
 * implying otherwise. Rulebase's public API exposes no identity endpoint: an API
 * key authenticates as the organization, not as a person, and no route returns
 * which organization that is. So the honest answers are the region the key
 * belongs to and whether it works.
 *
 * The org name is available over MCP via get_current_organization, and this
 * command points there instead of pretending.
 */

import { REGIONS, hostsFor, apiKey, redactKey, requestedRegion } from '../config.js';
import { probe, bearer } from '../http.js';

export async function whoami(flags) {
  const key = apiKey();
  const asked = requestedRegion(flags);
  const lines = [];
  const say = (s = '') => lines.push(s);

  if (!key.present) {
    say('');
    say('  No RULEBASE_API_KEY set, so there is no credential to identify.');
    say('  Reading a workspace over MCP needs no key — only pushing data in does.');
    say('');
    return { text: lines.join('\n'), json: { key: { present: false } }, exitCode: 1 };
  }
  if (!key.valid) {
    say('');
    say(`  RULEBASE_API_KEY ${key.reason}.`);
    say('');
    return { text: lines.join('\n'), json: { key: { present: true, valid: false, reason: key.reason } }, exitCode: 1 };
  }

  // Try the requested region first if given, otherwise probe until one answers.
  const order = asked ? [asked, ...REGIONS.filter((r) => r !== asked)] : REGIONS;
  let region = null;
  for (const candidate of order) {
    const res = await probe(`${hostsFor(candidate).apiV2}/conversation_uploads?limit=1`, { headers: bearer(key.key) });
    if (res.ok && res.status === 200) {
      region = candidate;
      break;
    }
  }

  const json = {
    key: { present: true, valid: true, looksLikeLiveKey: key.looksLikeLiveKey, display: redactKey(key.key) },
    region,
    organization: null,
    organizationSource: 'not available to API keys — use the MCP tool get_current_organization',
  };

  say('');
  say(`  key       ${redactKey(key.key)}`);
  say(`  region    ${region ? region.toUpperCase() : 'none — rejected by both US and EU'}`);
  say('  org       unknown');
  say('            An API key authenticates as the organization, not as a person, and no');
  say('            public endpoint returns which organization. Use the MCP server and call');
  say('            get_current_organization to confirm the workspace.');
  if (region) {
    const hosts = hostsFor(region);
    say('');
    say(`  api v2    ${hosts.apiV2}`);
    say(`  app       ${hosts.app}`);
  } else {
    say('');
    say('  Run `rulebase doctor` for the full picture.');
  }
  say('');

  return { text: lines.join('\n'), json, exitCode: region ? 0 : 1 };
}
