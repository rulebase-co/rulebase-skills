---
name: cx-shrinkage-and-adherence
description: Use to turn a staffing requirement into a workable schedule and to diagnose why a correctly-forecast plan still misses service levels — shrinkage, intraday fit, adherence and occupancy. Trigger for "we staffed to the forecast and still missed SLA", "what shrinkage should we use", "schedule adherence", intraday staffing gaps, agents available but service level missing, or building a roster from a forecast.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: playbook
---

# Shrinkage, schedules and adherence

A forecast tells you how many agents you need on the phones. A schedule is how many
people you employ, which shift they work, and whether they are actually there at the
moment demand arrives.

**Most service-level misses are not forecast errors.** The forecast was fine; the plan
lost the volume between "required" and "actually available at 10:15 on Monday". This
skill is about that gap, and it has three parts: shrinkage, intraday fit, and
adherence.

## Shrinkage is where plans die

Shrinkage is the share of paid time not available for handling contacts. It is
routinely underestimated because people count only the obvious parts.

Count all of it, and count it in two layers:

**Planned** — holiday, training, team meetings, coaching sessions, project work, breaks
where they are not counted separately.

**Unplanned** — sickness, lateness, unexplained absence, system outages, and time lost
to tooling failures.

Two rules that matter more than the exact number:

- **Measure your own shrinkage from your own data. Do not import a benchmark.** It
  varies enormously by operation, and a wrong assumption here dwarfs any refinement in
  the forecast.
- **Shrinkage is not flat.** It concentrates: holidays cluster in seasons, sickness
  peaks on Mondays and in winter, training is scheduled in blocks, and meetings sit at
  the same time every week — often at a daily volume peak. **Apply shrinkage by
  interval, not as a single annual percentage.** A flat assumption is right on average
  and wrong exactly when it matters.

Compounding is easy to get wrong. If you need `N` agents on the phones and total
shrinkage is `s`, you need `N / (1 − s)` scheduled — not `N × (1 + s)`. At 30%
shrinkage the difference is about six percentage points of staffing, which is a real
service-level gap.

## Intraday fit, not daily totals

A day can be perfectly staffed in aggregate and badly staffed all day. Demand moves by
half-hour; shifts do not. The consequences are structural:

- **Shift boundaries and lunch cover** create predictable troughs. The midday dip is
  usually the worst service interval of the day and it is entirely self-inflicted.
- **Staffing to the daily average guarantees a morning shortfall and an afternoon
  surplus**, and the shortfall costs far more than the surplus saves, because queues
  are non-linear — service level degrades much faster past the point of saturation than
  it improves before it.
- **Compare required against scheduled per interval**, and report the gap profile. The
  total tells you almost nothing.

For asynchronous channels the intraday constraint is looser — work can be deferred —
but not absent, since response-time targets still have a clock. Model email and
messaging against the target, not against arrival.

## Adherence and occupancy: two different things

**Adherence** — was the agent doing what the schedule said, when it said. It is a
schedule-integrity measure.

**Occupancy** — what share of available time was spent handling contacts.

They are frequently confused, and the confusion causes real harm:

- **Occupancy is not a productivity target.** It is an *outcome* of volume and staffing.
  Driving it up produces burnout and attrition, and sustained high occupancy is a
  leading indicator of the attrition that will wreck next quarter's plan. Treat it as a
  constraint with a ceiling, not a number to maximise.
- **Low occupancy with a missed service level means the staffing is in the wrong
  intervals**, not that people are idle. This is the most useful diagnostic pair in the
  whole discipline, and it points straight at the schedule.
- **Adherence targets above the low nineties are usually counterproductive** — they
  punish agents for finishing a contact that ran past the end of their scheduled state,
  which is exactly the behaviour you want.

Measure adherence at a sensible granularity with a tolerance window. Minute-level
adherence with no tolerance measures clock-watching.

## Diagnosing "we staffed to plan and still missed"

Work through these in order; each is a different owner:

1. **Was the forecast right?** Compare actual to forecast volume and handle time
   separately. A handle-time miss is as damaging as a volume miss and gets checked far
   less often.
2. **Was the requirement right?** Check the assumptions in the staffing calculation —
   particularly whether the arrival pattern and patience assumptions hold.
3. **Was shrinkage right, in that interval?** Usually the answer. Compare planned
   against actual shrinkage by interval.
4. **Was the schedule fitted to the interval profile**, or to the daily total?
5. **Was adherence what was assumed?**
6. **Were people available but not skilled for the demand that arrived?** A skills
   mismatch looks exactly like understaffing in aggregate reporting and is invisible
   without a skill-level view.

Report which of the six it was. "We missed service level" with no decomposition
produces the same conversation every month.

## Traps

- **Averaging occupancy across a day** hides both the saturated peak and the idle
  trough.
- **Multi-skilling is not free capacity.** An agent who can handle two queues cannot
  handle both at once, and reserving them for the rarer skill costs availability on the
  common one.
- **Chat concurrency is a lever with a quality cost.** Raising it looks like free
  capacity in the model and shows up later as handle time, quality and repeat contact.
  Never change concurrency in a plan without measuring the quality effect.
- **Shrinkage measured on the wrong denominator.** Be explicit about whether it is a
  share of paid hours, contracted hours, or scheduled hours; the three differ
  materially.
- **Ignoring attrition and ramp.** A plan requiring headcount you have not hired, or
  that counts a new hire at full productivity, is not a plan. Tenure mix belongs in the
  capacity calculation.

## Present results to the user

1. **Measured shrinkage**, planned and unplanned, by interval — not a single number.
2. **Required versus scheduled by interval**, with the gap profile, before any daily
   total.
3. **The compounding check** — that requirement was divided by `(1 − s)`, not multiplied.
4. **Adherence and occupancy as separate measures**, with occupancy framed as a
   constraint.
5. **The diagnosis**, naming which of the six causes explains a miss, with evidence.
6. **The structural fixes** — shift boundaries, break placement, meeting scheduling
   away from peaks — separated from the behavioural ones.
7. **Assumptions that could not be verified**, and what data would settle them.
