/**
 * Region and host resolution.
 *
 * Rulebase runs separate US and EU deployments with separate credential stores,
 * and a key from one region returns exactly the same 401 against the other as a
 * mistyped key does. Nothing in the response hints at it. That single fact is
 * why this file exists and why `doctor` probes both regions rather than
 * trusting whatever the caller passed.
 */

export const REGIONS = ['us', 'eu'];

/**
 * Origins per region. The `eu.` prefix is the whole difference.
 *
 * Overrides are checked per-region first (`RULEBASE_API2_ORIGIN_EU`) and then
 * globally (`RULEBASE_API2_ORIGIN`). The per-region form exists so tests can
 * point US and EU at different mocks — without it, region detection is the one
 * behaviour that cannot be tested, which is also the one that matters most.
 */
export function hostsFor(region) {
  const prefix = region === 'eu' ? 'eu.' : '';
  const suffix = region.toUpperCase();
  const override = (name) => process.env[`RULEBASE_${name}_ORIGIN_${suffix}`] || process.env[`RULEBASE_${name}_ORIGIN`];

  return {
    app: override('APP') || `https://${prefix}app.rulebase.co`,
    apiV1: override('API') || `https://${prefix}api.rulebase.co`,
    apiV2: override('API2') || `https://${prefix}api2.rulebase.co`,
    mcp: override('MCP') || `https://${prefix}mcp.rulebase.co`,
  };
}

/**
 * The region the caller asked for, or null when they did not say.
 *
 * Deliberately does not default to "us". Silently assuming a region is how you
 * get a 401 that looks like a bad credential, so commands that need a region
 * either probe for it or ask.
 */
export function requestedRegion(flags) {
  const raw = flags.region ?? process.env.RULEBASE_REGION ?? null;
  if (raw === null) return null;
  const region = String(raw).toLowerCase();
  if (!REGIONS.includes(region)) {
    throw new Error(`unknown region "${raw}" — expected one of: ${REGIONS.join(', ')}`);
  }
  return region;
}

/**
 * The API key, from the environment only.
 *
 * Never read from a command-line argument: argv shows up in shell history, in
 * `ps` output, and in transcripts.
 */
export function apiKey() {
  const key = process.env.RULEBASE_API_KEY;
  if (!key) return { present: false };
  if (key !== key.trim()) {
    // `export KEY=$(cat file)` is the usual cause, and it produces a 401 that
    // looks exactly like a wrong key.
    return { present: true, valid: false, reason: 'has leading or trailing whitespace, which breaks the Authorization header' };
  }
  return { present: true, valid: true, key, looksLikeLiveKey: key.startsWith('rk_live_') };
}

/** Never print a key. Enough to match against the list in Settings, no more. */
export function redactKey(key) {
  if (!key) return '(none)';
  const family = key.startsWith('rk_live_') ? 'rk_live_' : key.slice(0, 3);
  return `${family}…${key.length} chars`;
}
