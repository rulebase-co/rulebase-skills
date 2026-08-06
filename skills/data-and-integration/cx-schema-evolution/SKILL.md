---
name: cx-schema-evolution
description: Use to change a conversation or event schema without breaking every downstream metric, and to keep historical data comparable across the change. Trigger for "we need to add a field to the schema", "changing the conversation schema", "our historical data doesn't match after the schema change", schema versioning, breaking changes to an export format, or a metric that stepped when a field changed.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: playbook
---

# Evolving a conversation schema

A conversation schema is a contract between an unknown number of consumers: exporters,
warehouse models, dashboards, notebooks, scripts and anything someone built once and left
running. Changing it is easy; changing it without silently corrupting a historical series is
the skill.

**The damage from a bad schema change is almost never an error.** It is a metric that keeps
working and starts meaning something slightly different, discovered a quarter later when two
numbers disagree.

## Classify the change first

| Change | Breaking? | Note |
| --- | --- | --- |
| Adding an optional field | No | Safe, if consumers ignore unknown fields |
| Adding a required field | **Yes** | Old records lack it; every consumer must handle absence |
| Adding a value to an enum | **Yes in practice** | Consumers with exhaustive matches or lookup tables silently drop or mis-bucket the new value |
| Renaming a field | **Yes** | Never do it in place; add the new one, dual-write, migrate, remove |
| Changing a type | **Yes** | Including the innocuous ones: number to string, or a timestamp's precision |
| Narrowing a field | **Yes** | Making an optional field required, or shrinking an enum |
| Changing semantics with no structural change | **Yes, and the worst kind** | Nothing breaks; every historical comparison is now wrong |

That last row is the dangerous one and it has no compile-time signal. Redefining what
`resolved_at` means, or changing which conversations get `channel = 'messaging'`, produces a
step change in every series built on it and no error anywhere.

**Adding an enum value deserves more caution than it gets.** It looks additive and it is
not: a consumer mapping five statuses to buckets will put the sixth nowhere, and a warehouse
`CASE` with no `ELSE` will return null. Treat any new enum value as breaking and tell
consumers.

## Version explicitly, and put the version in the data

- **Semantic versioning on the schema**, with breaking changes reserved for a major bump.
- **A `schema_version` field on every record**, not just in the documentation. A consumer
  that can see the version can branch; one that cannot has to guess from field presence.
- **Never reuse a field name with different meaning across versions.** If the semantics
  change, the field name changes.
- **Keep the old version readable for as long as consumers need it**, and know who they are —
  which requires the consumer register below.

## Dual-write is the mechanism that makes this safe

For anything breaking, the sequence is:

1. **Add the new field or value alongside the old**, populated in parallel. Nothing consumes
   it yet.
2. **Announce it**, with a date, to the consumer register.
3. **Migrate consumers** one at a time, verifying each.
4. **Verify nothing reads the old field** — logs, query history, warehouse dependencies, and
   the scripts nobody documented.
5. **Then remove it**, and only then.

The step that gets skipped is 4, and it is the one that turns a clean migration into an
outage. "Nobody uses that" is a hypothesis; query logs are evidence.

For backfills, decide deliberately whether historical records get the new field. Both answers
are defensible and one must be documented: backfilled means the series is continuous and
history has been rewritten; not backfilled means history is honest and every consumer needs
to handle absence.

## Keep the series comparable, or say that you did not

This is the part that matters to the people using the data rather than building it.

- **A schema change that alters a metric's value breaks the series.** Say so, on the
  dashboard and in the metric definition, with the date.
- **Annotate the change where the chart is read.** A step in a chart with no annotation
  produces an investigation; the same step with a note produces a shrug.
- **Do not silently restate history.** If you recompute historical values under the new
  definition, label them restated and keep the original available.
- **Do not silently leave history alone either.** A series computed one way before a date and
  another way after, with no marker, is the worst option and the most common.

Where a change is significant, publishing both definitions in parallel for a period is
expensive and lets consumers migrate on their own schedule.

## Maintain a consumer register

You cannot manage a contract whose parties you do not know. The register is unglamorous and
it is what makes every decision above possible:

- Who reads each field, from which system, for what.
- Who to tell when it changes, and how much notice they need.
- Which consumers are outside your control — a customer's own pipeline, a partner's
  integration, an exported spreadsheet on someone's laptop.

**External consumers set your real deprecation window**, and they are the ones absent from
every internal dependency graph.

## Additive-only is a strategy, not a cop-out

For a schema with many uncontrolled consumers, deciding that you only ever add and never
change is a legitimate and often correct choice. The cost is accumulated cruft — deprecated
fields that stay forever — and the benefit is that nothing downstream ever breaks.

If you take it, mark deprecated fields as deprecated **in the schema** rather than removing
them, and stop populating them only after the register says nobody reads them.

## Guardrails

- **Do not change a field's meaning without changing its name.** The single most damaging
  move available.
- **Do not remove a field because the current consumers do not use it.** Check the query
  history, and check outside your systems.
- **Do not backfill in place without keeping the original.** Backfills are frequently wrong
  the first time, and an in-place backfill with no original is unrecoverable.
- **Test the migration on a copy**, including the rollback.
- **A schema change that affects a published regulatory or contractual figure** needs
  disclosure, not just an annotation — route it rather than deciding it.

## Present results to the user

1. **The change, classified**, using the table above — including whether it is a
   semantics-only change with no structural signal.
2. **The version bump**, and whether `schema_version` is present in the data.
3. **The consumer register** for the affected fields, with the external consumers named
   separately since they set the deprecation window.
4. **The dual-write sequence**, with the "verify nothing reads the old field" step and the
   evidence for it.
5. **The backfill decision**, documented either way.
6. **Comparability impact** — which metrics step, from which date, and how it will be
   annotated where the chart is read.
7. **The rollback plan**, tested.
8. **Anything requiring disclosure** rather than annotation.
