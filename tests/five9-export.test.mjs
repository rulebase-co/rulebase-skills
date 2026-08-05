/**
 * Tests for the Five9 export script against a mock SOAP endpoint.
 *
 * The riskiest logic here is not the network path but the data handling: RFC 4180
 * CSV parsing (report cells contain commas and newlines), tenant-configurable
 * column mapping, call-segment collapsing, and detection of the 50,000-record cap.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withMockApi, runScript, tempOut, readJsonl } from './helpers/mock-api.mjs';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../skills/five9/five9-export-interactions/scripts/export-interactions.mjs',
);

const { parseCsv } = await import(SCRIPT);

const env = (base, extra = {}) => ({
  FIVE9_USERNAME: 'svc@example.com',
  FIVE9_PASSWORD: 'placeholder-not-a-real-password',
  FIVE9_WSDL_URL: `${base}/wsadmin/AdminWebService`,
  ...extra,
});

const xmlEscape = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Scripts the runReport -> isReportRunning -> getReportResultCsv sequence. */
function soapPlan(csvByWindow) {
  let windowIndex = 0;
  return (req, n, body) => {
    const raw = typeof body === 'string' ? body : '';
    if (raw.includes('runReport')) {
      const id = `report-${windowIndex++}`;
      return { headers: { 'content-type': 'text/xml' }, body: `<Envelope><Body><ns:runReportResponse><return>${id}</return></ns:runReportResponse></Body></Envelope>` };
    }
    if (raw.includes('isReportRunning')) {
      return { headers: { 'content-type': 'text/xml' }, body: '<Envelope><Body><return>false</return></Body></Envelope>' };
    }
    if (raw.includes('getReportResultCsv')) {
      const id = /<identifier>([^<]*)<\/identifier>/.exec(raw)?.[1] ?? '';
      const index = Number(id.split('-')[1] ?? 0);
      const csv = csvByWindow[index] ?? csvByWindow[0] ?? '';
      return {
        headers: { 'content-type': 'text/xml' },
        body: `<Envelope><Body><return>${xmlEscape(csv)}</return></Body></Envelope>`,
      };
    }
    return { status: 500, body: '<Envelope><Body><faultstring>unexpected</faultstring></Body></Envelope>' };
  };
}

// --- CSV parser, exercised directly ---

test('CSV parser handles quoted commas, escaped quotes and embedded newlines', () => {
  const csv = 'Call ID,Disposition,Notes\n1,"Transferred, then resolved","said ""thanks"""\n2,Abandoned,"line one\nline two"\n';
  const rows = parseCsv(csv);

  assert.equal(rows.length, 3, 'header plus two data rows');
  assert.deepEqual(rows[1], ['1', 'Transferred, then resolved', 'said "thanks"']);
  assert.deepEqual(rows[2], ['2', 'Abandoned', 'line one\nline two']);
});

test('CSV parser handles CRLF line endings and a missing trailing newline', () => {
  const rows = parseCsv('A,B\r\n1,2\r\n3,4');
  assert.deepEqual(rows, [
    ['A', 'B'],
    ['1', '2'],
    ['3', '4'],
  ]);
});

test('CSV parser drops fully blank rows but keeps rows with empty cells', () => {
  const rows = parseCsv('A,B\n1,\n\n,\n2,3\n');
  assert.deepEqual(rows, [
    ['A', 'B'],
    ['1', ''],
    ['2', '3'],
  ]);
});

// --- export behaviour ---

const CALL_LOG = [
  'Call ID,Timestamp,Agent,ANI,Skill,Campaign,Disposition,Call Type,Talk Time',
  '"c1","2026-03-01 10:00:00","Ada","+15550001","Billing","Inbound","Answered","Inbound","120"',
  '"c2","2026-03-01 10:05:00","Bo","+15550002","Billing","Inbound","Abandoned","Inbound","0"',
  '',
].join('\n');

