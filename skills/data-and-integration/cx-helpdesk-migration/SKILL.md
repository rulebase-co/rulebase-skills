---
name: cx-helpdesk-migration
description: Use to plan or verify a migration between helpdesk platforms — Zendesk, Intercom, Freshdesk, Salesforce, HubSpot, Gorgias, Front and others. Trigger for "migrating from X to Y", "helpdesk migration plan", "did our migration lose data", "verify our ticket import", historical data fidelity, or reconciling counts after a support platform move.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: playbook
---

# Helpdesk migration: planning and verifying fidelity

Migrations do not fail loudly. The tool reports success, ticket counts look about
right, and the loss surfaces months later when a metric will not reconcile and
nobody can explain why. By then the source system is decommissioned and the data
is gone.

This is how to decide what to move, and how to prove what actually arrived.

## The one thing that matters most

**Verify `created_at` preservation before anything else.**

Many migrations stamp the import date as the creation date. It is the single most
damaging loss, because:

- Every historical volume trend, cohort analysis, response-time metric, and
  seasonality baseline is computed from it.
- It looks fine in the UI — tickets exist, contents are there.
- It is **unrecoverable** once the source is switched off.

A migration that preserves message bodies but resets timestamps has destroyed
your entire reporting history while appearing to succeed. Test it on 20 tickets
before you migrate 200,000.

## Step 1: decide what not to migrate

The default assumption — move everything — is usually wrong and always expensive.

Ask what each class of data is *for*:

| Data | Usual answer |
| --- | --- |
| Open and recently-closed tickets | Migrate. Agents need continuity |
| Closed tickets from the last 12–24 months | Migrate if you analyse them |
| Older closed tickets | Usually **archive, don't migrate** |
| Macros, automations, views | Rebuild, don't port. They encode the old tool's model |
| Agent accounts for departed staff | Map to a placeholder identity |
| Attachments | Decide explicitly; often the bulk of the volume and cost |

**A read-only archive of the old system, or a canonical export in cold storage, is
almost always cheaper and safer than a perfect migration.** It satisfies the
"we might need to look something up" requirement without paying to make seven
years of closed tickets live in a new tool. Propose it early; it collapses most of
the scope arguments.

## Step 2: inventory what has no equivalent

Go field by field. The migration risk lives entirely in fields with no target
equivalent, because that is where tooling silently drops or coerces.

Reliably lossy across most platform pairs:

- **Internal note vs public reply.** Different flag on every platform. Getting this
  wrong is not a data-quality issue, it is a disclosure incident — internal
  commentary becoming customer-visible.
- **Timestamps.** `created_at`, and separately the resolution/close timestamps that
  SLA reporting uses.
- **Custom fields.** Types rarely map cleanly; dropdowns become text, dates become
  strings, required-ness disappears.
- **Satisfaction ratings.** Different scales, often no target field at all.
- **SLA clocks and pause states.** Almost never portable. Historical SLA
  attainment usually cannot be reconstructed after a move.
- **Ticket relationships.** Merged, linked, parent/child, side conversations.
- **Agent identity for departed staff.** Users who no longer exist cannot be
  assigned, so authorship degrades to unknown.
- **Status semantics.** Zendesk's solved-vs-closed distinction has no Freshdesk
  equivalent; Gorgias has only open/closed. Reopen-rate history dies here.

For each: decide *preserve*, *transform*, or *accept the loss* — and write down
which. An accepted loss that was decided is fine. An accepted loss discovered
later is a failure.

## Step 3: export both sides in the canonical schema

Export each side into the shape defined by the `cx-conversation-schema` skill —
`conversations.jsonl` and `messages.jsonl`, same field names, same enum vocabulary. This
is what makes a cross-platform diff possible at all: you are comparing like to like
rather than the old vendor's model to the new one's.

Writing those two extractions is your job, and it is worth doing carefully, because a
migration diff is only as trustworthy as the weaker of its two exports. In particular,
**an export that silently truncates on one side will read as data loss in the
migration** — so reconcile each export against its own source's counts before comparing
them to each other, or you will spend the cutover chasing a phantom.

