/**
 * Tests for the multi-platform satisfaction export. The behaviour that matters:
 * normalise only where the platform fixes the scale, never guess where the
 * account configures it, and never turn "survey was offered" into a bad score.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withMockApi, runScript, tempOut, readJsonl } from './helpers/mock-api.mjs';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../skills/cx-ops/cx-satisfaction-export/scripts/export-satisfaction.mjs',
);

const zendeskEnv = (base) => ({
  ZENDESK_SUBDOMAIN: 'mock',
  ZENDESK_EMAIL: 'svc@example.com',
  ZENDESK_API_TOKEN: 'placeholder',
  ZENDESK_BASE_URL: base,
});

test('Zendesk: normalises good/bad because the scale is fixed', async () => {
  await withMockApi(
    () => ({
      body: {
        satisfaction_ratings: [
          { id: 1, ticket_id: 100, requester_id: 900, assignee_id: 55, score: 'good', created_at: '2026-03-01T10:00:00Z', comment: 'great' },
          { id: 2, ticket_id: 101, requester_id: 901, score: 'bad', created_at: '2026-03-01T11:00:00Z', comment: 'slow' },
        ],
        next_page: null,
      },
    }),
    async ({ base }) => {
      const out = tempOut('sat-');
      const { code, summary } = await runScript(
        SCRIPT,
        ['--platform', 'zendesk', '--start', '90d', '--out', out, '--json'],
        zendeskEnv(base),
      );

      assert.equal(code, 0);
      assert.equal(summary.scale_is_fixed_by_platform, true);
      assert.equal(summary.normalised, true);

      const records = readJsonl(join(out, 'satisfaction.jsonl'));
      assert.equal(records[0].score, 1);
      assert.equal(records[0].score_raw, 'good');
      assert.equal(records[0].scale, 'binary');
      assert.equal(records[0].conversation_source_id, '100', 'joins to the canonical conversation');
      assert.equal(records[1].score, 0);
      assert.equal(summary.responses, 2);
    },
  );
});

test('Zendesk: offered/unoffered are not scores', async () => {
  await withMockApi(
    () => ({
      body: {
        satisfaction_ratings: [
          { id: 1, ticket_id: 100, score: 'offered', created_at: '2026-03-01T10:00:00Z' },
          { id: 2, ticket_id: 101, score: 'unoffered', created_at: '2026-03-01T10:00:00Z' },
          { id: 3, ticket_id: 102, score: 'good', created_at: '2026-03-01T10:00:00Z' },
        ],
        next_page: null,
      },
    }),
    async ({ base }) => {
      const out = tempOut('sat-');
      const { summary } = await runScript(
        SCRIPT,
        ['--platform', 'zendesk', '--start', '90d', '--out', out, '--json'],
        zendeskEnv(base),
      );

      const records = readJsonl(join(out, 'satisfaction.jsonl'));
      const offered = records.find((r) => r.score_raw === 'offered');
      assert.equal(offered.score, null, 'offered must not become 0');
      assert.equal(offered.is_response, false);
      assert.equal(summary.responses, 1, 'only the real score counts as a response');
      assert.ok(
        summary.caveats.some((c) => c.includes('fabricates dissatisfaction')),
        'explains why',
      );
    },
  );
});

test('Zendesk: follows next_page', async () => {
  await withMockApi(
    (req, n) => {
      if (n === 1) {
        return {
          body: {
            satisfaction_ratings: [{ id: 1, ticket_id: 100, score: 'good', created_at: '2026-03-01T10:00:00Z' }],
            next_page: `http://${req.headers.host}/api/v2/satisfaction_ratings.json?page=2`,
          },
        };
      }
      return {
        body: {
          satisfaction_ratings: [{ id: 2, ticket_id: 101, score: 'bad', created_at: '2026-03-01T10:00:00Z' }],
          next_page: null,
        },
      };
    },
    async ({ base, calls }) => {
      const out = tempOut('sat-');
      const { summary } = await runScript(
        SCRIPT,
        ['--platform', 'zendesk', '--start', '90d', '--out', out, '--json'],
        zendeskEnv(base),
      );
      assert.equal(summary.pages, 2);
      assert.equal(summary.records, 2);
      assert.equal(calls.length, 2);
    },
  );
});

test('Freshdesk: refuses to guess an account-configurable scale', async () => {
  await withMockApi(
    (req) => {
      const page = /[?&]page=(\d+)/.exec(req.url)?.[1];
      if (page === '1') {
        return {
          body: [
            { id: 1, ticket_id: 100, user_id: 900, agent_id: 55, created_at: '2026-03-01T10:00:00Z', ratings: { default_question: 103 }, feedback: 'good' },
            { id: 2, ticket_id: 101, user_id: 901, created_at: '2026-03-01T11:00:00Z', ratings: { default_question: -103 } },
          ],
        };
      }
      return { body: [] };
    },
    async ({ base }) => {
      const out = tempOut('sat-');
      const { summary } = await runScript(
        SCRIPT,
        ['--platform', 'freshdesk', '--start', '90d', '--out', out, '--json'],
        { FRESHDESK_DOMAIN: 'mock', FRESHDESK_API_KEY: 'placeholder', FRESHDESK_API_BASE: base },
      );

      assert.equal(summary.scale_is_fixed_by_platform, false);
      assert.equal(summary.normalised, false, 'no normalised score without a mapping');
      assert.deepEqual(summary.unmapped_raw_values.sort(), ['-103', '103']);
      assert.deepEqual(summary.raw_score_distribution, { '103': 1, '-103': 1 });

      const records = readJsonl(join(out, 'satisfaction.jsonl'));
      assert.equal(records[0].score, null);
      assert.equal(records[0].score_raw, 103, 'the raw value is preserved');
      assert.equal(records[0].scale, 'account_configurable');
      assert.ok(
        summary.caveats.some((c) => c.includes('looks like CSAT and is not')),
        'states why guessing is refused',
      );
    },
  );
});

test('--scale-map normalises a configurable scale', async () => {
  const mapDir = tempOut('map-');
  const mapPath = join(mapDir, 'scale.json');
  writeFileSync(mapPath, JSON.stringify({ '103': 1, '102': 0.75, '-103': 0 }));

  await withMockApi(
    (req) => {
      const page = /[?&]page=(\d+)/.exec(req.url)?.[1];
      if (page === '1') {
        return {
          body: [
            { id: 1, ticket_id: 100, created_at: '2026-03-01T10:00:00Z', ratings: { q: 103 } },
            { id: 2, ticket_id: 101, created_at: '2026-03-01T10:00:00Z', ratings: { q: -103 } },
          ],
        };
      }
      return { body: [] };
    },
    async ({ base }) => {
      const out = tempOut('sat-');
      const { summary } = await runScript(
        SCRIPT,
        ['--platform', 'freshdesk', '--start', '90d', '--scale-map', mapPath, '--out', out, '--json'],
        { FRESHDESK_DOMAIN: 'mock', FRESHDESK_API_KEY: 'placeholder', FRESHDESK_API_BASE: base },
      );

      assert.equal(summary.normalised, true);
      assert.deepEqual(summary.unmapped_raw_values, []);

      const records = readJsonl(join(out, 'satisfaction.jsonl'));
      assert.equal(records[0].score, 1);
      assert.equal(records[0].scale, 'mapped');
      assert.equal(records[1].score, 0);
    },
  );
});

test('an incomplete --scale-map still reports what is unmapped', async () => {
  const mapDir = tempOut('map-');
  const mapPath = join(mapDir, 'scale.json');
  writeFileSync(mapPath, JSON.stringify({ '103': 1 })); // -103 missing

  await withMockApi(
    (req) => {
      const page = /[?&]page=(\d+)/.exec(req.url)?.[1];
      if (page === '1') {
        return {
          body: [
            { id: 1, ticket_id: 100, created_at: '2026-03-01T10:00:00Z', ratings: { q: 103 } },
            { id: 2, ticket_id: 101, created_at: '2026-03-01T10:00:00Z', ratings: { q: -103 } },
          ],
        };
      }
      return { body: [] };
    },
    async ({ base }) => {
      const out = tempOut('sat-');
      const { summary } = await runScript(
        SCRIPT,
        ['--platform', 'freshdesk', '--start', '90d', '--scale-map', mapPath, '--out', out, '--json'],
        { FRESHDESK_DOMAIN: 'mock', FRESHDESK_API_KEY: 'placeholder', FRESHDESK_API_BASE: base },
      );
      assert.equal(summary.normalised, false, 'a partial mapping is not a mapping');
      assert.deepEqual(summary.unmapped_raw_values, ['-103']);
    },
  );
});

test('rejects a scale map with out-of-range values', async () => {
  const mapDir = tempOut('map-');
  const mapPath = join(mapDir, 'scale.json');
  writeFileSync(mapPath, JSON.stringify({ '103': 5 }));

  const { code, stderr } = await runScript(
    SCRIPT,
    ['--platform', 'freshdesk', '--start', '90d', '--scale-map', mapPath, '--json'],
    { FRESHDESK_DOMAIN: 'mock', FRESHDESK_API_KEY: 'placeholder', FRESHDESK_API_BASE: 'http://127.0.0.1:1' },
  );
  assert.equal(code, 1);
  assert.match(stderr, /must be a number between 0 and 1/);
});

test('Gorgias: paginates by cursor and keeps raw scores', async () => {
  await withMockApi(
    (req) => {
      if (req.url.includes('cursor=c2')) {
        return { body: { data: [{ id: 2, ticket_id: 101, score: 3, created_datetime: '2026-03-01T11:00:00Z' }], meta: {} } };
      }
      return {
        body: {
          data: [{ id: 1, ticket_id: 100, customer_id: 900, score: 5, created_datetime: '2026-03-01T10:00:00Z', body_text: 'ok' }],
          meta: { next_cursor: 'c2' },
        },
      };
    },
    async ({ base, urls }) => {
      const out = tempOut('sat-');
      const { summary } = await runScript(
        SCRIPT,
        ['--platform', 'gorgias', '--start', '90d', '--out', out, '--json'],
        {
          GORGIAS_DOMAIN: 'mock',
          GORGIAS_EMAIL: 'svc@example.com',
          GORGIAS_API_KEY: 'placeholder',
          GORGIAS_API_BASE: base,
        },
      );
      assert.equal(summary.records, 2);
      assert.match(urls()[1], /cursor=c2/);
      const records = readJsonl(join(out, 'satisfaction.jsonl'));
      assert.equal(records[0].score_raw, 5);
      assert.equal(records[0].score, null, 'Gorgias scale is account-configurable');
    },
  );
});

test('HubSpot: paginates by after and flags the missing conversation link', async () => {
  await withMockApi(
    (req) => {
      if (req.url.includes('after=a2')) {
        return { body: { results: [{ id: 'f2', properties: { hs_value: '7', hs_submission_timestamp: '2026-03-01T11:00:00Z' } }], paging: {} } };
      }
      return {
        body: {
          results: [{ id: 'f1', properties: { hs_value: '9', hs_survey_type: 'CSAT', hs_content: 'good', hs_submission_timestamp: '2026-03-01T10:00:00Z' } }],
          paging: { next: { after: 'a2' } },
        },
      };
    },
    async ({ base, urls }) => {
      const out = tempOut('sat-');
      const { summary } = await runScript(
        SCRIPT,
        ['--platform', 'hubspot', '--start', '90d', '--out', out, '--json'],
        { HUBSPOT_ACCESS_TOKEN: 'placeholder', HUBSPOT_API_BASE: base },
      );

      assert.equal(summary.records, 2);
      assert.match(urls()[1], /after=a2/);
      const records = readJsonl(join(out, 'satisfaction.jsonl'));
      assert.equal(records[0].conversation_source_id, null);
      assert.ok(
        summary.caveats.some((c) => c.includes('associations API is a separate call')),
        'warns the responses cannot be joined as-is',
      );
    },
  );
});

test('always warns that this is the response set only', async () => {
  await withMockApi(
    () => ({ body: { satisfaction_ratings: [], next_page: null } }),
    async ({ base }) => {
      const out = tempOut('sat-');
      const { summary } = await runScript(
        SCRIPT,
        ['--platform', 'zendesk', '--start', '90d', '--out', out, '--json'],
        zendeskEnv(base),
      );
      assert.ok(
        summary.caveats.some((c) => c.includes('Response bias is the dominant uncertainty')),
        'points at cx-survey-design',
      );
    },
  );
});

test('403 says satisfaction access may be a separate permission', async () => {
  await withMockApi(
    () => ({ status: 403, body: {} }),
    async ({ base }) => {
      const out = tempOut('sat-');
      const { code, stderr } = await runScript(
        SCRIPT,
        ['--platform', 'zendesk', '--start', '90d', '--out', out, '--json'],
        zendeskEnv(base),
      );
      assert.equal(code, 1);
      assert.match(stderr, /separate from ticket read access/);
    },
  );
});

test('404 says surveys may not be enabled', async () => {
  await withMockApi(
    () => ({ status: 404, body: {} }),
    async ({ base }) => {
      const out = tempOut('sat-');
      const { code, stderr } = await runScript(
        SCRIPT,
        ['--platform', 'zendesk', '--start', '90d', '--out', out, '--json'],
        zendeskEnv(base),
      );
      assert.equal(code, 1);
      assert.match(stderr, /surveys may not be enabled/);
    },
  );
});

test('requires the platform env vars', async () => {
  const { code, stderr } = await runScript(
    SCRIPT,
    ['--platform', 'gorgias', '--start', '90d', '--json'],
    { GORGIAS_DOMAIN: '', GORGIAS_EMAIL: '', GORGIAS_API_KEY: '' },
  );
  assert.equal(code, 1);
  assert.match(stderr, /is not set for --platform gorgias/);
});
