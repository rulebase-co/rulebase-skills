---
name: salesforce-export-cases
description: Use to bulk-export Salesforce Service Cloud cases and their conversation text for analytics, QA sampling, migrations, or LLM/RAG pipelines. Trigger for "export Salesforce cases", "pull Service Cloud data", "get case comments and emails out of Salesforce", Bulk API 2.0 case export, incremental Salesforce sync, or when a case export is missing email replies or hitting SOQL row limits.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: platform
  platform: salesforce
---

# Salesforce Service Cloud: export cases

Export Salesforce cases and their conversation text into the canonical
`conversations.jsonl` / `messages.jsonl` shape, via Bulk API 2.0.

## Read this before writing any code

**A case's conversation is not in one object. It is in up to three.**

| Object | Field | Holds |
| --- | --- | --- |
| `CaseComment` | `CommentBody` | Manually added comments |
| `EmailMessage` | `TextBody` / `HtmlBody` | Email-to-Case correspondence |
| `FeedItem` | `Body` | Chatter / Case Feed posts |

Nearly everyone exports `CaseComment` first, because the name says "comment". On
an Email-to-Case org — which is most Service Cloud orgs — that misses **the entire
email conversation**, which is usually the overwhelming majority of the actual
dialogue. The export succeeds, returns plausible data, and is substantively empty.

This script queries all three by default and unifies them into `messages.jsonl`
with a `message_source` field, then reports the per-source counts and **warns when
any source returned nothing**. A zero from `EmailMessage` means either the org
genuinely doesn't use it or you lack read access — both worth knowing before
anyone trusts the data.

**Synchronous SOQL will not do this job.** The REST query endpoint caps result
sets and paginates in small batches. Use **Bulk API 2.0 query**, which is
asynchronous and designed for large extracts:

```
POST /services/data/vXX.X/jobs/query          -> job id
GET  /services/data/vXX.X/jobs/query/{id}     -> poll until state JobComplete
GET  .../jobs/query/{id}/results?maxRecords=N -> CSV, paged by Sforce-Locator
```

Pagination is the **`Sforce-Locator` response header**, not a query parameter you
compute. The literal string `'null'` means no more pages. Salesforce's docs are
explicit that you must use only the header value and never construct locators
yourself.

**Use `queryAll`, not `query`.** `queryAll` includes archived and soft-deleted
rows. With plain `query` your counts silently undershoot the org and no one can
work out why. The script defaults to `queryAll`.

Endpoint and field detail: [references/api-notes.md](references/api-notes.md).

## Prerequisites

- Node 20+ (the script has no npm dependencies).
- An OAuth access token and the org's instance URL.
- The user needs **API Enabled** plus read access to `Case`, `CaseComment`,
  `EmailMessage`, and `FeedItem`. Missing object access shows up as an empty
  source, not an error — which is exactly why the script warns on zeroes.

```bash
export SALESFORCE_INSTANCE_URL=https://acme.my.salesforce.com
export SALESFORCE_ACCESS_TOKEN=…
export SALESFORCE_API_VERSION=61.0     # optional
```

**Access tokens are short-lived.** A long export will outlive one. When it 401s,
refresh the token and re-run with `--resume`; completed objects are skipped.

## Usage

```bash
node scripts/export-cases.mjs --start 2026-01-01 --out ./out/salesforce
```

**Arguments**

- `--start <when>` — filter on `LastModifiedDate`. ISO date/timestamp, epoch
  seconds, or a relative window (`30d`). Required unless `--resume`.
- `--out <dir>` — output directory. Default `./out/salesforce`.
- `--resume` — continue; objects already exported are skipped.
- `--only <both|conversations|messages>` — run one phase.
- `--sources <list>` — message objects to query. Default
  `CaseComment,EmailMessage,FeedItem`. **Narrow only if you know the org doesn't
  use one.**
- `--exclude-deleted` — use `query` instead of `queryAll`. Counts will not
  reconcile.
- `--no-bodies` — message metadata without text.

**Sample with a narrow window first**, and check the per-source counts:

```bash
node scripts/export-cases.mjs --start 2d --out ./out/sample
```

If `EmailMessage` reports zero on a sample you know contains emails, stop and fix
permissions before running the full export.