test('runs the report sequence and normalises rows to canonical conversations', async () => {
  await withMockApi(soapPlan([CALL_LOG]), async ({ base, calls }) => {
    const out = tempOut('f9-');
    const { code, summary } = await runScript(
      SCRIPT,
      ['--start', '2026-03-01T00:00:00Z', '--end', '2026-03-02T00:00:00Z', '--out', out],
      env(base),
    );

    assert.equal(code, 0);
    assert.equal(summary.rows, 2);
    assert.equal(summary.conversations, 2);
    assert.equal(summary.complete, true);

    const bodies = calls.map((c) => (typeof c.body === 'string' ? c.body : ''));
    assert.ok(bodies[0].includes('runReport'), 'runReport first');
    assert.ok(bodies.some((b) => b.includes('isReportRunning')), 'polls for completion');
    assert.ok(bodies.some((b) => b.includes('getReportResultCsv')), 'then fetches the CSV');

    const [a, b] = readJsonl(join(out, 'conversations.jsonl'));
    assert.equal(a.source, 'five9');
    assert.equal(a.source_id, 'c1');
    assert.equal(a.channel, 'voice');
    assert.equal(a.status, 'closed', 'a call-log row is always a finished call');
    assert.equal(a.status_raw, 'Answered', 'the disposition is preserved verbatim');
    assert.equal(a.abandoned, false);
    assert.equal(a.assignee_id, 'Ada');
    assert.equal(a.customer_id, '+15550001');
    assert.equal(a.team_id, 'Billing');
    assert.equal(a.created_at, new Date('2026-03-01 10:00:00').toISOString());

    assert.equal(b.abandoned, true, 'Abandoned disposition sets the flag');
    assert.equal(b.status, 'closed', 'but the canonical status stays closed');
  });
});

test('collapses call segments sharing a call id into one interaction', async () => {
  const segments = [
    'Call ID,Timestamp,Agent,Disposition',
    '"c1","2026-03-01 10:00:00","Ada","Transferred"',
    '"c1","2026-03-01 10:03:00","Bo","Answered"',
    '"c2","2026-03-01 11:00:00","Cy","Answered"',
    '',
  ].join('\n');

  await withMockApi(soapPlan([segments]), async ({ base }) => {
    const out = tempOut('f9-');
    const { summary } = await runScript(
      SCRIPT,
      ['--start', '2026-03-01T00:00:00Z', '--end', '2026-03-02T00:00:00Z', '--out', out],
      env(base),
    );

    assert.equal(summary.rows, 3);
    assert.equal(summary.conversations, 2, 'three rows collapse to two calls');
    assert.equal(summary.segments_collapsed, 1);

    const conversations = readJsonl(join(out, 'conversations.jsonl'));
    const c1 = conversations.find((c) => c.source_id === 'c1');
    assert.equal(c1.segment_count, 2);
    assert.equal(
      c1.created_at,
      new Date('2026-03-01 10:00:00').toISOString(),
      'keeps the earliest segment start',
    );
    assert.equal(c1.assignee_id, 'Bo', 'keeps the last agent to handle the call');
    assert.equal(c1.status_raw, 'Answered', 'and that segment\'s disposition');
  });
});

test('--keep-segments preserves every row', async () => {
  const segments = [
    'Call ID,Timestamp,Agent,Disposition',
    '"c1","2026-03-01 10:00:00","Ada","Transferred"',
    '"c1","2026-03-01 10:03:00","Bo","Answered"',
    '',
  ].join('\n');

  await withMockApi(soapPlan([segments]), async ({ base }) => {
    const out = tempOut('f9-');
    const { summary } = await runScript(
      SCRIPT,
      ['--start', '2026-03-01T00:00:00Z', '--end', '2026-03-02T00:00:00Z', '--keep-segments', '--out', out],
      env(base),
    );
    assert.equal(summary.conversations, 2, 'both segments kept');
    assert.equal(summary.segments_collapsed, 0);
  });
});

