/**
 * Tests for the `rulebase` CLI.
 *
 * The load-bearing cases are the region ones. A valid API key sent to the wrong
 * region returns a 401 byte-identical to a revoked key's, so `doctor` probing
 * both regions is the entire reason the command exists — if that detection
 * breaks, the CLI is worse than nothing, because it would confidently confirm
 * the wrong diagnosis.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withMockApi, runScript } from './helpers/mock-api.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '../cli/bin/rulebase.js');
const CLI_PKG = resolve(HERE, '../cli/package.json');

const KEY = 'rk_live_placeholdervalue000000';

/**
 * Mock one region. `accepts` decides whether the API key authenticates, which is
 * how a wrong-region 401 is simulated.
 */
function region({ accepts, mcpReachable = true }) {
  return (req) => {
    if (req.url.startsWith('/conversation_uploads')) {
      return accepts
        ? { status: 200, body: { data: [], meta: { page: { next: null, limit: 1 } } } }
        : { status: 401, body: { error: 'Unauthorized' } };
    }
    if (req.url.startsWith('/.well-known/oauth-protected-resource')) {
      return mcpReachable
        ? { status: 200, body: { resource: `${req.headers.host}/mcp`, authorization_servers: ['https://auth.rulebase.co'] } }
        : { status: 500, body: 'nope' };
    }
    return { status: 404, body: 'not found' };
  };
}

/** Stand up both regions and point the CLI's per-region overrides at them. */
async function withRegions({ us, eu }, run) {
  return withMockApi(region(us), async (usMock) =>
    withMockApi(region(eu), async (euMock) =>
      run({
        env: {
          RULEBASE_API2_ORIGIN_US: usMock.base,
          RULEBASE_MCP_ORIGIN_US: usMock.base,
          RULEBASE_API2_ORIGIN_EU: euMock.base,
          RULEBASE_MCP_ORIGIN_EU: euMock.base,
        },
        usMock,
        euMock,
      }),
    ),
  );
}

// --------------------------------------------------------------------- doctor

test('doctor finds the region the key actually belongs to', async () => {
  await withRegions({ us: { accepts: false }, eu: { accepts: true } }, async ({ env }) => {
    const res = await runScript(CLI, ['doctor', '--json'], { ...env, RULEBASE_API_KEY: KEY });

    assert.equal(res.code, 0, res.stderr);
    const json = JSON.parse(res.stdout);
    assert.equal(json.verdict, 'ok');
    assert.equal(json.region, 'eu');
    assert.deepEqual(json.regionsAuthenticated, ['eu']);
  });
});

test('doctor says so when you asked for the wrong region', async () => {
  // The whole point: US rejects, EU accepts, and the user asked for US.
  await withRegions({ us: { accepts: false }, eu: { accepts: true } }, async ({ env }) => {
    const res = await runScript(CLI, ['doctor', '--region', 'us'], { ...env, RULEBASE_API_KEY: KEY });

    assert.equal(res.code, 1);
    assert.match(res.stdout, /Your key belongs to EU/);
    assert.match(res.stdout, /You asked for US, which rejected it/);
    assert.match(res.stdout, /indistinguishable/);
    assert.match(res.stdout, /--region eu/);
  });
});

test('doctor does not complain when the requested region is the right one', async () => {
  await withRegions({ us: { accepts: true }, eu: { accepts: false } }, async ({ env }) => {
    const res = await runScript(CLI, ['doctor', '--region', 'us', '--json'], { ...env, RULEBASE_API_KEY: KEY });
    const json = JSON.parse(res.stdout);
    assert.equal(json.verdict, 'ok');
    assert.equal(json.region, 'us');
    assert.equal(res.code, 0);
  });
});

test('doctor reports a key rejected by both regions as a credential problem', async () => {
  await withRegions({ us: { accepts: false }, eu: { accepts: false } }, async ({ env }) => {
    const res = await runScript(CLI, ['doctor', '--json'], { ...env, RULEBASE_API_KEY: KEY });
    assert.equal(res.code, 1);
    assert.equal(JSON.parse(res.stdout).verdict, 'rejected_everywhere');
  });
});

test('doctor still checks MCP reachability with no key, and does not fail', async () => {
  await withRegions({ us: { accepts: false }, eu: { accepts: false } }, async ({ env }) => {
    const res = await runScript(CLI, ['doctor', '--json'], env);
    assert.equal(res.code, 0, 'having no key is not an error');
    const json = JSON.parse(res.stdout);
    assert.equal(json.verdict, 'no_key');
    assert.ok(json.results.every((r) => r.mcp.state === 'reachable'));
    assert.ok(json.results.every((r) => r.api === null), 'no key means no api probe');
  });
});

test('doctor catches whitespace in the key before blaming the credential', async () => {
  await withRegions({ us: { accepts: true }, eu: { accepts: false } }, async ({ env }) => {
    const withKey = { ...env, RULEBASE_API_KEY: `${KEY}\n` };

    const json = await runScript(CLI, ['doctor', '--json'], withKey);
    assert.equal(json.code, 1);
    assert.equal(JSON.parse(json.stdout).verdict, 'key_malformed');

    // The actionable sentence lives in the human output, which --json replaces.
    const text = await runScript(CLI, ['doctor'], withKey);
    assert.match(text.stdout, /whitespace/);
    assert.match(text.stdout, /strip the whitespace and re-export/);
  });
});

