---
name: cx-outcome-validation
description: Use to test whether QA scores actually relate to outcomes the business cares about — repeats, CSAT, complaints, escalations — and to say honestly when the sample is too thin or the design cannot support a causal claim. Trigger for "do QA scores predict anything", "validate the scorecard", "correlate QA with CSAT", outcome validation, scorecard predictive validity, or leadership asking if the QA programme is worth running.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: analysis
---

# Outcome validation for QA scores

Leadership eventually asks whether the QA programme **predicts anything that
matters**. Without an answer, the scorecard is an expensive habit. With a dishonest
one — a correlation on forty evaluations, or CSAT treated as ground truth — it
becomes an expensive habit that also misdirects coaching.

This skill is about **linking scores to named outcomes**, **stating what the design
can and cannot show**, and **naming the traps** that make a positive-looking chart
worthless.

## Start with the outcome, not the score

Pick one or two outcomes the business already tracks and would act on:

| Outcome | What it captures | Usual caveats |
| --- | --- | --- |
| Repeat contact on same intent within N days | Did the issue actually resolve? | Intent matching; window choice; channel effects |
| CSAT / DSAT | Customer sentiment | Low response rate; survey timing; who responds |
| Escalation or reopen | Failure visible to the customer or supervisor | Policy changes what gets escalated |
| Formal complaint | Severe failure | Rare; long lag; not independent of handling |
| Compliance breach | Regulatory or contractual failure | Often binary and rare; may need census not sample |

The scorecard should have been built with these in mind. Validation reconnects the
instrument to them. If nobody can name an outcome, stop — there is nothing to validate
against.

## Assemble the analysis set

You need **evaluated conversations linked to downstream outcomes** on the same
population and time window.

- **Join on conversation id**, not on agent-month aggregates, unless the question is
  explicitly agent-level and you have enough agent-periods.
- **Align the outcome window** after the conversation ends — repeats need a defined
  look-forward; CSAT needs the survey timestamp, not the ticket close time alone.
- **Use the same frame** the sampler used. Evaluations drawn from a risk-weighted or
  disputed subset describe that subset's relationship to outcomes, not the whole
  population's.
- **Segment before pooling.** Channel, queue, language and tenure often reverse the
  sign of a relationship that looks clear in aggregate.

Report **N evaluated conversations with usable outcome data** before any statistic.
If N is small, say so and stop pretending precision exists.

## When the sample is too thin

There is no universal minimum, but several conditions make any correlation
uninterpretable:

- **Fewer than a few dozen evaluated conversations in a segment** — patterns may be
  real but intervals will be wide; do not rank criteria or agents on them.
- **Outcome events rarer than the evaluation count** — e.g. twelve complaints in six
  months across the whole programme. You can describe co-occurrence; you cannot
  estimate a stable relationship.
- **Most agents with one or two evaluations** — agent-level validation is not
  available; stay at conversation or team level.
- **Outcome measured on a different population** — CSAT surveyed on email only while
  QA covers chat; the join is empty or misleading.

When thin, deliver **directional evidence and explicit uncertainty**, not a verdict
that the scorecard "works" or "doesn't work".

## Analyse without invented thresholds

Do not declare success or failure against a made-up correlation cut-off. Report what
the data show:

- **Direction** — higher QA score associated with better, worse, or no clear
  relationship with the outcome, within each segment.
- **Strength qualitatively** — tight vs scattered; consistent across segments vs
  driven by one queue; robust to a simple control (channel, handle-time band) vs
  disappearing when controlled.
- **Which score components move with the outcome** — overall score often masks a
  single criterion doing the work, or a criterion that does not move outcomes at all.
- **Time stability** — relationship holds across two or more periods, or appears only
  in one month (often a mix shift or rubric change).

If you fit a model, show **intervals or a plain statement of uncertainty**, not a
single point estimate presented as truth. If leadership wants a yes/no, frame it as:
"On this sample, in this segment, the evidence is / is not strong enough to act."

## CSAT-specific caveats

CSAT is the outcome everyone reaches for and the one most likely to mislead.

- **Response bias** — angry and delighted customers respond disproportionately; silent
  majority is unknown.
- **Timing** — survey sent before resolution, or days later after unrelated contacts,
  breaks the link to the evaluated conversation.
- **Confounding with issue difficulty** — hard issues get lower CSAT independent of
  agent skill; QA may correctly flag weak handling on tickets that were doomed anyway.
- **Different construct** — QA measures adherence to standards; CSAT measures whether
  expectations were met. A scorecard can be valid and still correlate weakly with CSAT
  if standards and customer expectations diverge.

Treat CSAT as **one outcome among several**, never as proof the scorecard is wrong
because the correlation is flat.

## Reverse causation and other traps

A relationship in the data is not a recommendation to tighten the rubric.

| Trap | What it looks like | What to do |
| --- | --- | --- |
| Reverse causation | Low QA scores follow bad outcomes because reviewers only look at tickets that already failed | Fix selection; validate on a random or agent-equal core |
| Outcome-driven grading | Reviewers know the CSAT or escalation before scoring | Blind grading; separate outcome window strictly after evaluation |
| Rubric change mid-window | Relationship shifts when the scorecard version changes | Split by version; do not blend |
| Mix shift | Outcome rate moves because contact mix moved, not because QA stopped working | Decompose by stratum |
| Gaming | Agents optimise scored behaviours that do not move the outcome | Check criterion-level links; look for score up, outcome flat |
| Collider bias | Conditioning on "was evaluated" or "was disputed" opens spurious paths | Define who enters the analysis set upfront |

## Present results to the user

1. **The outcome(s) tested** and the look-forward or survey window used.
2. **Sample size** — evaluated conversations with usable outcome data, overall and by
   key segment, with an explicit thin-sample flag where applicable.
3. **Direction and qualitative strength** per outcome and segment — no invented
   cut-offs; intervals or plain uncertainty language.
4. **Criterion-level findings** — which scored behaviours track the outcome and which
   do not, when data allow.
5. **Design limits** — selection bias, CSAT caveats, reverse causation risks, rubric
   version splits, and anything that prevents a causal claim.
6. **Actionable conclusion** — what can be acted on now (drop a criterion, recalibrate,
   fix sampling, collect more data), and what must wait for a larger or cleaner sample.