test('accepts alternative column spellings and preserves unmapped columns', async () => {
  const csv = [
    'SESSION ID,Date,Agent Full Name,Customer Phone,Queue,Disposition Name,Wrap Up Code,Recording URL',
    '"s1","2026-03-01 09:00:00","Dee","+15550009","Support","Resolved","WRAP7","https://example.test/r/1"',
    '',
  ].join('\n');

  await withMockApi(soapPlan([csv]), async ({ base, calls }) => {
    const out = tempOut('f9-');
    const { code, stderr } = await runScript(
      SCRIPT,
      ['--start', '2026-03-01T00:00:00Z', '--end', '2026-03-02T00:00:00Z', '--out', out],
      env(base),
    );

    assert.equal(code, 0, `should map alternate headers; stderr: ${stderr}`);
    const [c] = readJsonl(join(out, 'conversations.jsonl'));
    assert.equal(c.source_id, 's1', '"SESSION ID" maps to call_id');
    assert.equal(c.assignee_id, 'Dee', '"Agent Full Name" maps to agent');
    assert.equal(c.customer_id, '+15550009', '"Customer Phone" maps to customer');
    assert.equal(c.team_id, 'Support', '"Queue" maps to skill');
    assert.equal(c.status_raw, 'Resolved', '"Disposition Name" maps to disposition');

    assert.deepEqual(
      c.extra,
      { 'Wrap Up Code': 'WRAP7', 'Recording URL': 'https://example.test/r/1' },
      'unmapped tenant-specific columns are preserved, not dropped',
    );
    assert.ok(calls.length > 0);
  });
});

test('refuses to dedupe when the report has no call id column', async () => {
  const csv = ['Timestamp,Agent,Disposition', '"2026-03-01 10:00:00","Ada","Answered"', ''].join('\n');

  await withMockApi(soapPlan([csv]), async ({ base }) => {
    const out = tempOut('f9-');
    const { code, stderr } = await runScript(
      SCRIPT,
      ['--start', '2026-03-01T00:00:00Z', '--end', '2026-03-02T00:00:00Z', '--out', out],
      env(base),
    );

    assert.equal(code, 1, 'fails rather than silently mis-counting calls');
    assert.match(stderr, /no call id column found/);
    assert.match(stderr, /--keep-segments/, 'names the escape hatch');
  });
});

test('splits the range into windows and runs one report per window', async () => {
  const perWindow = [
    'Call ID,Timestamp,Disposition\n"w0","2026-03-01 01:00:00","Answered"\n',
    'Call ID,Timestamp,Disposition\n"w1","2026-03-02 01:00:00","Answered"\n',
    'Call ID,Timestamp,Disposition\n"w2","2026-03-03 01:00:00","Answered"\n',
  ];

  await withMockApi(soapPlan(perWindow), async ({ base, calls }) => {
    const out = tempOut('f9-');
    const { summary } = await runScript(
      SCRIPT,
      ['--start', '2026-03-01T00:00:00Z', '--end', '2026-03-04T00:00:00Z', '--window-hours', '24', '--out', out],
      env(base),
    );

    assert.equal(summary.windows_total, 3);
    assert.equal(summary.windows_completed, 3);
    assert.equal(summary.conversations, 3);

    const runReports = calls.filter((c) => String(c.body).includes('runReport'));
    assert.equal(runReports.length, 3, 'one report per window');

    // Windows must be contiguous and non-overlapping.
    const starts = runReports.map((c) => /<start>([^<]*)<\/start>/.exec(String(c.body))[1]);
    assert.equal(new Set(starts).size, 3, 'each window has a distinct start');
  });
});