test('doctor reports an unreachable region without dying on it', async () => {
  await withRegions({ us: { accepts: true }, eu: { accepts: false, mcpReachable: false } }, async ({ env }) => {
    const res = await runScript(CLI, ['doctor', '--json'], { ...env, RULEBASE_API_KEY: KEY });
    const json = JSON.parse(res.stdout);
    assert.equal(json.verdict, 'ok');
    assert.equal(json.region, 'us');
    assert.equal(json.results.find((r) => r.region === 'eu').mcp.state, 'unexpected');
  });
});

test('doctor prints the resolved hosts once it knows the region', async () => {
  await withRegions({ us: { accepts: false }, eu: { accepts: true } }, async ({ env }) => {
    const res = await runScript(CLI, ['doctor'], { ...env, RULEBASE_API_KEY: KEY });
    assert.match(res.stdout, /api v1/);
    assert.match(res.stdout, /api v2/);
    assert.match(res.stdout, /mcp/);
  });
});

// --------------------------------------------------------------------- whoami

test('whoami reports the region and is explicit that the org is unknown', async () => {
  await withRegions({ us: { accepts: false }, eu: { accepts: true } }, async ({ env }) => {
    const res = await runScript(CLI, ['whoami'], { ...env, RULEBASE_API_KEY: KEY });

    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /region {4}EU/);
    // It must not imply it knows the workspace, because no endpoint exposes it.
    assert.match(res.stdout, /org {7}unknown/);
    assert.match(res.stdout, /get_current_organization/);
  });
});

test('whoami honours an explicit region before probing', async () => {
  await withRegions({ us: { accepts: true }, eu: { accepts: true } }, async ({ env, euMock }) => {
    const res = await runScript(CLI, ['whoami', '--region', 'eu', '--json'], { ...env, RULEBASE_API_KEY: KEY });
    assert.equal(JSON.parse(res.stdout).region, 'eu');
    assert.ok(euMock.calls.length > 0, 'should have asked EU first');
  });
});

test('whoami exits non-zero with no key', async () => {
  const res = await runScript(CLI, ['whoami'], {});
  assert.equal(res.code, 1);
  assert.match(res.stdout, /no RULEBASE_API_KEY set/i);
  assert.match(res.stdout, /MCP needs no key/);
});

test('neither command ever prints the key', async () => {
  await withRegions({ us: { accepts: false }, eu: { accepts: true } }, async ({ env }) => {
    for (const cmd of [['doctor'], ['whoami'], ['doctor', '--json'], ['whoami', '--json']]) {
      const res = await runScript(CLI, cmd, { ...env, RULEBASE_API_KEY: KEY });
      assert.ok(!res.stdout.includes(KEY), `key leaked into stdout of ${cmd.join(' ')}`);
      assert.ok(!res.stderr.includes(KEY), `key leaked into stderr of ${cmd.join(' ')}`);
    }
  });
});

// --------------------------------------------------------------------- shape

test('skills forwards rather than reimplementing the installer', async () => {
  const res = await runScript(CLI, ['skills', 'install', 'cx-churn-signal', '--json'], {});
  assert.equal(res.code, 0);
  assert.equal(JSON.parse(res.stdout).forwardTo, 'npx rulebase-skills install cx-churn-signal');
});

test('help and --version need no network and no credential', async () => {
  const help = await runScript(CLI, [], {});
  assert.equal(help.code, 0);
  assert.match(help.stdout, /rulebase doctor/);
  // The reason doctor exists belongs in the help, since that is where someone
  // debugging a 401 will look.
  assert.match(help.stdout, /same 401 as a revoked one/);

  const expected = JSON.parse(readFileSync(CLI_PKG, 'utf8')).version;
  // Bare `--version` has no command, so it must be handled before the help
  // branch. Testing it only alongside a command hid exactly that bug.
  for (const args of [['--version'], ['doctor', '--version']]) {
    const version = await runScript(CLI, args, {});
    assert.equal(version.stdout.trim(), expected, `\`rulebase ${args.join(' ')}\` should print the version`);
  }
});

test('an unknown command and a bad region both fail loudly', async () => {
  const unknown = await runScript(CLI, ['frobnicate'], {});
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown command/);

  const badRegion = await runScript(CLI, ['doctor', '--region', 'apac'], {});
  assert.equal(badRegion.code, 2);
  assert.match(badRegion.stderr, /unknown region "apac"/);

  const noValue = await runScript(CLI, ['doctor', '--region'], {});
  assert.equal(noValue.code, 2);
  assert.match(noValue.stderr, /--region requires a value/);
});

test('the CLI package has no dependencies and ships its lib', () => {
  const pkg = JSON.parse(readFileSync(CLI_PKG, 'utf8'));
  assert.equal(pkg.name, 'rulebase');
  assert.equal(pkg.bin.rulebase, './bin/rulebase.js');
  assert.ok(!pkg.dependencies, 'runtime dependencies would break the npx one-liner');
  // lib/ holds every command; omitting it from files would publish a broken bin.
  assert.ok(pkg.files.includes('lib'));
  assert.ok(pkg.files.includes('bin'));
});
