/**
 * Tests for the Rulebase access checker.
 *
 * The important one is `distinguishes the MCP surface from the REST API`: the
 * whole point of the check is that the two 401 bodies differ, because crossing
 * the hostnames over is the most common setup mistake and neither error names
 * the other.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withMockApi, runScript } from './helpers/mock-api.mjs';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../skills/rulebase/rulebase-setup/scripts/verify-access.mjs',
);

const HEALTHY_PRM = {
  resource: 'https://mcp.rulebase.co/mcp',
  authorization_servers: ['https://auth.rulebase.co'],
};

/** Routes the three URLs the script probes to a single mock origin. */
function planner({ mcpBody = { error: 'No token provided' }, mcpStatus = 401, apiStatus = 200, apiBody } = {}) {
  return (req) => {
    if (req.url.startsWith('/.well-known/oauth-protected-resource')) {
      return { status: 200, body: HEALTHY_PRM };
    }
    if (req.url === '/mcp') {
      return { status: mcpStatus, body: mcpBody };
    }
    if (req.url.startsWith('/conversation_uploads')) {
      return {
        status: apiStatus,
        body: apiBody ?? (apiStatus === 200 ? { data: [], meta: { page: { next: null, limit: 1 } } } : { error: 'Unauthorized' }),
      };
    }
    return { status: 404, body: { error: 'not found' } };
  };
}

const env = (base, extra = {}) => ({
  RULEBASE_MCP_ORIGIN: base,
  RULEBASE_API2_ORIGIN: base,
  ...extra,
});

test('passes when discovery, the MCP endpoint and the API key all check out', async () => {
  await withMockApi(planner(), async ({ base }) => {
    const res = await runScript(SCRIPT, ['--region', 'us'], env(base, { RULEBASE_API_KEY: 'rk_live_placeholder' }));

    assert.equal(res.code, 0);
    assert.equal(res.summary.failed, 0);
    assert.equal(res.summary.passed, 3);
    assert.deepEqual(
      res.summary.checks.map((c) => c.status),
      ['pass', 'pass', 'pass'],
    );
  });
});

test('distinguishes the MCP surface from the REST API by its 401 body', async () => {
  // The hostname is an MCP endpoint but answers like the REST API — meaning the
  // user pointed an MCP client at the wrong host.
  await withMockApi(planner({ mcpBody: { error: 'Unauthorized' } }), async ({ base }) => {
    const res = await runScript(SCRIPT, ['--region', 'us'], env(base));

    assert.equal(res.code, 1);
    const endpoint = res.summary.checks.find((c) => c.check === 'mcp.endpoint');
    assert.equal(endpoint.status, 'fail');
    assert.match(endpoint.detail, /answered like the REST API/);
  });
});

test('skips the API check when no key is set, and still exits zero', async () => {
  await withMockApi(planner(), async ({ base }) => {
    const res = await runScript(SCRIPT, ['--region', 'us'], env(base));

    assert.equal(res.code, 0);
    assert.equal(res.summary.apiKey.present, false);
    const api = res.summary.checks.find((c) => c.check === 'api.v2');
    assert.equal(api.status, 'skip');
    assert.match(api.detail, /needs no key/);
  });
});

test('catches whitespace in the key before blaming the credential', async () => {
  await withMockApi(planner(), async ({ base }) => {
    const res = await runScript(SCRIPT, ['--region', 'us'], env(base, { RULEBASE_API_KEY: 'rk_live_placeholder\n' }));

    assert.equal(res.code, 1);
    const api = res.summary.checks.find((c) => c.check === 'api.v2');
    assert.equal(api.status, 'fail');
    assert.match(api.detail, /whitespace/);
  });
});

test('a 401 from the API points at the region before the key', async () => {
  await withMockApi(planner({ apiStatus: 401 }), async ({ base }) => {
    const res = await runScript(SCRIPT, ['--region', 'eu'], env(base, { RULEBASE_API_KEY: 'rk_live_placeholder' }));

    assert.equal(res.code, 1);
    const api = res.summary.checks.find((c) => c.check === 'api.v2');
    assert.match(api.detail, /region host first/);
    assert.match(api.detail, /"eu"/);
    // And the remediation hint names the opposite region to try.
    assert.match(res.stderr, /--region us/);
  });
});

test('never emits the key itself', async () => {
  const secret = 'rk_live_supersecretvalue123456';
  await withMockApi(planner(), async ({ base }) => {
    const res = await runScript(SCRIPT, ['--region', 'us'], env(base, { RULEBASE_API_KEY: secret }));

    assert.equal(res.code, 0);
    assert.ok(!res.stdout.includes(secret), 'key leaked into stdout');
    assert.ok(!res.stderr.includes(secret), 'key leaked into stderr');
    // Presence and family are reported; the value is not.
    assert.equal(res.summary.apiKey.present, true);
    assert.equal(res.summary.apiKey.looksLikeLiveKey, true);
  });
});

test('rejects an unknown region rather than guessing a host', async () => {
  const res = await runScript(SCRIPT, ['--region', 'apac'], {});
  assert.equal(res.code, 2);
  assert.match(res.stderr, /must be "us" or "eu"/);
});