test('resume skips windows already completed', async () => {
  const perWindow = [
    'Call ID,Timestamp,Disposition\n"w0","2026-03-01 01:00:00","Answered"\n',
    'Call ID,Timestamp,Disposition\n"w1","2026-03-02 01:00:00","Answered"\n',
  ];

  await withMockApi(soapPlan(perWindow), async ({ base, calls }) => {
    const out = tempOut('f9-');
    const e = env(base);

    await runScript(
      SCRIPT,
      ['--start', '2026-03-01T00:00:00Z', '--end', '2026-03-03T00:00:00Z', '--window-hours', '24',
       '--max-windows', '1', '--out', out],
      e,
    );
    const afterFirst = calls.filter((c) => String(c.body).includes('runReport')).length;
    assert.equal(afterFirst, 1, 'only one window ran');

    const { summary } = await runScript(SCRIPT, ['--resume', '--out', out], e);
    const total = calls.filter((c) => String(c.body).includes('runReport')).length;
    assert.equal(total, 2, 'resume ran only the remaining window');
    assert.equal(summary.windows_completed, 2);
    assert.equal(readJsonl(join(out, 'conversations.jsonl')).length, 2);
  });
});

test('warns and reports incomplete when a window hits the record cap', async () => {
  // Build a CSV at the cap. 50,000 rows is the documented Five9 limit.
  const header = 'Call ID,Timestamp,Disposition\n';
  const rows = Array.from(
    { length: 50_000 },
    (_, i) => `"c${i}","2026-03-01 10:00:00","Answered"`,
  ).join('\n');

  await withMockApi(soapPlan([header + rows + '\n']), async ({ base }) => {
    const out = tempOut('f9-');
    const { summary, stderr } = await runScript(
      SCRIPT,
      ['--start', '2026-03-01T00:00:00Z', '--end', '2026-03-02T00:00:00Z', '--out', out],
      env(base),
    );

    assert.equal(summary.capped_windows, 1);
    assert.equal(summary.complete, false, 'a capped window makes the export incomplete');
    assert.match(stderr, /50000-record cap/);
    assert.match(stderr, /--window-hours/, 'tells the user how to fix it');
  });
});

test('surfaces a SOAP fault instead of retrying it as a transport error', async () => {
  await withMockApi(
    () => ({
      status: 500,
      headers: { 'content-type': 'text/xml' },
      body: '<Envelope><Body><Fault><faultstring>Report not found: Call Log</faultstring></Fault></Body></Envelope>',
    }),
    async ({ base, calls }) => {
      const out = tempOut('f9-');
      const { code, stderr } = await runScript(
        SCRIPT,
        ['--start', '2026-03-01T00:00:00Z', '--end', '2026-03-02T00:00:00Z', '--out', out],
        env(base),
      );

      assert.equal(code, 1);
      assert.match(stderr, /SOAP fault/);
      assert.match(stderr, /Report not found/, 'passes the fault text through');
      assert.equal(calls.length, 1, 'a fault is not retried');
    },
  );
});

test('401 names the region trap as well as the credentials', async () => {
  await withMockApi(
    () => ({ status: 401, body: 'denied' }),
    async ({ base }) => {
      const out = tempOut('f9-');
      const { code, stderr } = await runScript(
        SCRIPT,
        ['--start', '2026-03-01T00:00:00Z', '--end', '2026-03-02T00:00:00Z', '--out', out],
        env(base),
      );

      assert.equal(code, 1);
      assert.match(stderr, /ADMIN and REPORTING roles/);
      assert.match(stderr, /region/, 'wrong-region hosts also 401');
    },
  );
});

test('requires the tenant WSDL url rather than guessing one', async () => {
  const out = tempOut('f9-');
  const { code, stderr } = await runScript(SCRIPT, ['--start', '30d', '--out', out], {
    FIVE9_USERNAME: 'svc@example.com',
    FIVE9_PASSWORD: 'placeholder',
    FIVE9_WSDL_URL: '',
  });

  assert.equal(code, 1);
  assert.match(stderr, /FIVE9_WSDL_URL is not set/);
  assert.match(stderr, /no safe default/);
});

test('rejects a reversed time range', async () => {
  const out = tempOut('f9-');
  const { code, stderr } = await runScript(
    SCRIPT,
    ['--start', '2026-03-05T00:00:00Z', '--end', '2026-03-01T00:00:00Z', '--out', out],
    env('http://127.0.0.1:1'),
  );
  assert.equal(code, 1);
  assert.match(stderr, /--start must be before --end/);
});
