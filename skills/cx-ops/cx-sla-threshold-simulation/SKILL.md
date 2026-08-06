---
name: cx-sla-threshold-simulation
description: Use to model what a proposed SLA or response-time target would have delivered on historical data before committing to it, with correct handling of open tickets and business hours. Trigger for "what would our SLA attainment be at 2 hours", "what if we tightened the target", "should our P1 target be 2h or 4h", "% of tickets resolved within X", comparing thresholds, or setting a first-response or resolution target for the first time.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: analysis
---

# Simulating an SLA threshold

Someone proposes a two-hour target for P1 and wants to know whether it is
achievable. The tempting answer is to count how many past tickets closed inside two
hours. That number is almost always too optimistic, for a reason that has nothing to
do with the threshold: **the tickets that are still open are the slow ones, and
they have no resolution time to count.**

This skill produces a defensible answer, and is explicit about which part of the
question data can settle and which part it cannot.

## Build the clock once, then sweep

Threshold comparison is trivial arithmetic. All the difficulty is in defining the
elapsed time you are thresholding, so do that once, carefully, and then sweep as
many thresholds as anyone wants.

Four decisions define the clock. Write them down; every one of them changes the
answer by more than the threshold choice does:

**1. Which event ends the clock.** First response, first *human* response, first
public response, or resolution. These give wildly different distributions, and
"SLA" is used for all four. An internal note is not a customer-visible response —
decide whether it stops the clock and say so.

**2. Business hours or calendar hours.** A Friday-evening arrival is not eight
hours late on Saturday morning. Business-hours clocks need the schedule *and* the
holiday calendar; if you cannot get them, compute calendar hours and label the
result plainly, because a calendar-hours simulation will make any target look
unachievable for a team that does not work nights.

**3. Pause policy.** Time spent waiting on the customer, on a third party, or on a
hold status. Most published SLA figures deduct at least some of this. **This choice
usually moves attainment more than the threshold does** — deciding whether
awaiting-customer time counts can shift a figure by tens of points. If you are
reconciling against a number someone else produced, check the pause policy before
anything else.

**4. Which segment attribute, and as of when.** Priority gets reassigned mid-life.
Attainment measured on priority-at-creation and priority-at-resolution are different
numbers, and the second one flatters you, because tickets that turn out to be slow
often get re-prioritised. Declare which you used.

Then sweep:

```bash
node scripts/simulate-sla.mjs --input clocks.jsonl --thresholds 60,120,240,480 --by priority
```

Input is one record per conversation with its elapsed clock and whether it finished.
See [references/clock-and-censoring.md](references/clock-and-censoring.md) for the
input shape and the censoring arithmetic.

## Open tickets are the whole problem

An unresolved ticket is **censored**: you know its clock has already run for some
time, and not what its final time will be. Dropping censored tickets is the standard
mistake and it biases attainment upward, because slowness is exactly why they are
still open.

Handle them by their elapsed time rather than by throwing them away:

| Ticket state | Elapsed vs threshold T | Verdict |
| --- | --- | --- |
| Resolved | ≤ T | met |
| Resolved | > T | breach |
| Still open | > T | **breach** — already certain, no need to wait |
| Still open | ≤ T | **unknown** — could still make it |

That gives three numbers instead of one:

- **Lower bound** — every unknown breaches: `met / n`
- **Upper bound** — every unknown makes it: `(met + unknown) / n`
- **Attainment among decided** — `met / (met + breach)`, the defensible point
  estimate, with the unknown count reported beside it

**If the gap between the bounds is wide, the estimate is not usable yet.** That
happens when you simulate a tight threshold on a recent window — most tickets are
young and undecided. The fix is a window old enough that nearly everything has
resolved, not a cleverer estimator. Say this rather than reporting a precise-looking
number from a mostly-undecided sample.

## What the simulation can and cannot tell you

**It can tell you the mechanical answer:** given exactly the behaviour you had, this
is the attainment the proposed target would have recorded. That is genuinely useful,
and it is what people are asking for.

**It cannot tell you the achieved answer**, because a target changes behaviour. Once
a two-hour clock exists, work gets triaged toward it — and some of that is real
improvement and some is gaming: reclassifying priority, sending a holding reply to
stop the clock, closing and reopening. So treat the simulated figure as **the
pessimistic bound on attainment and the optimistic bound on how much has to
change.** Reality lands between, in a direction that depends on how gameable your
clock definition is.

Two things to say out loud whenever you present a simulated target:

- **Which stop-the-clock behaviours the definition rewards.** If a one-line "we're
  looking into it" satisfies the clock, the target will produce those, and first
  response will improve while resolution does not. Pair any response-time target
  with a resolution or quality measure, or you have bought a metric rather than an
  outcome.
- **Where the marginal tickets are.** The tickets that would newly breach are not
  spread evenly — they cluster by time of day, day of week, queue and channel. A
  target that fails only on Monday mornings is a staffing decision, not a target
  decision. Report the clustering, because it is what makes the target actionable.

## Choose the threshold on the distribution, not on a round number

Look at the elapsed-time distribution before proposing anything. Response-time
distributions are heavily right-skewed, so:

- **Report percentiles, not the mean.** The mean is dragged by the tail and describes
  nobody's experience. p50, p90 and p95 describe the actual service.
- **Look for the elbow.** Attainment as a function of threshold usually has a region
  where a small relaxation buys a lot of attainment. A target just below an elbow is
  expensive for no reason; just above one is cheap and looks generous.
- **Prefer a percentile-based target** ("90% within 4 business hours") to a mean.
  Averages let a fast majority hide an abandoned tail, which is the failure mode
  every customer actually notices.
- **Check the segments separately.** One priority or channel usually carries all the
  risk. A single organisation-wide target either overcommits on the hard segment or
  is trivial for the rest; per-segment targets are almost always the better answer
  and this analysis is how you show it.
- **Give the interval.** Attainment is a proportion, so a target chosen on one
  quarter of data carries sampling error. At n=200 the 95% interval on 90% is roughly
  ±4 points — enough that "we hit 90%" and "we hit 86%" are the same quarter.

## Traps

- **Reopens.** Does the clock restart, continue, or does the reopen become its own
  measurement? All three are defensible; leaving it undefined means the number is
  irreproducible.
- **Multiple SLAs on one ticket.** First response and resolution can pass and fail
  independently. Never collapse them into one attainment figure.
- **Tickets that never get a response at all.** These belong in the denominator as
  breaches. Excluding them because they have no response timestamp is the same
  survivorship error as excluding open tickets, and it is easy to do accidentally.
- **Spam and automated traffic in the denominator.** Exclude it — and report the
  exclusion rule and its size, because it is also the easiest way to make attainment
  look better than it is.
- **Comparing to a vendor-reported figure.** Helpdesk SLA modules apply their own
  pause and business-hours rules. Expect a gap and reconcile against the four clock
  decisions before assuming either number is wrong.

## Present results to the user

1. **The clock definition** — all four decisions, stated before any number.
2. **The distribution** — n, p50, p90, p95, and how much of the window is still
   undecided.
3. **The sweep table** — for each candidate threshold: attainment among decided,
   the lower and upper bounds, and the unknown count.
4. **Per segment**, for the segmentation that carries the risk.
5. **The cost of the proposal** — how many tickets would have to be handled faster,
   and when and where they cluster.
6. **Behaviour warning** — which stop-the-clock behaviours this definition rewards,
   and what to pair the target with.
7. **What would make this estimate firmer** — usually a longer settled window, the
   business-hours calendar, or a decided pause policy.
