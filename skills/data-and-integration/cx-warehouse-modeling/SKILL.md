---
name: cx-warehouse-modeling
description: Use to model support conversation data for a warehouse so metrics are computed once and agree with each other, with the grain of every table stated. Trigger for "model our support data in the warehouse", "build dbt models for tickets", "our support metrics disagree between dashboards", conversation fact tables, ticket grain, or designing a semantic layer over helpdesk data.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: playbook
---

# Modelling support data for a warehouse

Support data in a warehouse produces disagreeing numbers faster than almost any other
domain, and the cause is nearly always the same: **the grain of a table was never stated,
so two people joined it two ways and both got a defensible answer.**

A conversation is not one row. It is a conversation, a set of messages, a set of agent
assignments, a set of status transitions, and possibly several evaluations — five grains
that get flattened into one wide table because that is convenient, and then produce a
metric that double-counts.

## State the grain of every table, in the table

The single highest-value convention in this domain. Every model gets a one-line grain
declaration, and it belongs in the model's own documentation rather than in a wiki:

```
fct_conversations       one row per conversation
fct_messages            one row per message
fct_conversation_agents one row per (conversation, agent) — a conversation can have several
fct_evaluations         one row per (conversation, agent, scorecard) — not per conversation
fct_status_events       one row per status transition
```

**`fct_evaluations` is where this bites hardest.** Rulebase-style QA produces one
evaluation per eligible agent per matching scorecard, so joining evaluations to
conversations and counting conversations over-counts by the number of agents on the ticket
times the number of scorecards. Every "why does the criterion count exceed the team count"
question traces to this.

Once the grain is declared, the fan-out rule follows: **never join two tables at different
grains and then aggregate without collapsing one first.**

## The canonical schema is the staging layer, not the mart

If your exports emit the canonical conversation schema, that shape is your staging layer —
one `stg_` model per source, all conforming to the same columns, with the vendor's raw
values preserved in the `*_raw` fields beside every normalised one.

Two consequences worth designing for deliberately:

- **Vendor-specific logic lives in staging and nowhere else.** A mart model containing a
  `CASE WHEN source = 'zendesk'` is a leak; the mapping belonged upstream.
- **Keep the `*_raw` columns all the way through.** They are what lets someone reconstruct a
  vendor-specific distinction the canonical enum collapsed — Zendesk's `solved` versus
  `closed`, or an account-configured status. Dropping them because "the normalised column is
  enough" is the change you will regret when a reconciliation fails.

Where a source cannot fill a canonical column, leave it null rather than substituting a
default. `channel = 'other'` and `channel = null` mean different things and a default hides
which one you have.

## The date columns, and why there must be several

Every conversation has at least four meaningful timestamps, and picking one as "the" date
is the second-largest source of disagreeing numbers:

- **Event time** — when it happened in the source system.
- **Record time** — when it was created in the source's own database.
- **Ingest time** — when it landed in your warehouse.
- **Resolution time.**

Model all of them, name them unambiguously (`created_at_source`, `ingested_at`), and
**never call a column just `date`**. Then make the semantic layer force a choice: a metric
definition that does not name its date column is not a definition.

Backfills and re-syncs make event time and ingest time diverge by months, so a dashboard
partitioned on ingest time will show history changing. That is correct behaviour and it
looks like a bug, which is why the distinction has to be visible in the column names.

## Late-arriving and mutable data

Support records are **mutable for their whole life**. A ticket opened in January can change
in August: status, assignee, tags, and even message content after a redaction.

This breaks the usual append-only warehouse assumption, so decide explicitly:

- **Snapshot the mutable dimensions** if you need to answer "what did this look like then".
  Status history and assignment history are the two that get asked about, and they are
  gone forever if you only ever overwrite.
- **Incremental models need a reprocessing window** wide enough to catch late updates, and
  a periodic full refresh to catch anything outside it. State the window; an incremental
  model with a 3-day lookback silently misses a 6-month-old ticket that got reopened.
- **Deletions do not arrive in an incremental sync at all.** A ticket deleted at source
  stays in your warehouse until a reconciliation removes it. Plan a periodic id diff.
- **Frozen versus restated** — decide whether a published metric is frozen at its
  computation date or recomputed each run. Both are defensible; not choosing means the
  number quietly changes and someone loses trust in the whole warehouse.

## Metrics belong in one place

The reason two dashboards disagree is almost always that each computes the metric itself.

Define each metric once — in a semantic layer, a metrics file, or at minimum a single
model — with its numerator, denominator, date column, status filter and exclusions
written down. Then have dashboards consume the definition rather than the tables.

The definitions that need this most, because they are the ones people redefine casually:
first response time, resolution time, repeat contact, coverage, and anything with
"active" or "valid" in it.

## Modelling traps specific to support data

- **Bot and system accounts look like agents.** If they land in your agent dimension, they
  become your highest-volume agent and distort every per-agent metric. Flag them in staging
  and let marts exclude them by default.
- **Merged and duplicate conversations.** Model the duplicate pointer, and give marts a
  `is_primary` flag so the default answer excludes duplicates without every analyst
  remembering to.
- **Internal notes are messages.** Model them with a visibility column; whether they count
  depends on the question, and a mart that silently includes them will overstate response
  volume.
- **Multi-agent conversations** need `fct_conversation_agents` and a documented rule for
  which agent a conversation-level metric attributes to — first, last, longest, or none.
- **Business hours** are a dimension, not a calculation. Build a business-minutes calendar
  table per market; recomputing it in each metric guarantees divergence.
- **Timezones.** Store UTC, convert at the presentation layer, and record the market's zone
  in the dimension so it can be converted correctly.
- **Free-text and PII.** Message bodies in a warehouse are production PII reaching a much
  wider audience than the helpdesk. Decide whether bodies belong there at all; often the
  mart needs lengths, counts and derived features rather than text.

## Present results to the user

1. **The grain of every model**, written into the models, and the fan-out rule.
2. **The staging layer**, one model per source, conforming to the canonical schema with
   `*_raw` retained.
3. **The date columns**, named unambiguously, with the metric-level choice forced.
4. **The mutability decisions** — what is snapshotted, the incremental lookback window, the
   deletion reconciliation, and frozen versus restated.
5. **The metric definitions**, once, with numerator, denominator, date column, status filter
   and exclusions.
6. **Default exclusions** — bots, duplicates, internal notes — applied in marts so the
   correct answer is the easy one.
7. **What is deliberately not modelled**, and the PII position on message bodies.
