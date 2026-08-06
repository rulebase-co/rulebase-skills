---
name: cx-metric-definition-registry
description: Use to maintain one authoritative, versioned definition per CX metric — formula, denominator, filters, owner — so dashboards, reports, and alerts measure the same thing and series stay comparable. Trigger for "what does this metric actually mean", "CSAT definition", "why did the number change when we didn't change anything", "document our KPIs", metric registry, definition drift, two teams reporting different FCR, or before adding a metric to a board pack or alert.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: playbook
---

# Metric definition registry

Two teams report "first contact resolution". One counts any ticket closed on the
first day; one counts tickets with no agent reply after the first resolution. Both
are right by their own lights. Together they are useless — and when the number
moves, every meeting becomes a definition argument dressed as a performance review.

The fix is not another alignment workshop. It is **one definition per metric,
versioned, with an owner**, stored where people look before they build, not in a
wiki paragraph nobody maintains.

This skill defines the registry entry schema, change control, and what to do when
a definition change breaks the series.

## One metric, one entry

A metric name without a registry entry does not exist for reporting purposes. If
it appears on a dashboard, the tile is mislabelled until the entry is written.

Each entry covers exactly one reported number. "Customer satisfaction" is not an
entry — it is a category. "CSAT (% satisfied, post-chat survey, responses only)"
is an entry.

## Registry entry schema

Capture each metric as a structured record the team keeps in source control or a
database — not as prose in a chat thread.

```yaml
id: fcr-v3                          # stable identifier; never reused
display_name: First contact resolution
version: 3                          # integer; bump on any definition change
status: active                      # active | deprecated | retired
owner: <person or team>             # accountable for definition, not just the tile
last_reviewed: 2026-08-01

intent: >
  Share of eligible contacts resolved without a subsequent reopen or
  follow-up contact on the same issue within 7 days.

formula:
  numerator: contacts meeting resolution criteria
  denominator: eligible contacts closed in period
  aggregation: rate                            # rate | mean | count | median
  units: percentage_points

population:
  date_field: conversation_closed_at         # name it; never assume
  period_boundary: iso_week
  include: [closed contacts in scope]
  exclude: [bots, spam, internal test accounts]
  scope_dimensions: [channel, market, queue]

resolution_criteria:
  - no reopen within 7 days of first resolution timestamp
  - no new contact from same customer on same driver within 7 days

data_sources:
  - helpdesk.tickets (closed_at, status)
  - contact_driver_taxonomy v4

known_limitations:
  - async channels may resolve after the 7-day window; understates FCR on email
  - driver match depends on taxonomy v4; pre-v4 periods not comparable

comparability:
  breaks_series_from: null                   # or: fcr-v2
  comparable_with: [fcr-v3 only]
  restatement_policy: freeze_at_generation   # or restate_and_label

consumers:
  - dashboard: exec-cx-overview / tile-fcr
  - report: weekly-ops-pack v2
  - alert: none
```

Every field that affects the number belongs here. "Everyone knows we exclude bots"
is not a definition — it is how drift starts.

## Change control

**Any change to formula, population, date field, filters, taxonomy version, or
aggregation breaks comparability with prior periods.** That is not a reason to avoid
change; it is a reason to version honestly.

| Change type | Action |
| --- | --- |
| Typo in documentation only | Fix text; no version bump |
| Clarification that does not alter computed results | Note in changelog; no bump if verified on sample |
| Filter, field, formula, or taxonomy change | New version; old version deprecated |
| Metric no longer used | Status → deprecated, then retired with a sunset date |

Process:

1. **Owner proposes** the change with a worked example showing old vs new on the
   same sample.
2. **State what breaks** — which dashboards, reports, alerts, and external
   commitments use the old version.
3. **Bump version** — never silently rewrite an active entry.
4. **Update consumers** — list every tile, report spec, and alert that must
   switch; do not assume people will notice.
5. **Label the break** — charts show a vertical break or a footnote: "fcr-v2 →
   fcr-v3, not comparable before 2026-08-01".

**Deprecate, do not delete.** Retired definitions stay in the registry with status
`retired` so historical reports remain interpretable.

## When a definition change breaks the series

A broken series is not a failure — an unlabelled break is.

- **Stop comparing** pre- and post-change periods in the same trend line unless
  you have a backfill with documented fidelity limits.
- **Run overlap** — compute both versions on the same window for one or two periods
  so stakeholders see the gap size before you cut over.
- **If the gap is large**, treat it like a new metric (`fcr-v3` as a new id) rather
  than a version bump, so nobody imports old data by mistake.
- **If someone asks "why did it jump?"** after a definition change, the correct
  answer is "we changed the definition on \<date\>", not a performance narrative.

## Governance without bureaucracy

- **Review cadence** — every active entry gets a calendar review, even if nothing
  changed. Stale definitions drift when the tooling changes underneath them.
- **No orphan metrics** — a tile without an owner and a registry entry gets removed
  from production dashboards until both exist.
- **Aliases are forbidden in reporting** — "FCR / one-and-done %" on the same tile
  means two definitions sharing a label. Pick one entry; link the other as
  deprecated.
- **Denominator next to name** — the registry `display_name` in consumer UIs
  should hint at the denominator where space allows: "FCR (% of closed contacts)".

## Traps

- **Defining the metric in the dashboard tool only.** The tool will be replaced;
  the argument will survive.
- **Letting each team maintain a local copy.** Export one registry; import everywhere.
- **Version bump without consumer update.** Two versions in production under the
  same label is worse than one wrong definition.
- **Renaming instead of versioning.** A new name with the old formula still
  confuses; a new version with the same name and a new formula breaks trust silently.
- **Backfilling without a fidelity note.** Restated history is an estimate; say
  what could not be reconstructed.

## Present results to the user

1. **The registry entry** (or entries) — complete schema, version, owner, status.
2. **Gap analysis** — metrics in use today with no entry, or entries with no owner.
3. **Overlap table** — if changing a definition, old vs new on a shared sample with
   the delta stated plainly.
4. **Break notice** — what stops being comparable, from which date, and how consumers
   should label charts and reports.
5. **Consumer checklist** — dashboards, reports, and alerts to update, with owner
   per consumer.
6. **Deprecation plan** — for retired metrics: sunset date, replacement id, and
   where historical figures remain valid.
