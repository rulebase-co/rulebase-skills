---
name: cx-metric-movement-decomposition
description: Use to explain why a CX metric moved between two periods — QA score, CSAT, SLA attainment, containment, AHT — separating a genuine change in performance from a change in what got measured. Trigger for "why did our QA score drop", "what's driving the increase", "our score fell from the 90s to the low 80s, why", "key drivers behind this trend", "why has the critical error rate fallen this week", or any period-over-period comparison that needs a cause.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: analysis
---

# Why the metric moved

Someone asks why the QA score dropped four points. The usual answer names the
lowest-scoring team and stops. That answer is wrong more often than it is right,
because an aggregate rate can move for four unrelated reasons and only one of them
is "performance changed".

## The four channels

For an aggregate `R = Σ wᵢ·rᵢ` over segments `i`, where `wᵢ` is the segment's share
of volume and `rᵢ` its rate:

1. **Rate change** — segments performed differently. The only channel most people
   look for.
2. **Mix change** — segment shares moved. Every segment can improve while the
   total falls, because volume shifted toward a structurally harder one. This is
   Simpson's paradox and it is common in CX, where channels and queues have very
   different baselines.
3. **Coverage change** — for any sampled metric, *which* items got measured
   changed. A QA score is computed on the sample, so if this period's sample leans
   toward chat and last period's leaned toward voice, the score moves with no
   change in performance and no change in real volume mix.
4. **Composition change** — segments entered or left. New hires, a new market, a
   BPO site onboarding or offboarding. These have no prior-period rate, so they
   cannot appear in a rate-change term at all, and naive decompositions silently
   drop them.

**Noise is the fifth answer, and it is the most likely one.** Check it first.

## Step 1: is the movement real?

Do this before any decomposition. Most "why did the score drop two points"
questions have the answer "it didn't".

For a rate on independent observations, the standard error of the difference is
approximately:

```
SE(ΔR) = sqrt( p₀(1−p₀)/N₀ + p₁(1−p₁)/N₁ )
```

and the movement is within noise if `|ΔR| < 1.96 × SE(ΔR)`.

For a mean rather than a proportion, use `sqrt(s₀²/N₀ + s₁²/N₁)` with the
per-period standard deviations.

If the movement is inside the interval, **say that, stop, and do not decompose**.
Producing a driver narrative for noise trains the reader to act on randomness, and
they will keep asking, because a noise series always has something to explain.

Two caveats worth stating rather than hiding:

- **Evaluations of the same agent are not fully independent**, so the true interval
  is wider than the formula gives. Treat a borderline result as noise.
- **If the same question is asked every week**, roughly one week in twenty clears a
  95% threshold by chance. Weekly significance flags need a wider threshold or an
  explicit "for looking at, not acting on" label.

## Step 2: decompose

Use the symmetric decomposition. It splits `ΔR` exactly into two terms with no
residual and no arbitrary choice of base period:

```
rate effect  = Σ  ((w₀ᵢ + w₁ᵢ)/2) · (r₁ᵢ − r₀ᵢ)
mix effect   = Σ  (w₁ᵢ − w₀ᵢ) · ((r₀ᵢ + r₁ᵢ)/2)
rate + mix   = ΔR                                  exactly
```

The alternative — weighting rate effects at base-period shares and carrying an
interaction term — is also exact, but nobody can interpret the interaction term,
and its size depends on which period you called the base. Prefer the symmetric
form and avoid the conversation.

Segments present in only one period are handled separately, never folded in:
report their contribution as `w₁ᵢ·r₁ᵢ` for entrants and `−w₀ᵢ·r₀ᵢ` for exits, and
name them.

Run it with the script:

```bash
node scripts/decompose.mjs --input segments.json --metric rate
```

Input is one record per segment per period. See
[references/input-format.md](references/input-format.md) for the shape and a
worked example, and for how to pick the segmentation.

## Step 3: check coverage before believing the answer

This is the step that gets skipped, and it is the one that most often changes the
conclusion for QA metrics.

Compare the **composition of what was measured** against the composition of what
was *eligible to be measured*, in both periods:

- If the evaluated mix shifted but the eligible mix did not, the movement is a
  sampling artefact. The correct finding is "we audited a different mix", not
  "quality changed".
- If sampling is meant to be random and the two compositions differ materially,
  the sampler is not doing what people believe. That is a finding in itself and it
  invalidates every historical comparison, not just this one.
- **Coverage rate itself moving is a red flag.** If you evaluated 8% of volume last
  period and 3% this period, the score is being computed on a much smaller and
  possibly non-comparable sample. Report the coverage rate next to the score,
  always.

The same logic applies to CSAT: response rate changing is a composition change in
who answered, and it moves the score without anyone's service changing.

## Step 4: name the cause, at the right grain

Only now go looking for *why* the rate moved inside the segments that actually
drove it. Rank segments by **contribution to the movement** (`share × rate
change`), not by their rate. The worst-performing team is usually not the one that
moved the number; a large segment moving slightly beats a small one collapsing.

For each of the top contributors, look for a mechanism and say how confident you
are:

- A rubric or scorecard change, a new criterion, or a re-weighting. **Check this
  first** — an instrument change looks exactly like a performance change and is far
  more common than people expect.
- A grader or calibration change: new reviewers, a calibration session, a
  leniency drift. Check whether AI and human-reviewed subsets moved together.
- A process, policy, staffing or tooling change with a date. A metric that steps
  on a specific day usually has a cause with the same date; a metric that drifts
  usually does not.
- A data change: an integration that started or stopped syncing, a backfill
  landing, a channel newly connected.

An honest "the movement is real and concentrated in these two segments; we could
not identify a mechanism" is a better deliverable than a plausible story. Say which
mechanisms you ruled out.

## Traps

- **Ranking by rate instead of contribution.** The default mistake.
- **Averaging the averages.** `mean(segment means)` is not the overall mean unless
  segments are the same size. Always weight by volume.
- **Reporting a percentage-point change as a percentage change.** 90% → 85% is a
  five-point fall, not a 5% fall, and definitely not "a 5.6% decline" unless you
  mean relative and say so.
- **Decomposing a mean and a rate the same way.** A mean score and a pass rate can
  move in opposite directions; a rubric change that shifts borderline cases across
  a threshold moves the rate a lot and the mean barely at all. Decompose the metric
  people are actually arguing about, and if they disagree, that is the finding.
- **Segmenting on something that changed definition.** If teams were reorganised
  between the periods, the segments are not the same segments. Say so; do not
  present it as mix.
- **One segmentation only.** Channel, team, queue, tenure, and market can each be
  the whole story. Run the decomposition on each independently rather than
  crossing them into cells too small to read.

## Present results to the user

1. **Is it real** — the movement, the noise interval, and the verdict. If it is
   noise, this is the whole answer.
2. **Headline split** — how much of the movement is rate versus mix versus
   entrants and exits, in the metric's own units.
3. **Coverage check** — evaluated mix versus eligible mix, and the coverage rate
   in both periods.
4. **Top contributing segments**, ranked by contribution with the denominator
   shown, and the direction each pushed.
5. **Mechanism**, with confidence, and the alternatives ruled out.
6. **What this does not tell you** — segmentations not run, cells suppressed for
   size, and whether any instrument change makes the periods non-comparable.
