/**
 * Tests for the canonical export validator, plus cross-skill integration:
 * output from the platform exporters is fed straight into the validator, which
 * is the only real proof that the canonical schema actually holds across skills.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withMockApi, runScript, tempOut } from './helpers/mock-api.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const VALIDATOR = resolve(HERE, '../skills/cx-ops/cx-conversation-schema/scripts/validate-export.mjs');
const ZENDESK = resolve(HERE, '../skills/zendesk/zendesk-export-conversations/scripts/export-conversations.mjs');
const FRESHDESK = resolve(HERE, '../skills/freshdesk/freshdesk-export-conversations/scripts/export-conversations.mjs');
const FIVE9 = resolve(HERE, '../skills/five9/five9-export-interactions/scripts/export-interactions.mjs');
const GORGIAS = resolve(HERE, '../skills/gorgias/gorgias-export-conversations/scripts/export-conversations.mjs');
const HUBSPOT = resolve(HERE, '../skills/hubspot/hubspot-export-conversations/scripts/export-conversations.mjs');
const SALESFORCE = resolve(HERE, '../skills/salesforce/salesforce-export-cases/scripts/export-cases.mjs');
const FRONT = resolve(HERE, '../skills/front/front-export-conversations/scripts/export-conversations.mjs');
const INTERCOM = resolve(HERE, '../skills/intercom/intercom-export-conversations/scripts/export-conversations.mjs');

const conversation = (extra = {}) => ({
  source: 'test',
  source_id: '1',
  subject: 'Hello',
  status: 'closed',
  status_raw: 'closed',
  channel: 'email',
  channel_raw: 'email',
  customer_id: 'u1',
  assignee_id: 'a1',
  team_id: null,
  account_id: null,
  created_at: '2026-03-01T10:00:00.000Z',
  updated_at: '2026-03-01T10:10:00.000Z',
  resolved_at: '2026-03-01T10:10:00.000Z',
  csat: 1,
  csat_raw: 'good',
  priority: null,
  tags: [],
  is_deleted: false,
  ...extra,
});

const message = (extra = {}) => ({
  source: 'test',
  conversation_source_id: '1',
  source_id: 'm1',
  created_at: '2026-03-01T10:01:00.000Z',
  author_id: 'u1',
  author_type: 'customer',
  visibility: 'public',
  channel: 'email',
  attachment_count: 0,
  body: 'hello',
  ...extra,
});

function fixture(conversations, messages) {
  const dir = tempOut('schema-');
  writeFileSync(join(dir, 'conversations.jsonl'), conversations.map((c) => JSON.stringify(c)).join('\n') + '\n');
  if (messages !== null) {
    writeFileSync(join(dir, 'messages.jsonl'), messages.map((m) => JSON.stringify(m)).join('\n') + '\n');
  }
  return dir;
}

const validate = (dir, args = []) => runScript(VALIDATOR, [dir, '--json', ...args], {});

test('passes a clean export', async () => {
  const dir = fixture([conversation()], [message()]);
  const { code, summary } = await validate(dir);

  assert.equal(code, 0);
  assert.equal(summary.ok, true);
  assert.deepEqual(summary.errors, []);
  assert.equal(summary.stats.conversations.total, 1);
  assert.equal(summary.stats.messages.total, 1);
});

test('flags an orphaned message', async () => {
  const dir = fixture([conversation()], [message({ conversation_source_id: '999' })]);
  const { code, summary } = await validate(dir);

  assert.equal(code, 1);
  const issues = summary.errors.map((e) => e.issue);
  assert.ok(issues.some((i) => i.includes('orphaned')), `expected orphan error, got ${issues}`);
});

test('rejects values outside the canonical vocabulary', async () => {
  const dir = fixture(
    [conversation({ status: 'solved', channel: 'phone' })],
    [message({ author_type: 'requester', visibility: 'private' })],
  );
  const { code, summary } = await validate(dir);

  assert.equal(code, 1);
  const issues = summary.errors.map((e) => e.issue).join(' | ');
  assert.match(issues, /status outside the canonical vocabulary/);
  assert.match(issues, /channel outside the canonical vocabulary/);
  assert.match(issues, /author_type outside the canonical vocabulary/);
  assert.match(issues, /visibility outside the canonical vocabulary/);
});

test('rejects a csat outside 0-1 and non-ISO timestamps', async () => {
  const dir = fixture(
    [conversation({ csat: 4, created_at: '2026/03/01 10:00' })],
    [message()],
  );
  const { code, summary } = await validate(dir);

  assert.equal(code, 1);
  const issues = summary.errors.map((e) => e.issue).join(' | ');
  assert.match(issues, /csat is not a 0-1 fraction/, 'a raw 1-5 rating left in csat is an error');
  assert.match(issues, /created_at is not an ISO 8601 timestamp/);
});

test('catches duplicate ids in both files', async () => {
  const dir = fixture(
    [conversation({ source_id: '1' }), conversation({ source_id: '1' })],
    [message({ source_id: 'm1' }), message({ source_id: 'm1' })],
  );
  const { code, summary } = await validate(dir);

  assert.equal(code, 1);
  const issues = summary.errors.map((e) => e.issue).join(' | ');
  assert.match(issues, /conversations: duplicate source_id/);
  assert.match(issues, /messages: duplicate source_id/);
});

test('errors when no message is attributed to a customer', async () => {
  const dir = fixture([conversation()], [message({ author_type: 'agent' })]);
  const { code, summary } = await validate(dir);

  assert.equal(code, 1);
  assert.ok(
    summary.errors.some((e) => e.issue.includes('no customer messages')),
    'an inverted author mapping is an error, not a warning',
  );
});

test('warns when the unresolved-author share is high', async () => {
  const messages = [
    message({ source_id: 'm1', author_type: 'customer' }),
    message({ source_id: 'm2', author_type: 'unknown' }),
    message({ source_id: 'm3', author_type: 'unknown' }),
  ];
  const { code, summary } = await validate(fixture([conversation()], messages));

  assert.equal(code, 0, 'unresolved authors are a warning, not a failure');
  assert.ok(
    summary.warnings.some((w) => w.issue.includes('unresolved author types')),
    'names the metrics it invalidates',
  );
});

test('warns when many conversations have no messages', async () => {
  const conversations = Array.from({ length: 10 }, (_, i) =>
    conversation({ source_id: String(i + 1), customer_id: `u${i + 1}` }),
  );
  const { summary } = await validate(fixture(conversations, [message()]));

  assert.ok(summary.warnings.some((w) => w.issue.includes('no messages')));
  assert.ok(summary.notes.some((n) => n.includes('have no messages')));
});

test('warns when a message predates its conversation', async () => {
  const dir = fixture(
    [conversation({ created_at: '2026-03-01T12:00:00.000Z' })],
    [message({ created_at: '2026-03-01T09:00:00.000Z' })],
  );
  const { summary } = await validate(dir);

  assert.ok(
    summary.warnings.some((w) => w.issue.includes('created before the conversation started')),
    'the usual symptom of a timezone or epoch bug',
  );
});

test('warns when conversations lack a customer_id', async () => {
  const conversations = Array.from({ length: 5 }, (_, i) =>
    conversation({ source_id: String(i + 1), customer_id: null }),
  );
  const { summary } = await validate(fixture(conversations, [message()]));

  assert.ok(
    summary.warnings.some((w) => w.issue.includes('without a customer_id')),
    'flags rows that cannot join for repeat-contact work',
  );
});

test('--no-messages supports voice-only exports', async () => {
  const dir = fixture([conversation({ channel: 'voice' })], null);

  const withoutFlag = await validate(dir);
  assert.equal(withoutFlag.code, 1, 'missing messages.jsonl fails by default');
  assert.match(withoutFlag.stderr, /--no-messages/, 'names the flag');

  const withFlag = await validate(dir, ['--no-messages']);
  assert.equal(withFlag.code, 0);
  assert.equal(withFlag.summary.stats.messages, null);
});

test('reports unparseable lines rather than skipping them silently', async () => {
  const dir = tempOut('schema-');
  writeFileSync(
    join(dir, 'conversations.jsonl'),
    JSON.stringify(conversation()) + '\n{ broken\n',
  );
  writeFileSync(join(dir, 'messages.jsonl'), JSON.stringify(message()) + '\n');

  const { code, summary } = await validate(dir);
  assert.equal(code, 1);
  assert.ok(summary.errors.some((e) => e.issue.includes('unparseable JSON line')));
});

// --- cross-skill integration: exporter output must satisfy the schema ---

test('Zendesk export output passes the canonical validator', async () => {
  const ticket = {
    id: 4242,
    subject: 'Refund',
    status: 'solved',
    via: { channel: 'email' },
    requester_id: 900,
    assignee_id: 55,
    group_id: 3,
    organization_id: 9,
    created_at: '2026-03-01T10:00:00Z',
    updated_at: '2026-03-01T10:10:00Z',
    tags: ['billing'],
    satisfaction_rating: { score: 'good' },
  };
  const event = {
    id: 1,
    ticket_id: 4242,
    timestamp: Math.floor(Date.parse('2026-03-01T10:05:00Z') / 1000),
    updater_id: 900,
    via: { channel: 'email' },
    child_events: [
      { id: 11, event_type: 'Change', field_name: 'status' },
      {
        id: 12,
        event_type: 'Comment',
        author_id: 900,
        public: true,
        plain_body: 'where is my refund',
        attachments: [],
      },
    ],
  };

  await withMockApi(
    (req) => {
      if (req.url.includes('/incremental/tickets/')) {
        return { body: { tickets: [ticket], end_of_stream: true } };
      }
      return {
        body: { ticket_events: [event], end_time: event.timestamp, end_of_stream: true },
      };
    },
    async ({ base }) => {
      const out = tempOut('zd-canon-');
      const exported = await runScript(ZENDESK, ['--start', '2026-01-01', '--out', out], {
        ZENDESK_SUBDOMAIN: 'mock',
        ZENDESK_EMAIL: 'svc@example.com',
        ZENDESK_API_TOKEN: 'placeholder',
        ZENDESK_MIN_INTERVAL_MS: '1',
        ZENDESK_BASE_URL: base,
      });
      assert.equal(exported.code, 0);

      const { code, summary, stderr } = await validate(out);
      assert.equal(code, 0, `validator rejected Zendesk output: ${JSON.stringify(summary?.errors)}`);
      assert.equal(summary.stats.conversations.total, 1);
      assert.equal(summary.stats.messages.total, 1);
      assert.equal(
        summary.stats.messages.byAuthorType.customer,
        1,
        'author resolved via the requester index',
      );
      assert.ok(!stderr.includes('FAIL'));
    },
  );
});

test('Freshdesk export output passes the canonical validator', async () => {
  const parseQuery = (url) => Object.fromEntries(new URL(`http://x${url}`).searchParams);

  await withMockApi(
    (req) => {
      if (req.url.includes('/conversations?')) {
        return parseQuery(req.url).page === '1'
          ? {
              body: [
                {
                  id: 501,
                  ticket_id: 42,
                  user_id: 1042,
                  body_text: 'where is my refund',
                  private: false,
                  incoming: true,
                  created_at: '2026-03-01T10:05:00Z',
                  attachments: [],
                },
              ],
            }
          : { body: [] };
      }
      return parseQuery(req.url).page === '1'
        ? {
            body: [
              {
                id: 42,
                subject: 'Refund',
                status: 4,
                source: 1,
                priority: 2,
                requester_id: 1042,
                responder_id: 55,
                group_id: 7,
                created_at: '2026-03-01T10:00:00Z',
                updated_at: '2026-03-01T10:10:00Z',
                tags: [],
              },
            ],
          }
        : { body: [] };
    },
    async ({ base }) => {
      const out = tempOut('fd-canon-');
      const exported = await runScript(FRESHDESK, ['--start', '2026-01-01', '--out', out], {
        FRESHDESK_DOMAIN: 'mock',
        FRESHDESK_API_KEY: 'placeholder',
        FRESHDESK_API_BASE: base,
      });
      assert.equal(exported.code, 0);

      const { code, summary } = await validate(out);
      assert.equal(code, 0, `validator rejected Freshdesk output: ${JSON.stringify(summary?.errors)}`);
      assert.equal(summary.stats.conversations.total, 1);
      assert.equal(summary.stats.messages.byAuthorType.customer, 1);
    },
  );
});

test('Five9 export output passes the canonical validator with --no-messages', async () => {
  const csv =
    'Call ID,Timestamp,Agent,ANI,Skill,Disposition\n' +
    '"c1","2026-03-01T10:00:00Z","Ada","+15550001","Billing","Answered"\n';

  await withMockApi(
    (req, n, body) => {
      const raw = typeof body === 'string' ? body : '';
      if (raw.includes('runReport')) {
        return { headers: { 'content-type': 'text/xml' }, body: '<E><B><return>r1</return></B></E>' };
      }
      if (raw.includes('isReportRunning')) {
        return { headers: { 'content-type': 'text/xml' }, body: '<E><B><return>false</return></B></E>' };
      }
      return {
        headers: { 'content-type': 'text/xml' },
        body: `<E><B><return>${csv.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</return></B></E>`,
      };
    },
    async ({ base }) => {
      const out = tempOut('f9-canon-');
      const exported = await runScript(
        FIVE9,
        ['--start', '2026-03-01T00:00:00Z', '--end', '2026-03-02T00:00:00Z', '--out', out],
        {
          FIVE9_USERNAME: 'svc@example.com',
          FIVE9_PASSWORD: 'placeholder',
          FIVE9_WSDL_URL: `${base}/wsadmin/AdminWebService`,
        },
      );
      assert.equal(exported.code, 0);

      const { code, summary } = await validate(out, ['--no-messages']);
      assert.equal(code, 0, `validator rejected Five9 output: ${JSON.stringify(summary?.errors)}`);
      assert.equal(summary.stats.conversations.total, 1);
      assert.equal(summary.stats.conversations.byChannel.voice, 1);
    },
  );
});

test('Gorgias export output passes the canonical validator', async () => {
  const ticket = {
    id: 42,
    subject: 'Refund',
    status: 'closed',
    channel: 'email',
    customer: { id: 900 },
    assignee_user: { id: 55 },
    created_datetime: '2026-03-01T10:00:00Z',
    updated_datetime: '2026-03-05T10:00:00Z',
    tags: [],
  };

  await withMockApi(
    (req) => {
      if (req.url.includes('/messages')) {
        return {
          body: {
            data: [
              {
                id: 501,
                ticket_id: 42,
                sender: { id: 900 },
                from_agent: false,
                public: true,
                channel: 'email',
                body_text: 'where is my refund',
                created_datetime: '2026-03-01T10:05:00Z',
                attachments: [],
              },
            ],
            meta: {},
          },
        };
      }
      return { body: { data: [ticket], meta: {} } };
    },
    async ({ base }) => {
      const out = tempOut('gg-canon-');
      const exported = await runScript(GORGIAS, ['--start', '2026-03-01', '--out', out], {
        GORGIAS_DOMAIN: 'mock',
        GORGIAS_EMAIL: 'svc@example.com',
        GORGIAS_API_KEY: 'placeholder',
        GORGIAS_API_BASE: base,
        GORGIAS_RATE_PER_20S: '2000',
      });
      assert.equal(exported.code, 0);

      const { code, summary } = await validate(out);
      assert.equal(code, 0, `validator rejected Gorgias output: ${JSON.stringify(summary?.errors)}`);
      assert.equal(summary.stats.messages.byAuthorType.customer, 1);
    },
  );
});

test('HubSpot output passes the validator even with its extra truncation field', async () => {
  await withMockApi(
    (req) => {
      if (req.url.includes('/messages')) {
        return {
          body: {
            results: [
              {
                id: 'm1',
                type: 'MESSAGE',
                createdAt: '2026-03-01T10:05:00Z',
                senders: [{ actorId: 'V-900' }],
                text: 'where is my refund',
                truncationStatus: 'TRUNCATED',
                channelId: 'EMAIL',
                attachments: [],
              },
            ],
            paging: {},
          },
        };
      }
      return {
        body: {
          results: [
            {
              id: 't1',
              status: 'CLOSED',
              createdAt: '2026-03-01T10:00:00Z',
              latestMessageTimestamp: '2026-03-05T10:00:00Z',
              assignedTo: 'A-55',
              inboxId: '7',
            },
          ],
          paging: {},
        },
      };
    },
    async ({ base }) => {
      const out = tempOut('hs-canon-');
      const exported = await runScript(HUBSPOT, ['--start', '2026-03-01', '--out', out], {
        HUBSPOT_ACCESS_TOKEN: 'placeholder',
        HUBSPOT_API_BASE: base,
        HUBSPOT_RATE_PER_SEC: '500',
      });
      assert.equal(exported.code, 0);
      assert.equal(exported.summary.truncated_messages, 1);

      const { code, summary } = await validate(out);
      assert.equal(code, 0, `validator rejected HubSpot output: ${JSON.stringify(summary?.errors)}`);
      // customer_id is null on HubSpot threads by design, which the validator
      // surfaces as a warning rather than an error.
      assert.ok(
        summary.warnings.some((w) => w.issue.includes('without a customer_id')),
        'the known HubSpot identity gap is reported as a warning',
      );
    },
  );
});

test('Salesforce output passes the validator across all three message sources', async () => {
  const CASE_CSV =
    '"Id","CaseNumber","Subject","Status","IsClosed","IsDeleted","Origin","Priority","ContactId","AccountId","OwnerId","CreatedDate","LastModifiedDate","ClosedDate"\n' +
    '"500A","1","Refund","Closed","true","false","Email","High","003C","001B","005D","2026-03-01T10:00:00.000Z","2026-03-01T10:10:00.000Z","2026-03-01T10:10:00.000Z"\n';
  const COMMENT_CSV =
    '"Id","ParentId","CommentBody","CreatedById","CreatedDate","IsPublished","IsDeleted"\n' +
    '"00aX","500A","note","005D","2026-03-01T10:05:00.000Z","false","false"\n';
  const EMAIL_CSV =
    '"Id","ParentId","TextBody","Subject","FromAddress","Incoming","MessageDate","CreatedDate","CreatedById","HasAttachment","IsDeleted"\n' +
    '"02sY","500A","where is my refund","Re","cust@example.com","true","2026-03-01T10:02:00.000Z","2026-03-01T10:02:00.000Z","","false","false"\n';
  const FEED_CSV =
    '"Id","ParentId","Body","Type","CreatedById","CreatedDate","IsDeleted"\n' +
    '"0D5Z","500A","chatter","TextPost","005D","2026-03-01T10:06:00.000Z","false"\n';
  const csvByObject = {
    Case: CASE_CSV,
    CaseComment: COMMENT_CSV,
    EmailMessage: EMAIL_CSV,
    FeedItem: FEED_CSV,
  };

  const jobs = new Map();
  let seq = 0;
  await withMockApi(
    (req, n, body) => {
      if (req.method === 'POST') {
        const object = /FROM\s+(\w+)/i.exec(body?.query ?? '')?.[1] ?? 'Unknown';
        const id = `job${++seq}`;
        jobs.set(id, object);
        return { body: { id } };
      }
      const match = /\/jobs\/query\/(job\d+)(\/results)?/.exec(req.url);
      if (match && match[2]) {
        return {
          headers: { 'content-type': 'text/csv', 'sforce-locator': 'null' },
          body: csvByObject[jobs.get(match[1])] ?? '',
        };
      }
      return { body: { state: 'JobComplete' } };
    },
    async ({ base }) => {
      const out = tempOut('sf-canon-');
      const exported = await runScript(SALESFORCE, ['--start', '2026-03-01', '--out', out], {
        SALESFORCE_INSTANCE_URL: base,
        SALESFORCE_ACCESS_TOKEN: 'placeholder',
      });
      assert.equal(exported.code, 0);
      assert.equal(exported.summary.messages, 3);

      const { code, summary } = await validate(out);
      assert.equal(code, 0, `validator rejected Salesforce output: ${JSON.stringify(summary?.errors)}`);
      assert.equal(summary.stats.messages.total, 3, 'all three sources land in one file');
      assert.equal(summary.stats.messages.byAuthorType.customer, 1);
      assert.equal(summary.stats.messages.byVisibility.internal, 2, 'comment and chatter are internal');
    },
  );
});

test('Front output passes the canonical validator', async () => {
  const epoch = (s) => Math.floor(Date.parse(s) / 1000);
  await withMockApi(
    (req) => {
      if (req.url.includes('/messages')) {
        return {
          body: {
            _results: [
              {
                id: 'msg_1',
                type: 'email',
                is_inbound: true,
                created_at: epoch('2026-03-01T10:05:00Z'),
                author: { id: 'tea_9' },
                text: 'where is my refund',
                attachments: [],
              },
            ],
            _pagination: {},
          },
        };
      }
      return {
        body: {
          _results: [
            {
              id: 'cnv_1',
              subject: 'Refund',
              status: 'archived',
              type: 'email',
              created_at: epoch('2026-03-01T10:00:00Z'),
              last_message: { created_at: epoch('2026-03-05T10:00:00Z') },
              recipient: { contact_id: 'crd_1', handle: 'cust@example.com' },
              assignee: { id: 'tea_1' },
              inbox: { id: 'inb_9' },
              tags: [],
            },
          ],
          _pagination: {},
        },
      };
    },
    async ({ base }) => {
      const out = tempOut('fr-canon-');
      const exported = await runScript(FRONT, ['--start', '2026-03-01', '--out', out], {
        FRONT_API_TOKEN: 'placeholder',
        FRONT_API_BASE: base,
        FRONT_RATE_PER_MIN: '60000',
      });
      assert.equal(exported.code, 0);

      const { code, summary } = await validate(out);
      assert.equal(code, 0, `validator rejected Front output: ${JSON.stringify(summary?.errors)}`);
      assert.equal(summary.stats.conversations.byChannel.email, 1);
    },
  );
});

test('Intercom output passes the canonical validator', async () => {
  const listed = {
    id: '1',
    title: 'Refund',
    state: 'closed',
    open: false,
    created_at: Math.floor(Date.parse('2026-03-01T10:00:00Z') / 1000),
    updated_at: Math.floor(Date.parse('2026-03-05T10:00:00Z') / 1000),
    admin_assignee_id: 55,
    team_assignee_id: 7,
    source: { type: 'conversation', delivered_as: 'email', id: 'src1', author: { id: '900', type: 'user' } },
    contacts: { contacts: [{ id: '900' }] },
    conversation_rating: { rating: 4 },
    tags: { tags: [] },
  };

  await withMockApi(
    (req) => {
      if (req.url === '/conversations/search') {
        return { body: { conversations: [listed], pages: {} } };
      }
      return {
        body: {
          ...listed,
          source: { ...listed.source, body: '<p>where is my refund</p>', attachments: [] },
          conversation_parts: {
            total_count: 1,
            conversation_parts: [
              {
                id: '10',
                part_type: 'comment',
                body: '<p>checking now</p>',
                created_at: Math.floor(Date.parse('2026-03-01T10:05:00Z') / 1000),
                author: { id: '55', type: 'admin' },
                attachments: [],
              },
            ],
          },
        },
      };
    },
    async ({ base }) => {
      const out = tempOut('ic-canon-');
      const exported = await runScript(INTERCOM, ['--start', '2026-03-01', '--out', out], {
        INTERCOM_ACCESS_TOKEN: 'placeholder',
        INTERCOM_API_BASE: base,
      });
      assert.equal(exported.code, 0);

      const { code, summary } = await validate(out);
      assert.equal(code, 0, `validator rejected Intercom output: ${JSON.stringify(summary?.errors)}`);
      assert.equal(summary.stats.conversations.withCsat, 1, 'the 1-5 rating normalised into range');
      assert.equal(summary.stats.messages.byAuthorType.customer, 1);
      assert.equal(summary.stats.messages.byAuthorType.agent, 1);
    },
  );
});
