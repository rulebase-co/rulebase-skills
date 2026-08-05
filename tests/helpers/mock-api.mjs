/**
 * Shared harness for platform-export script tests: an in-process HTTP mock plus
 * a child-process runner.
 *
 * `plan(req, callNumber, body)` returns { status?, headers?, body } and receives
 * the parsed request body when one was sent, so a test can assert on what the
 * script actually asked for.
 */

import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function withMockApi(plan, run) {
  const calls = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let parsed = null;
      if (raw) {
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }
      }
      calls.push({ url: req.url, method: req.method, body: parsed, headers: req.headers });

      const reply = plan(req, calls.length, parsed) ?? {};
      res.writeHead(reply.status ?? 200, reply.headers ?? { 'content-type': 'application/json' });
      res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {}));
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run({ base, calls, urls: () => calls.map((c) => c.url) });
  } finally {
    server.close();
  }
}

export function runScript(script, args, env) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [script, ...args],
      { env: { ...process.env, ...env } },
      (err, stdout, stderr) =>
        resolve({
          code: err?.code ?? 0,
          stdout,
          stderr,
          summary: (() => {
            try {
              return JSON.parse(stdout);
            } catch {
              return null;
            }
          })(),
        }),
    );
  });
}

export const tempOut = (prefix) => mkdtempSync(join(tmpdir(), prefix));

export const readJsonl = (p) =>
  existsSync(p)
    ? readFileSync(p, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

/** Asserts a record conforms to the canonical conversation shape. */
export const CANONICAL_CONVERSATION_FIELDS = [
  'source',
  'source_id',
  'subject',
  'status',
  'status_raw',
  'channel',
  'channel_raw',
  'customer_id',
  'assignee_id',
  'team_id',
  'account_id',
  'created_at',
  'updated_at',
  'resolved_at',
  'csat',
  'csat_raw',
  'priority',
  'tags',
  'is_deleted',
];

export const CANONICAL_MESSAGE_FIELDS = [
  'source',
  'conversation_source_id',
  'source_id',
  'created_at',
  'author_id',
  'author_type',
  'visibility',
  'channel',
  'attachment_count',
  'body',
];

export const CANONICAL_STATUSES = ['open', 'pending', 'resolved', 'closed', 'snoozed', 'deleted'];
export const CANONICAL_CHANNELS = [
  'email',
  'chat',
  'messaging',
  'voice',
  'social',
  'web_form',
  'api',
  'other',
];
export const CANONICAL_AUTHOR_TYPES = ['customer', 'agent', 'bot', 'system', 'unknown'];
