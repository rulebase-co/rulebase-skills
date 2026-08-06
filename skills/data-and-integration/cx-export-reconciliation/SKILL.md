---
name: cx-export-reconciliation
description: Use to prove a conversation export is complete against the source system's own counts, before anything is built on it. Trigger for "is this export complete", "reconcile the export against Zendesk", "our export is missing tickets", "the numbers don't match the helpdesk", verifying a migration or a backfill, or signing off a dataset for analysis.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: analysis
---

# Reconciling an export against its source

Every analysis in this catalog assumes its input is complete. Almost none of them can tell
when it is not — a metric computed on 80% of conversations looks exactly like a metric
computed on all of them, and it is wrong by an amount nobody can estimate afterwards.

Support APIs lose data quietly. A default status filter, a pagination cap, a permission scope,
a rate limit that ended a run early, an integration that was offline for a week. All of these
produce a healthy-looking file.

**Reconcile before you analyse, and report the reconciliation alongside every conclusion.**

## The source's own count is the only real anchor

Every inferred check below can be fooled. A count from the platform cannot, so get one:

- The platform's own reporting or analytics view for the same window.
- A count endpoint or a `total_count` in a list response.
- The UI's own result count for an equivalent filter.

Then compare, and **compare per segment as well as in total.** A total that matches while one
channel is short and another is long is two errors cancelling, and it happens more often than
it should.

Where the platform's count uses a different definition from your export — a different date
field, a different status set — reconcile the definitions first. The gap is frequently the
definition rather than missing data, and finding that out is worth more than the count.

If no source count is obtainable, say so explicitly. The rest of the checks then constitute
*internal consistency*, not completeness, and the difference matters.

## Run it

```bash
node scripts/reconcile-export.mjs --dir ./out --expected expected.json
```

`expected.json` carries the source's counts and the window you asked for. The script checks
the total and per-segment counts against it, finds duplicate ids, records outside the window,
days with no data at all, orphaned messages, and the field-population rates that indicate a
partial extract. See [references/expected-format.md](references/expected-format.md).

## Daily coverage is the highest-yield inferred check

A gap in a date-partitioned count is the clearest signal of a failed run, and it is visible
without any source count.

- **List every day in the window with zero conversations.** On most operations that is
  suspicious immediately, and it points at the exact day a run failed.
- **Check volume per day against a seasonal baseline** — same weekday, over several weeks.
  A day at 30% of normal is a partial run, and a total-only check will never see it.
- **Distinguish a real quiet day** — a public holiday, a weekend, a market's closure — from a
  gap. This needs the per-market holiday calendar, and without it every holiday looks like an
  outage.

## What each check actually catches

- **Total short of source** — a status default, a pagination cap, a permission scope, or a run
  that ended early.
- **Total over source** — duplicate ingest, or a different definition on one side.
- **Duplicate `source_id`s** — a re-run without an upsert key, or overlapping windows appended
  rather than merged.
- **Records outside the requested window** — a filter that did not apply, which usually means
  the whole window filter was ignored and you have an unbounded extract.
- **A day with zero records** — a failed run.
- **One segment much shorter than its source count** — a permission scope excluding an inbox,
  queue or market. **The most common partial-export cause, and it never errors.**
- **Orphaned messages** — messages whose conversation is absent, meaning the conversation pass
  and the message pass disagree.
- **Conversations with zero messages** — expected for voice-only sources, a red flag for text
  ones, so it must be interpreted per source.
- **A field's population rate far below expectation** — an extract that skipped a hydration
  step, which is the failure that corrupts metrics rather than stopping them.
- **A high `unknown` author-type share** — a broken author mapping, which invalidates every
  response-time and turn-count metric downstream.

## Reconciling a migration or a backfill

Same checks, plus:

- **Compare id sets, not counts.** For a migration, the question is which specific records are
  missing, and a matching count with different membership is entirely possible.
- **Check the tails.** The oldest and newest records on each side. A migration that silently
  started at a date boundary shows up here first.
- **Check the things that are easy to lose in a migration**: attachments, internal notes,
  status history, custom fields, and the mapping of agents to their records.
- **Reconcile after the source stops changing**, or accept that the delta includes real new
  activity. Where you cannot freeze the source, take both snapshots at the same instant and
  say you did.

## Report it as a gate, not as a note

The output should be usable as a sign-off:

- **A verdict**: reconciled, reconciled with known gaps, or not reconciled.
- **The residual gap**, as a count and a percentage, with the segments it sits in.
- **The specific missing ids or days**, so it can be re-run rather than re-argued.
- **What was not checkable**, and therefore what completeness claim is unsupported.

Then carry the verdict forward. An analysis built on an export reconciled to 94% should say so
in its own limitations, and the number should travel with the dataset rather than living in a
ticket.

## Guardrails

- **Do not analyse an unreconciled export and add a caveat later.** The caveat does not
  propagate; the number does.
- **Do not treat internal consistency as completeness.** No duplicates and no gaps is
  compatible with missing a third of the account.
- **Do not fill a gap by re-running with a wider window and appending.** That produces
  duplicates. Re-run into a clean directory, or upsert on `source_id`.
- **Do not silently drop records that fail a check.** Report them; they are the finding.
- **Report counts and ids only.** Reconciliation output does not need conversation content,
  and exports are production PII that must not be committed.

## Present results to the user

1. **The verdict**, first — reconciled, reconciled with known gaps, or not reconciled.
2. **Source counts versus export counts**, in total and per segment, with the definition
   reconciliation where the two sides count differently.
3. **Daily coverage**, with zero-days and low-days listed, and holidays distinguished from
   gaps.
4. **Structural checks** — duplicates, out-of-window records, orphaned messages, empty
   conversations interpreted for this source type.
5. **Field population rates**, including the `unknown` author-type share.
6. **The residual gap**, quantified, with the specific ids or days to re-run.
7. **What could not be checked** — no source count available, no holiday calendar, no id list
   for a migration — and the completeness claim that is therefore unsupported.
