/**
 * Tests for the Salesforce export script. The defining behaviour is querying
 * all three objects that can hold case conversation text, and making a missing
 * source visible instead of silently producing a partial conversation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  withMockApi,
  runScript,
  tempOut,
  readJsonl,
  CANONICAL_CONVERSATION_FIELDS,
  CANONICAL_MESSAGE_FIELDS,
  CANONICAL_STATUSES,
} from './helpers/mock-api.mjs';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../skills/salesforce/salesforce-export-cases/scripts/export-cases.mjs',
);

const { csvToObjects, parseCsv } = await import(SCRIPT);

const env = (base, extra = {}) => ({
  SALESFORCE_INSTANCE_URL: base,
  SALESFORCE_ACCESS_TOKEN: 'placeholder-not-a-real-token',
  ...extra,
});

const CASE_CSV =
  '"Id","CaseNumber","Subject","Status","IsClosed","IsDeleted","Origin","Priority","ContactId","AccountId","OwnerId","CreatedDate","LastModifiedDate","ClosedDate"\n' +
  '"500A","00001","Refund, please","Closed","true","false","Email","High","003C","001B","005D","2026-03-01T10:00:00.000Z","2026-03-01T10:10:00.000Z","2026-03-01T10:10:00.000Z"\n';

const COMMENT_CSV =
  '"Id","ParentId","CommentBody","CreatedById","CreatedDate","IsPublished","IsDeleted"\n' +
  '"00aX","500A","internal thought","005D","2026-03-01T10:05:00.000Z","false","false"\n';

const EMAIL_CSV =
  '"Id","ParentId","TextBody","Subject","FromAddress","Incoming","MessageDate","CreatedDate","CreatedById","HasAttachment","IsDeleted"\n' +
  '"02sY","500A","where is my refund","Re: Refund","cust@example.com","true","2026-03-01T10:02:00.000Z","2026-03-01T10:02:00.000Z","","false","false"\n';

const FEED_CSV =
  '"Id","ParentId","Body","Type","CreatedById","CreatedDate","IsDeleted"\n' +
  '"0D5Z","500A","chatter note","TextPost","005D","2026-03-01T10:06:00.000Z","false"\n';

/** Routes the Bulk API 2.0 create -> poll -> results sequence per object. */
function bulkPlan(csvByObject, { failObjects = [] } = {}) {
  const jobs = new Map();
  let seq = 0;
  return (req, n, body) => {
    if (req.method === 'POST' && req.url.includes('/jobs/query')) {
      const soql = body?.query ?? '';
      const object = /FROM\s+(\w+)/i.exec(soql)?.[1] ?? 'Unknown';
      const id = `job${++seq}`;
      jobs.set(id, { object, operation: body?.operation });
      return { body: { id, state: 'UploadComplete', operation: body?.operation } };
    }

    const match = /\/jobs\/query\/(job\d+)(\/results)?/.exec(req.url);
    if (match) {
      const [, jobId, isResults] = match;
      const job = jobs.get(jobId);
      if (!job) return { status: 404, body: {} };

      if (!isResults) {
        if (failObjects.includes(job.object)) {
          return { body: { id: jobId, state: 'Failed', errorMessage: `no access to ${job.object}` } };
        }
        return { body: { id: jobId, state: 'JobComplete' } };
      }

      const csv = csvByObject[job.object] ?? '';
      return {
        headers: { 'content-type': 'text/csv', 'sforce-locator': 'null', 'sforce-numberofrecords': '1' },
        body: csv,
      };
    }
    return { status: 404, body: {} };
  };
}

// --- CSV helpers, exercised directly ---

test('CSV parser handles quoted commas inside case bodies', () => {
  const rows = parseCsv('"Id","Subject"\n"1","Refund, please"\n');
  assert.deepEqual(rows[1], ['1', 'Refund, please']);
});

test('csvToObjects keys by header and turns blanks into null', () => {
  const [record] = csvToObjects('"Id","CreatedById"\n"1",""\n');
  assert.equal(record.Id, '1');
  assert.equal(record.CreatedById, null, 'empty cells become null, not empty string');
});

// --- export behaviour ---

test('queries all three message objects and unifies them', async () => {
  await withMockApi(
    bulkPlan({
      Case: CASE_CSV,
      CaseComment: COMMENT_CSV,
      EmailMessage: EMAIL_CSV,
      FeedItem: FEED_CSV,
    }),
    async ({ base, calls }) => {
      const out = tempOut('sf-');
      const { code, summary } = await runScript(
        SCRIPT,
        ['--start', '2026-03-01', '--out', out],
        env(base),
      );

      assert.equal(code, 0);
      assert.equal(summary.conversations, 1);
      assert.equal(summary.messages, 3, 'one message from each of the three objects');
      assert.deepEqual(summary.by_source, { CaseComment: 1, EmailMessage: 1, FeedItem: 1 });
      assert.deepEqual(summary.sources_with_no_messages, []);

      const soqls = calls
        .filter((c) => c.method === 'POST')
        .map((c) => c.body?.query ?? '');
      assert.ok(soqls.some((q) => /FROM Case\b/.test(q)));
      assert.ok(soqls.some((q) => /FROM CaseComment/.test(q)));
      assert.ok(soqls.some((q) => /FROM EmailMessage/.test(q)), 'EmailMessage is not optional');
      assert.ok(soqls.some((q) => /FROM FeedItem/.test(q)));
    },
  );
});

