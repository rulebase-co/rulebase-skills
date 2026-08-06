# Clock configuration and the conventions each option implies

## Complaint input

JSONL or a JSON array. One record per complaint — not per ticket.

```jsonl
{"id":"C-1041","received_at":"2026-07-01T14:20:00Z","identified_at":"2026-07-03T09:00:00Z","acknowledged_at":"2026-07-04T11:00:00Z","final_response_at":null,"market":"uk","owner":"a.patel","category":"payments"}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Complaint reference. |
| `received_at` | yes | When the complaint reached the firm — any channel, any team. |
| `identified_at` | no | When it was recognised as a complaint. Used to measure identification lag, **not** normally to start the clock. |
| `market` | no | Selects the holiday calendar. Falls back to `default`. |
| `owner` | no | Enables the unowned-case check. |
| anything else | no | Any field can satisfy a deadline or be used as a segmentation. |

One complaint per record. If your data has one row per ticket, collapse to the
complaint first — clocking each ticket separately understates age and inflates the case
count.

## Config

```json
{
  "timezone_offset_minutes": 0,
  "working_days": [1, 2, 3, 4, 5],
  "holidays": {
    "default": ["2026-12-25", "2026-12-26"],
    "uk": ["2026-08-31", "2026-12-25", "2026-12-28"]
  },
  "clock_start": "received_at",
  "count_from": "next_working_day",
  "allow_pauses": false,
  "deadlines": [
    {
      "name": "acknowledgement",
      "length": 5,
      "unit": "working_days",
      "from": "received_at",
      "satisfied_by": "acknowledged_at",
      "source": "<cite the rule or internal policy here>"
    },
    {
      "name": "final_response",
      "length": 8,
      "unit": "weeks",
      "from": "received_at",
      "satisfied_by": "final_response_at",
      "warn_at_days_remaining": 10,
      "source": "<cite the rule here>"
    }
  ]
}
```

**The `length` values above are placeholders.** They are not a claim about any
jurisdiction's rules. Deadline lengths vary by jurisdiction, sector, product and
complaint type, and they change. Source yours and record the source in the `source`
field — the script echoes it back into its output so a reader can check it.

## What each option means

**`working_days`** — ISO weekday numbers, Monday = 1. A six-day operation is `[1,2,3,4,5,6]`.

**`holidays`** — per market, as `YYYY-MM-DD`. A market with no entry uses `default`. A
multi-market operation with one shared holiday list will be wrong by days in every
market whose holidays differ, and wrong in the optimistic direction.

**`clock_start`** — which field the clock runs from. Normally `received_at`.

> Setting this to `identified_at` moves the clock to when you noticed. In most complaint
> regimes the clock starts when the complaint reaches the firm, not when it is
> recognised, so this setting will usually understate age. The script warns when it is
> used.

**`count_from`** — `next_working_day` (day one is the first working day after the start
event) or `same_day` (the start date itself counts as day one). A one-day systematic
difference on every case. Pick the one your rules specify.

**`allow_pauses`** — whether `pauses` on a complaint record are deducted.

> Default `false`, deliberately. Many complaint regimes do not permit the clock to stop
> while you wait for information from the customer, even though ordinary support SLAs
> do. Do not carry a pause rule over from your support SLA configuration. If your regime
> does allow pauses, they will have conditions, and the script's output labels any
> deducted time so a reviewer can see it.

**`unit`** — one of:

| Unit | Counting |
| --- | --- |
| `working_days` | Skips non-working days and holidays for that market |
| `calendar_days` | Every day counts |
| `weeks` | Calendar weeks (7 calendar days each) |
| `months` | Calendar months, clamped to month end — one month from 31 January is 28 or 29 February |

`weeks` and `months` are calendar-based even when `working_days` is set, because that is
how these deadlines are normally expressed. If your rule means "8 working weeks", express
it as `working_days` with the equivalent count rather than relying on an interpretation.

**`satisfied_by`** — the field whose presence closes the deadline. If the value is later
than the due date, the deadline breached. Note whether your rules require the response to
be *sent* or *received*; the script uses whatever timestamp you supply, and the
distinction matters for post.

**`warn_at_days_remaining`** — the lead time at which an open case enters the at-risk
bucket. Set it to the time your process actually needs to draft, review and approve a
response, not to a round number.

## Reading the output

Per complaint and deadline: `due_at`, `status`, and `remaining_days`.

| Status | Meaning |
| --- | --- |
| `met` | Satisfied on or before the due date |
| `breached` | Satisfied after the due date |
| `breached_open` | Not satisfied and the due date has passed — a certain breach |
| `at_risk` | Open, inside `warn_at_days_remaining` |
| `open` | Open, with time remaining |

`breached_open` and `breached` are both breaches; they are separated because the first
is still actionable today.

The summary carries absolute counts as well as rates. **Quote the counts.** Complaint
volumes are low enough that a percentage hides a single breach that matters.

`identification_lag_days` is reported per complaint and as a distribution. Cases where
the lag alone consumed a material share of a deadline are listed explicitly — these are
where hidden breaches concentrate, and they are a training and intake finding rather
than a complaints-team one.

## What the script does not do

- **It does not know your deadlines.** Configuration only.
- **It does not determine whether a breach is reportable.** That is a compliance and
  legal determination, and it may start a separate notification clock.
- **It does not handle DST-crossing precisely.** Business-day arithmetic operates on
  calendar dates in a fixed offset. For deadlines measured in days this is immaterial; if
  you need hour-precision deadlines across a DST boundary, compute the boundary upstream.
- **It cannot see complaints that are not in the input.** Reviews, social posts, letters
  and regulator portals are frequently outside the helpdesk. Their absence is not
  compliance.
