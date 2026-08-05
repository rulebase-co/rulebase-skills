---
name: zendesk-apply-erasure
description: Use to apply a reviewed data-subject erasure plan to Zendesk — redacting personal data from comments or deleting tickets, with dry-run and an audit log. Trigger for "redact this customer's data from Zendesk", applying a GDPR erasure plan, right-to-be-forgotten in Zendesk, or purging deleted tickets.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: mutation
  platform: zendesk
---

# Zendesk: apply an erasure plan

Applies a compliance-reviewed erasure plan from `cx-erasure-plan`. This skill
decides nothing — it validates, refuses what it must, and executes the rest.

> **Operational guidance, not legal advice.** Have compliance approve the plan
> before applying it.

## Erasure is irreversible and unverifiable afterwards

**Redaction permanently replaces characters and you cannot see what was removed.**
There is no un-redact and no way to inspect the original. If the wrong string is
redacted, the content is simply gone.

**Deleted tickets go to Deleted Tickets for 30 days, then Zendesk purges them.**
`--permanent` purges immediately. Neither can be undone.

**You cannot redact comments on a closed ticket.** Zendesk does not permit it. For
a closed ticket the only remedy is deleting the whole thing, which is why the plan
distinguishes the two.

The audit log this skill writes is your only record that erasure happened — and by
design it records the *length* of each redacted string, never the value. Logging
the value would defeat the erasure.

## Safety

**1. Dry-run is the default.** Without `--apply`, the plan is re-validated against
live Zendesk and printed. Nothing is written.

**2. Plan-first.** No detection logic. It cannot decide what to erase.

**3. Entries needing a human decision are always refused.** Anything the plan
marked `manual_review` or `blocked_legal_hold` is never applied, under any flag.
They are logged as refused so the audit trail shows they were considered.

**4. It refuses to delete a conversation the subject only appears in.** Defence in
depth: the plan should never propose it, and this script checks `subject_role`
independently. A hand-edited plan cannot talk it into destroying another data
subject's record.

**5. Live re-validation, because status is decisive.** If a ticket has closed since
the plan was built, redaction is no longer legal on it — the entry is skipped with
that reason rather than failing obscurely or falling through to deletion.

**6. Literals are checked before redacting.** If a planned string is no longer in
the comment, it is reported as absent rather than counted as redacted. A false
"redacted" is worse than a skip: it makes an incomplete erasure look complete.

**7. Bounded blast radius.** `--max-changes` defaults to **10** — lower than the
merge skill, because the consequences are worse. Completed conversations are
journalled so an interrupted run resumes.

**8. Purging is a separate opt-in.** Deletion alone leaves the ticket recoverable
for 30 days. `--permanent` is a second explicit step.

## Prerequisites

- Node 20+ (no npm dependencies).
- A Zendesk agent with **delete permission**, and the **"Agents can delete
  tickets"** setting enabled in Admin Center. Without both, redaction returns 403.

```bash
export ZENDESK_SUBDOMAIN=acme
export ZENDESK_EMAIL=svc@acme.com
export ZENDESK_API_TOKEN=…
```

## Usage

Four steps, and step two is a compliance review.

```bash
# 1. Build the plan (read-only, separate skill)
node ../../cx-ops/cx-erasure-plan/scripts/build-erasure-plan.mjs ./out/zendesk \
  --subject-email jo@example.com --out ./plans

# 2. Compliance reviews ./plans/erasure-plan.jsonl

# 3. Dry-run against live state
node scripts/apply-erasure.mjs ./plans/erasure-plan.jsonl --out ./out/erasure

# 4. Redact first, then handle deletions deliberately
node scripts/apply-erasure.mjs ./plans/erasure-plan.jsonl --apply --only redact --out ./out/erasure
node scripts/apply-erasure.mjs ./plans/erasure-plan.jsonl --apply --only delete --max-changes 3 --out ./out/erasure
```

**Arguments**

- `--apply` — actually erase. **Without this, nothing is written.**
- `--only <all|redact|delete>` — default `all`. Run `redact` first.
- `--permanent` — purge deleted tickets immediately instead of after 30 days.
- `--max-changes <n>` — default 10.
- `--out <dir>` — audit log and journal. Default `./out/erasure`.

**Run `--only redact` before `--only delete`.** Redactions are targeted and
lower-risk; deletions destroy whole records. Doing them in separate runs means a
mistake in the redaction pass cannot be compounded by deletions in the same
invocation.

## What this does not do

- **No un-redact, no un-delete.** There is none.
- **No erasure outside Zendesk.** Attachments, recordings, your warehouse, backups,
  embedding stores, and downstream integrations are all untouched. The plan lists
  them; handling them is separate work and the DSR response is incomplete without
  it.
- **No user-record deletion.** This operates on tickets. Deleting the Zendesk user
  is a separate decision with different consequences.
- **No closed-ticket redaction** — Zendesk does not allow it.
- **No action on entries the plan flagged for review.**

## Present results to the user

1. **Mode — dry run or apply.** Never ambiguous.
2. **Refused entries**, restated. These still need a human, and the run completing
   does not mean the request is satisfied.
3. **Redacted literal count and deleted ticket count**, separately. They are
   different kinds of erasure with different consequences.
4. **Any planned literal that was absent**, since that may mean the export is stale
   or the content was already changed.
5. **Whether tickets were purged or are sitting in Deleted Tickets for 30 days.**
   This matters if the DSR has a deadline.
6. **The audit log path**, and that it is the only evidence erasure occurred.
7. **The out-of-scope reminder** — helpdesk erasure is not business-wide erasure.
8. **What remains**, and the command to continue.

Never quote erased or to-be-erased content into chat.

## Troubleshooting

**403** — the agent lacks delete permission, or "Agents can delete tickets" is off
in Admin Center. Both are required for redaction, which surprises people.

**"closed since the plan was built"** — re-run the plan. A closed ticket needs
deletion rather than redaction, so the correct action has changed.

**"no longer present"** — the literal is not in the comment. Either it was already
redacted, or the export is stale. Re-export and re-plan to confirm.

**Redaction succeeded but the data is still visible in search** — Zendesk search
indexes can lag, and your own warehouse or search tool is not covered at all. See
the out-of-scope list.

**Nothing happened and no error** — `--apply` was omitted. That is the intended
default.
