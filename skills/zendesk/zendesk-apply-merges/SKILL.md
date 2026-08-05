---
name: zendesk-apply-merges
description: Use to apply a reviewed ticket merge plan to Zendesk, with dry-run, live re-validation and an audit log. Trigger for "merge these duplicate Zendesk tickets", applying a merge plan, bulk ticket merge, or deduplicating a Zendesk instance after running duplicate detection.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: mutation
  platform: zendesk
---

# Zendesk: apply a merge plan

Applies a reviewed merge plan produced by `cx-duplicate-detection`. This skill
decides nothing — it validates and executes.

## Merging is irreversible

**Zendesk ticket merges cannot be undone.** Source tickets are closed, their
comments are copied into the target, and there is no un-merge. Closed tickets
cannot be reopened or re-merged either, so a wrong merge is permanent.

There is no recovery path. The audit log this skill writes is the only record of
what changed, which is why it is written as the run proceeds rather than at the
end.

Everything below follows from that one fact.

## Safety

Six guardrails, in order of how much they matter.

**1. Dry-run is the default.** Running without `--apply` re-validates the entire
plan against live Zendesk and prints exactly what would happen. Nothing is
written. The default invocation is safe to run at any time, on any account, by
accident.

**2. Plan-first.** This skill only consumes a plan file. It has no detection logic
and cannot decide what to merge. An agent can generate a plan with
`cx-duplicate-detection` and hand it to a human without being able to apply it.

**3. Every entry is re-validated live before it is applied.** A plan is a snapshot.
By the time it runs, requesters may have changed, tickets may have been closed or
already merged. Each entry is re-fetched and checked:

| Check | On failure |
| --- | --- |
| Target exists | Skip |
| Target is not closed | Skip — Zendesk cannot merge closed tickets |
| Live target requester matches the plan's `customer_id` | **Skip — the plan is stale** |
| Every source exists | Skip |
| No source is closed | Skip |
| Every source's requester matches the target's | **Skip — would disclose across customers** |

A mismatch always skips. There is no flag to override any of these, and there is
deliberately no `--force`.

The requester checks are the important ones. Without them, a ticket reassigned
between detection and application could merge one customer's conversation into
another's — a data breach rather than a data-quality mistake.

**4. Append-only audit log.** Every attempt, including dry runs and skips, appends
a record to `audit-log.jsonl` with before-state, after-state, outcome, and reason.
Written as it happens, so a crash mid-run leaves a complete record of what
preceded it.

**5. Bounded blast radius.** `--max-changes` defaults to **25**. Exceeding it
requires raising the flag explicitly. Applied targets are journalled, so an
interrupted run resumes rather than re-merging.

**6. Verify after applying.** Each source is re-read to confirm it closed. Zendesk
merges asynchronously, so a source not yet closed is reported as
`applied_unverified` rather than silently assumed to have worked.

## Prerequisites

- Node 20+ (no npm dependencies).
- A Zendesk API token belonging to an agent **with permission to merge tickets**. A
  read-only token returns 403.
- A merge plan from `cx-duplicate-detection`.

```bash
export ZENDESK_SUBDOMAIN=acme
export ZENDESK_EMAIL=svc@acme.com
export ZENDESK_API_TOKEN=…
```

Never pass the token as an argument.

## Usage

The intended sequence is three steps, and the middle one is a human reading a file.

```bash
# 1. Detect (read-only, separate skill)
node ../../cx-ops/cx-duplicate-detection/scripts/detect-duplicates.mjs ./out/zendesk --out ./plans

# 2. Review ./plans/merge-plan.jsonl, then dry-run against live state
node scripts/apply-merges.mjs ./plans/merge-plan.jsonl --out ./out/merges

# 3. Apply, starting small
node scripts/apply-merges.mjs ./plans/merge-plan.jsonl --apply --max-changes 5 --out ./out/merges
```

**Arguments**

- `--apply` — actually merge. **Without this, nothing is written.**
- `--out <dir>` — audit log and resume journal. Default `./out/merges`.
- `--min-confidence <high|medium|low>` — default **high**. Deliberately stricter
  than the detector's default.
- `--max-changes <n>` — maximum merges this run. Default 25.
- `--target-comment <text>` — public note added to the surviving ticket.
- `--source-comment <text>` — public note added to each merged-away ticket.

**Use the comments.** A merged-away ticket with no explanation is confusing for the
customer, who may have the old ticket number. Something like
`"We've combined this with your earlier ticket so everything is in one place."`
costs nothing and prevents a follow-up contact.

**Start with `--max-changes 5`** on a real account, then check those five in the
Zendesk UI before scaling up. There is no undo, so the first batch is the only
cheap chance to notice a systematic problem.

## What this does not do

- **No un-merge.** There is none.
- **No detection.** It will not find duplicates; it applies a plan.
- **No cross-customer merge**, under any flag.
- **No closed-ticket merge** — Zendesk does not permit it.
- **No partial application of an entry.** If one source in a cluster fails
  validation, the whole entry is skipped rather than merging some of it.

## Present results to the user

1. **Mode first — dry run or apply.** Never let this be ambiguous. If it was a dry
   run, say plainly that nothing changed.
2. **Merged, skipped, and failed counts**, with the skip reasons grouped. Skips are
   the interesting output: a lot of stale-plan skips means re-run detection.
3. **Any `applied_unverified`** results, and that Zendesk merges asynchronously so
   they may settle shortly.
4. **The audit log path**, and that it is the only record of what changed.
5. **What remains**, and the command to continue.
6. **Irreversibility**, restated after an apply run. This is worth saying twice.

## Troubleshooting

**403** — the token's agent cannot merge tickets. Merge permission is separate from
read access.

**Everything skipped with "plan is stale"** — requesters changed since detection,
or the plan is from a different account. Re-run detection against a fresh export.

**"target is closed"** — Zendesk cannot merge closed tickets. Nothing to do; drop
those entries.

**A source was "not found"** — it was already merged or deleted. Usually means this
plan was partly applied by an earlier run whose journal you no longer have; re-run
detection.

**`applied_unverified`** — the merge was accepted but the source had not closed when
re-read. Zendesk merges asynchronously. Check the tickets a minute later; if they
are still open, check the job status in Zendesk.

**Nothing happened and no error** — you omitted `--apply`. That is the intended
default.