test('uses queryAll by default so archived rows are included', async () => {
  await withMockApi(
    bulkPlan({ Case: CASE_CSV, CaseComment: COMMENT_CSV, EmailMessage: EMAIL_CSV, FeedItem: FEED_CSV }),
    async ({ base, calls }) => {
      const out = tempOut('sf-');
      const { summary } = await runScript(
        SCRIPT,
        ['--start', '2026-03-01', '--only', 'conversations', '--out', out],
        env(base),
      );

      const create = calls.find((c) => c.method === 'POST');
      assert.equal(create.body.operation, 'queryAll');
      assert.equal(summary.include_deleted, true);
    },
  );

  await withMockApi(
    bulkPlan({ Case: CASE_CSV }),
    async ({ base, calls }) => {
      const out = tempOut('sf-');
      await runScript(
        SCRIPT,
        ['--start', '2026-03-01', '--only', 'conversations', '--exclude-deleted', '--out', out],
        env(base),
      );
      assert.equal(calls.find((c) => c.method === 'POST').body.operation, 'query');
    },
  );
});

test('normalises cases and each message source to the canonical shape', async () => {
  await withMockApi(
    bulkPlan({ Case: CASE_CSV, CaseComment: COMMENT_CSV, EmailMessage: EMAIL_CSV, FeedItem: FEED_CSV }),
    async ({ base }) => {
      const out = tempOut('sf-');
      await runScript(SCRIPT, ['--start', '2026-03-01', '--out', out], env(base));

      const [c] = readJsonl(join(out, 'conversations.jsonl'));
      assert.equal(c.source, 'salesforce');
      assert.equal(c.source_id, '500A');
      assert.equal(c.status, 'closed', 'IsClosed true');
      assert.equal(c.status_raw, 'Closed');
      assert.equal(c.channel, 'email', 'Origin "Email" maps to email');
      assert.equal(c.customer_id, '003C');
      assert.equal(c.account_id, '001B');
      assert.equal(c.priority, 'high');
      assert.equal(c.subject, 'Refund, please', 'the quoted comma survives CSV parsing');
      for (const field of CANONICAL_CONVERSATION_FIELDS) assert.ok(field in c, `has ${field}`);
      assert.ok(CANONICAL_STATUSES.includes(c.status));

      const messages = readJsonl(join(out, 'messages.jsonl'));
      const byObject = Object.fromEntries(messages.map((m) => [m.message_source, m]));

      assert.equal(byObject.EmailMessage.author_type, 'customer', 'Incoming true is the customer');
      assert.equal(
        byObject.EmailMessage.author_id,
        'cust@example.com',
        'inbound email has no user, so the address is the identity',
      );
      assert.equal(byObject.EmailMessage.visibility, 'public');
      assert.equal(byObject.EmailMessage.body, 'where is my refund');

      assert.equal(
        byObject.CaseComment.visibility,
        'internal',
        'IsPublished false is agent-only',
      );
      assert.equal(byObject.FeedItem.visibility, 'internal', 'Chatter is internal by default');

      for (const field of CANONICAL_MESSAGE_FIELDS) {
        assert.ok(field in byObject.EmailMessage, `has ${field}`);
      }
      assert.equal(byObject.EmailMessage.conversation_source_id, '500A');
    },
  );
});

test('warns loudly when a message source yields nothing', async () => {
  await withMockApi(
    // EmailMessage returns only a header: the org looks like it has no emails.
    bulkPlan({
      Case: CASE_CSV,
      CaseComment: COMMENT_CSV,
      EmailMessage: '"Id","ParentId","TextBody","Subject","FromAddress","Incoming","MessageDate","CreatedDate","CreatedById","HasAttachment","IsDeleted"\n',
      FeedItem: FEED_CSV,
    }),
    async ({ base }) => {
      const out = tempOut('sf-');
      const { summary, stderr } = await runScript(
        SCRIPT,
        ['--start', '2026-03-01', '--out', out],
        env(base),
      );

      assert.deepEqual(summary.sources_with_no_messages, ['EmailMessage']);
      assert.match(stderr, /no messages from EmailMessage/);
      assert.match(stderr, /read access is missing/, 'names the likely cause');
      assert.match(stderr, /before\s+treating the conversation as complete/);
    },
  );
});

test('--sources narrows the query but says what that costs', async () => {
  await withMockApi(
    bulkPlan({ Case: CASE_CSV, CaseComment: COMMENT_CSV }),
    async ({ base, calls }) => {
      const out = tempOut('sf-');
      const { summary, stderr } = await runScript(
        SCRIPT,
        ['--start', '2026-03-01', '--sources', 'CaseComment', '--out', out],
        env(base),
      );

      assert.deepEqual(summary.sources_queried, ['CaseComment']);
      assert.match(stderr, /Email-to-Case org, omitting EmailMessage drops most of the conversation/);

      const soqls = calls.filter((c) => c.method === 'POST').map((c) => c.body.query);
      assert.ok(!soqls.some((q) => /FROM EmailMessage/.test(q)), 'EmailMessage not queried');
    },
  );
});

