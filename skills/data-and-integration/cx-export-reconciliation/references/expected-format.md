# The expected-counts file

## Shape

```json
{
  "source": "zendesk",
  "window": { "from": "2026-07-01", "to": "2026-07-31" },
  "total_conversations": 12480,
  "total_messages": 51203,
  "by_segment": {
    "field": "channel",
    "counts": { "email": 8100, "chat": 3200, "voice": 1180 }
  },
  "holidays": ["2026-07-04"],
  "source_count_method": "Zendesk Explore: tickets created in July 2026, all statuses",
  "expect_messages": true,
  "min_population": { "subject": 0.9, "customer_id": 0.95 }
}
```

Every field is optional except `window`. The script reports what it could not check rather
than failing, so a partial expectations file still produces a useful reconciliation — it just
produces a weaker completeness claim, and it says so.

| Field | Purpose |
| --- | --- |
| `window.from` / `window.to` | Inclusive date bounds. Records outside are flagged. |
| `total_conversations` | The source's own count. Without it, completeness is unproven. |
| `total_messages` | Same, for messages. |
| `by_segment.field` | A canonical field to segment on — `channel`, `status`, `team_id`. |
| `by_segment.counts` | The source's count per segment value. Catches a permission scope. |
| `holidays` | Dates where zero volume is expected, so holidays aren't reported as gaps. |
| `source_count_method` | How the count was obtained. Echoed into the output so a reader can check it. |
| `expect_messages` | `false` for voice-only sources, where conversations legitimately have none. |
| `min_population` | Per-field population floors. Catches an extract that skipped hydration. |

## Getting the source count

The count has to come from the platform, not from another export. Options, best first:

1. **The platform's own reporting view** for an equivalent filter.
2. **A `total_count` or `count` field** in a list response.
3. **The UI's result count** for the same filter, read off the screen.

**Record how you got it in `source_count_method`.** When a reconciliation is short by 3%, the
first question is whether the two sides are counting the same thing, and this field is the
answer.

## Definition mismatches are the usual cause of a small gap

Before concluding data is missing, check that both sides count the same population:

- **The date field.** The platform may count by creation date while your export filtered on
  modification date. These differ by a lot at window edges.
- **The status set.** Several platforms default their list endpoints to open or active records
  only, and their reporting views to all.
- **Spam, deleted, merged and archived** records, included on one side and not the other.
- **Timezone.** A day-boundary difference between the platform's reporting timezone and your
  window shifts records in and out at both edges.
- **Automation-created records**, which some reporting views exclude.

A 1–3% gap is very often one of these. A 20% gap is usually a scope or a cap.

## Reading the output

`verdict` is one of:

| Verdict | Meaning |
| --- | --- |
| `reconciled` | Every check with an expectation passed. |
| `reconciled_with_gaps` | Soft checks flagged something, no hard check failed. |
| `not_reconciled` | A hard check failed — a count mismatch beyond tolerance, duplicates, or out-of-window records. |
| `unverified` | No source count was supplied, so only internal consistency was checked. |

**`unverified` is not a pass.** It means the export is internally consistent and its
completeness is unknown. Carry it forward into anything built on the data.

`gaps.zeroDays` and `gaps.lowDays` are the actionable output: the specific dates to re-run.
`segmentGaps` names the segment and the shortfall, which is usually where a permission scope
shows up.

## Tolerance

`--tolerance` sets the acceptable relative difference on count checks, defaulting to 0. Raise
it deliberately and state why — a source count taken an hour after the export legitimately
differs by whatever arrived in between, and on a busy account that is a real number.

Do not raise the tolerance to make a reconciliation pass. If the gap is a definition
difference, fix the definition; if it is missing data, re-run.
