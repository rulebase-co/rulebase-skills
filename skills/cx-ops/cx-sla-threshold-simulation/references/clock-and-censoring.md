# Input shape and the censoring arithmetic

## Input

JSONL (one object per line) or a JSON array. One record per conversation.

```jsonl
{"id":"1001","elapsed_minutes":83,"resolved":true,"priority":"P1","channel":"email"}
{"id":"1002","elapsed_minutes":412,"resolved":true,"priority":"P1","channel":"voice"}
{"id":"1003","elapsed_minutes":45,"resolved":false,"priority":"P1","channel":"chat"}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Conversation identifier, for citing the marginal tickets back. |
| `elapsed_minutes` | yes | The clock. Time to the stopping event if `resolved`, otherwise time elapsed so far. |
| `resolved` | yes | Whether the stopping event has happened. `false` means censored. |
| anything else | no | Any additional field can be used as a segmentation via `--by <field>`. |

`elapsed_minutes` must already be in the units your clock definition implies. The
script does no business-hours conversion — it cannot, because it does not have your
schedule. Compute business-hours elapsed upstream and pass the result, or pass
calendar minutes and label the output as calendar hours.

Excluding spam and automated traffic also happens upstream. Report the exclusion rule
and how many records it removed.

## Why censoring is the whole problem

Unresolved tickets are **right-censored**: the clock is still running. They are also
not a random sample — a ticket is still open substantially *because* it is slow. So
the two obvious approaches are both wrong:

- **Dropping them** biases attainment upward, often by a lot on a recent window.
- **Treating elapsed-so-far as the final time** biases it upward too, since every
  censored ticket's true time is at least its current elapsed and usually more.

## The classification

For threshold `T`:

```
resolved && elapsed <= T   ->  met
resolved && elapsed >  T   ->  breach
!resolved && elapsed >  T  ->  breach      (certain: it has already blown T)
!resolved && elapsed <= T  ->  unknown     (might still make it)
```

The third row is the one people miss. An open ticket that has already run past the
threshold is a **definite** breach — you do not need to know when it eventually
closes to know it missed. Counting these correctly recovers most of the bias without
any modelling.

Only the fourth row is genuinely unknown, and it is bounded:

```
lower bound        = met / n                 every unknown breaches
upper bound        = (met + unknown) / n     every unknown makes it
among decided      = met / (met + breach)    the point estimate
```

Report all three. When `unknown / n` is large the bounds are far apart and the honest
statement is that the window is too recent to answer the question.

## Reading the output

`attainmentDecided` is the number to quote, with `unknown` beside it. The bounds tell
the reader how much the unknowns could move it. If `lower` and `upper` differ by more
than a couple of points, lead with that rather than with the point estimate.

`marginal` lists the conversation ids that breached at each threshold, capped for
readability. These are the tickets to look at when asking *why* the target would have
failed — and their clustering by hour, weekday and queue is usually the real finding.

## Choosing the window

Two competing pressures:

- **Long enough that most tickets are decided.** Simulating a 4-hour target on last
  week's data leaves most of the week undecided and the bounds useless.
- **Recent enough to reflect current operations.** A window spanning a
  reorganisation, a channel launch or a major staffing change is measuring a team
  that no longer exists.

A practical rule: the window should extend back far enough that the censored share
is small — under a few percent — while ending recently enough that nothing
structural has changed inside it. If those two cannot both hold, say so and report
the sensitivity rather than picking one silently.

## What this does not model

- **Behaviour change.** The simulation applies a new threshold to old behaviour. It
  is the pessimistic bound on attainment and the optimistic bound on required
  change.
- **Business hours.** Handled upstream, deliberately.
- **Queue dynamics.** Tightening a target on one queue moves capacity and changes
  the others. Nothing here captures that; a staffing model does.
- **Reopens.** Whatever your reopen policy is, it has to be resolved before the
  clock is computed. The script sees one number per conversation.