test('rejects an unknown source rather than silently skipping it', async () => {
  const out = tempOut('sf-');
  const { code, stderr } = await runScript(
    SCRIPT,
    ['--start', '2026-03-01', '--sources', 'CaseComment,Nonsense', '--out', out],
    env('http://127.0.0.1:1'),
  );
  assert.equal(code, 1);
  assert.match(stderr, /--sources must be a comma-separated subset/);
});

test('pages results with the Sforce-Locator header', async () => {
  let resultCalls = 0;
  await withMockApi(
    (req, n, body) => {
      if (req.method === 'POST') return { body: { id: 'job1', state: 'UploadComplete' } };
      if (/\/results/.test(req.url)) {
        resultCalls++;
        if (resultCalls === 1) {
          return {
            headers: { 'content-type': 'text/csv', 'sforce-locator': 'loc2' },
            body: CASE_CSV,
          };
        }
        return {
          headers: { 'content-type': 'text/csv', 'sforce-locator': 'null' },
          body: CASE_CSV.replace('500A', '500B'),
        };
      }
      return { body: { id: 'job1', state: 'JobComplete' } };
    },
    async ({ base, urls }) => {
      const out = tempOut('sf-');
      const { summary } = await runScript(
        SCRIPT,
        ['--start', '2026-03-01', '--only', 'conversations', '--out', out],
        env(base),
      );

      assert.equal(summary.conversations, 2, 'both result pages consumed');
      assert.ok(
        urls().some((u) => u.includes('locator=loc2')),
        'the locator from the header is echoed back',
      );
      assert.deepEqual(
        readJsonl(join(out, 'conversations.jsonl')).map((c) => c.source_id),
        ['500A', '500B'],
      );
    },
  );
});

test('a failed bulk job aborts with the Salesforce error message', async () => {
  await withMockApi(
    bulkPlan({ Case: CASE_CSV }, { failObjects: ['Case'] }),
    async ({ base }) => {
      const out = tempOut('sf-');
      const { code, stderr } = await runScript(
        SCRIPT,
        ['--start', '2026-03-01', '--only', 'conversations', '--out', out],
        env(base),
      );
      assert.equal(code, 1);
      assert.match(stderr, /state Failed/);
      assert.match(stderr, /no access to Case/, 'passes the error through');
    },
  );
});

test('resume skips objects already exported', async () => {
  let createCalls = 0;
  await withMockApi(
    (req, n, body) => {
      if (req.method === 'POST') {
        createCalls++;
        const object = /FROM\s+(\w+)/i.exec(body?.query ?? '')?.[1] ?? 'Unknown';
        return { body: { id: `job_${object}`, state: 'UploadComplete' } };
      }
      const match = /\/jobs\/query\/job_(\w+?)(\/results)?$/.exec(req.url);
      if (match && match[2]) {
        const csv = { Case: CASE_CSV, CaseComment: COMMENT_CSV }[match[1]] ?? '';
        return { headers: { 'content-type': 'text/csv', 'sforce-locator': 'null' }, body: csv };
      }
      return { body: { state: 'JobComplete' } };
    },
    async ({ base }) => {
      const out = tempOut('sf-');
      const e = env(base);

      await runScript(
        SCRIPT,
        ['--start', '2026-03-01', '--only', 'conversations', '--out', out],
        e,
      );
      const afterCases = createCalls;
      assert.equal(afterCases, 1, 'only the Case query ran');

      await runScript(SCRIPT, ['--resume', '--sources', 'CaseComment', '--out', out], e);
      assert.equal(createCalls, 2, 'Case was not re-queried; only CaseComment ran');
    },
  );
});

test('401 explains that access tokens are short-lived', async () => {
  await withMockApi(
    () => ({ status: 401, body: [{ errorCode: 'INVALID_SESSION_ID' }] }),
    async ({ base }) => {
      const out = tempOut('sf-');
      const { code, stderr } = await runScript(
        SCRIPT,
        ['--start', '2026-03-01', '--only', 'conversations', '--out', out],
        env(base),
      );
      assert.equal(code, 1);
      assert.match(stderr, /short-lived/);
      assert.match(stderr, /--resume/, 'tells the user how to continue after refreshing');
    },
  );
});

test('403 names the API allocation and object permissions', async () => {
  await withMockApi(
    () => ({ status: 403, body: [{ errorCode: 'REQUEST_LIMIT_EXCEEDED' }] }),
    async ({ base }) => {
      const out = tempOut('sf-');
      const { code, stderr } = await runScript(
        SCRIPT,
        ['--start', '2026-03-01', '--only', 'conversations', '--out', out],
        env(base),
      );
      assert.equal(code, 1);
      assert.match(stderr, /API Enabled/);
      assert.match(stderr, /24-hour API request allocation/);
    },
  );
});