## Sizing the run

Bulk API 2.0 is built for this: a single query job can return up to 15 GB across
15 files, and PK chunking is available for `Case`. The practical constraints are
the org's **24-hour API request allocation** (which scales with licences) and job
concurrency limits.

Because the work is server-side, wall-clock time is dominated by job execution
rather than your request count — four jobs for a year of cases is normal. If a job
does not finish within 30 minutes the script fails and tells you to narrow
`--start`.

## What the export will not contain

- **Message sources you excluded.** The most consequential omission; see above.
- **Custom objects.** Orgs that model support in a custom object instead of
  `Case` need a different query. This skill covers the standard object.
- **`HtmlBody`.** The script takes `TextBody` for analysis. HTML inflates token
  counts and breaks length metrics.
- **CSAT.** Salesforce has no standard satisfaction field; surveys live in Feedback
  Management or a custom field, so `csat` is `null` rather than guessed.
- **Attachments / ContentDocument.** Only an email attachment flag is exported.
- **Field history.** `CaseHistory` is a separate object.
- **`team_id`.** Salesforce has no team field on `Case` — queue ownership is
  encoded in `OwnerId`, which may be a User or a Group. Resolving which requires a
  separate query, so the field is left null rather than duplicating `OwnerId`.

## Output

Canonical shape, shared with the other platform export skills in this catalog:

```
conversations.jsonl     one case per line
messages.jsonl          one message per line, joins on conversation_source_id
checkpoint.json         resume state (which objects are done)
```

Normalisation notes:

- **`IsClosed` is the reliable status signal.** Case `Status` is
  org-configurable, so the mapping matches on well-known values and falls back to
  `open`, always keeping `status_raw`.
- **`Origin` is org-configurable too**, so channel mapping is substring-based
  (`Email`, `Phone`, `Web`, `Chat`, …) with `channel_raw` preserved.
- **`EmailMessage.Incoming` is the author signal for email** — `true` is the
  customer. Inbound email has no Salesforce user, so `author_id` is the
  `FromAddress`, which is a different kind of identifier from the Salesforce Ids
  used elsewhere. Account for that when joining.
- **`CaseComment.IsPublished: false` is an internal note.**
- **`FeedItem` is treated as internal** by default. Chatter posts are usually
  agent-facing; marking them public would overstate what the customer saw.
- `message_source` records which object each message came from — essential for
  auditing coverage.

## Handling the data

Case and email bodies are production PII.

- Never commit `.jsonl` exports to git.
- Do not paste bodies into chat. Report counts, IDs, and aggregates.
- If the task only needs volumes or routing, run `--no-bodies`.

## Present results to the user

1. **Per-source message counts first** — `CaseComment`, `EmailMessage`,
   `FeedItem`. This is the headline, because it is how you tell a complete export
   from a plausible-looking empty one. Name any source that returned zero and say
   the two possible causes (org doesn't use it, or read access missing).
2. **Completeness** — objects finished, and the resume command if not.
3. **Volumes** — cases, messages, messages per case. A messages-per-case figure
   near 1 on an Email-to-Case org is a strong signal that a source is missing.
4. **`queryAll` vs `query`** — state which was used, since it determines whether
   counts can reconcile with the org.
5. **The identifier caveat** — inbound email authors are email addresses, not
   Salesforce Ids.
6. **Reconciliation** against a report in the org for the same window.
7. **Where the data is**, plus the PII reminder.

## Troubleshooting

**Messages per case is about 1** — you are almost certainly missing
`EmailMessage`. Check `sources_with_no_messages` in the summary.

**A source returned zero** — either the org doesn't use it or the user lacks read
access on that object. Verify with an admin-scoped user before accepting it.

**401 mid-run** — the access token expired. Refresh and `--resume`.

**403** — missing "API Enabled", missing object read access, or the org's 24-hour
API allocation is exhausted. The error text distinguishes them.

**Job state `Failed`** — the message is passed through; most often an invalid field
in the SOQL because the org lacks that field, or a permissions problem.

**Counts don't reconcile with the org** — check whether `--exclude-deleted` was
used. `queryAll` is the default for exactly this reason.

**Job times out** — narrow `--start`. A month at a time is a reasonable unit for
large orgs.