Export the source **before** cutover and keep it. It is your only evidence of what
should have arrived, and it doubles as the cold-storage archive from Step 1.

## Step 4: verify fidelity

```bash
node scripts/migration-fidelity.mjs --source ./out/old-helpdesk --target ./out/new-helpdesk
```

**Arguments**

- `--source <dir>` / `--target <dir>` — canonical exports from each side.
- `--id-map <path>` — CSV of `source_id,target_id`. Most target systems reassign
  ids, so you will usually need this; without it nothing matches.
- `--drift-seconds <n>` — timestamp tolerance before drift is reported. Default 60.
- `--json` — machine-readable output.

It exits non-zero on any critical loss, so it works as a cutover gate in CI.

What it checks, and why each earns its place:

| Check | Severity | Why |
| --- | --- | --- |
| Conversations missing from target | critical | The obvious loss, easily missed at scale |
| `created_at` drift | critical | Destroys historical metrics |
| `created_at` collapsed to one day | critical | The signature of an import-date reset |
| `customer_id` / `status` lost | critical | Breaks per-customer and state analysis |
| Messages lost per conversation | critical | Counts match, contents don't |
| Internal-note flag lost | critical | Possible disclosure of internal commentary |
| `csat`, `tags`, `channel`, `assignee_id` lost | warning | Analysis degrades, not destroyed |
| Author attribution degraded | warning | Usually unmapped departed agents |
| Extra conversations in target | warning | New activity, or a duplicated import |
| Per-month count deltas | reported | The reconciliation table to show stakeholders |

**Run it on a pilot batch first.** Migrate 100 tickets spanning several years and
channels, verify, fix, and only then run the full load. Finding an import-date
reset on 100 tickets is an afternoon; finding it on 200,000 after cutover is a
lost reporting history.

## Step 5: cutover

**Prefer a hard cutover with a read-only source** to a long dual-run. Dual-running
two helpdesks means agents miss tickets in whichever one they are not looking at,
and customers get two threads for one problem. If you must dual-run, make it days,
not weeks, and route strictly by channel or queue rather than by agent choice.

Freeze the source before the final delta export. Any ticket updated between the
export and the freeze is a reconciliation gap.

Plan the rollback before you need it: what happens if, two days in, the new tool
cannot handle your volume. Usually this means keeping the source live and writable
for a defined window.

## Present results to the user

1. **The fidelity verdict** — pass, pass-with-warnings, or fail. If it failed, say
   plainly that the source must not be decommissioned yet.
2. **`created_at` status, explicitly**, even when it passed. It is the loss that
   matters most and the one stakeholders should hear confirmed.
3. **The per-month reconciliation table.** This is what a stakeholder will ask for
   and what you will be judged on.
4. **Accepted losses**, restated from Step 2, so nobody discovers them later. Name
   what analyses each one prevents — "historical SLA attainment is not
   reconstructable" is more useful than "SLA fields not migrated".
5. **What is archive-only** rather than migrated, and how to retrieve it.
6. **Remaining risks** — unmapped agents, custom field coercions, attachment
   status.

## Troubleshooting

**Nothing matches between source and target** — the target reassigned ids. Build
an `--id-map`; most migration tools can emit one, and it is worth insisting on
before the migration runs.

**Counts match but the data is wrong** — check the field-level and visibility
findings. Count parity is the weakest possible evidence of a good migration.

**All timestamps are the import date** — stop. This is unrecoverable after
decommissioning. Re-run the import with timestamp preservation configured, which
on most platforms requires a specific flag or API field rather than being the
default.

**Author attribution is mostly unknown** — departed agents were not mapped. Decide
whether to create placeholder identities before completing the migration; it
cannot be fixed afterwards without another import.

**Internal notes are missing entirely** — verify in the target UI whether they were
dropped or imported as public replies. These are very different problems, and one
of them needs a customer-communications response.
