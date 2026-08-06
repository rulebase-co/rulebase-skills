---
name: cx-ai-grader-validation
description: Use to validate an AI QA grader against human reviewers before trusting it for triage or release decisions — agreement by segment, systematic bias, and where automation can replace humans versus where it cannot. Trigger for "can we trust the AI grader", "how accurate is our automated QA", "validate the grader before rollout", "AI vs human agreement by channel or language", "is the grader too harsh on chat", or checking a grader after a model change.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: analysis
---

# Validating an AI grader against humans

Teams ship AI graders on aggregate agreement: "87% match with humans." That number
hides the segments where the grader is wrong often enough to be dangerous, and it
conflates **triage** (ranking or flagging for review) with **replacement** (letting
the AI verdict stand without a human).

Validation is not a one-time score. It is a segmented measurement of **where the
grader agrees, where it disagrees systematically, and what each kind of error costs
you.**

## Separate calibration from production agreement

**Calibration** — the same fixed set of conversations, graded independently by
humans and by the AI grader. This is the only fair comparison when you change the
grader's model or prompt.

**Production agreement** — comparing the AI's verdict to the human review that
happened in the workflow. Cheap, but **selection-biased**: humans often only see what
the AI flagged, or only disputed cases. A production agreement number is not a
calibration result unless you state how items entered the sample.

Run calibration before trusting the grader for anything consequential. Use production
agreement to monitor drift, not to claim initial validity.

## Measure agreement by segment, not only in aggregate

Overall agreement is a headline, not a decision. Slice at least:

| Segment | Why it matters |
| --- | --- |
| Language | Model capability and rubric translation vary |
| Channel | Chat vs email vs voice transcript — different failure modes |
| Contact driver / topic | Regulated or high-stakes topics need stricter gates |
| Verdict type | Pass/fail vs ordinal partial — different error costs |
| Conversation length | Long threads expose completeness failures |

**A grader that is excellent in English email and poor in Spanish chat is two
graders.** Report both; do not average them into a single "ready" verdict.

For statistics on skewed pass rates, report raw agreement, marginal pass rates, and
both Cohen's κ and Gwet's AC1. When prevalence is extreme, κ can look worse than
chance while AC1 is high — that pattern is a finding about the criterion, not proof
the grader is broken. **Never cite a universal κ cutoff** (e.g. "κ > 0.6 means good")
as industry truth. Thresholds depend on **your error costs**, not a textbook.

## Diagnose noise versus bias

Two graders can disagree in opposite ways:

- **Noise** — unpredictable disagreement in both directions. The rubric or examples
  are ambiguous. Fix the criterion.
- **Bias** — one side is consistently harsher or more lenient. They may rank cases
  similarly but disagree on every pass/fail line. Fix the threshold or adjudicate.

Plot **disagreement direction**: when humans pass and AI fails vs when AI passes and
humans fail. Asymmetric patterns are bias. Symmetric scatter is noise.

For ordinal scales, treat adjacent disagreements (partial vs met) separately from
cross-scale failures (not met vs met). Unweighted agreement treats them the same;
your operational cost does not.

## Choose thresholds from your costs, not from folklore

There is no universal "good enough" agreement. Derive a threshold from **what happens
when the grader is wrong**:

| Error type | Question to answer |
| --- | --- |
| False fail (AI fails, human would pass) | Coaching load, morale, wasted review time |
| False pass (AI passes, human would fail) | Customer harm, compliance exposure, repeat contact |
| Wrong rank (triage) | Did the worst conversations still surface? |

Work through a concrete scenario: "If we auto-pass everything the grader passes, how
many customer-harming misses per thousand reviews is acceptable?" and "If we auto-fail
everything the grader fails, how much human rework is that?" **Your acceptable
agreement in regulated topics should be stricter than in low-stakes how-to**, even
with the same κ.

If you cannot articulate the cost, you are not ready to automate the verdict — only
to use the grader as a **sort key** for human review.

## Triage versus replace

| Mode | What the grader does | Validation bar |
| --- | --- | --- |
| **Triage** | Scores or ranks; humans review a subset or disputes | Miss rate on worst decile matters more than overall agreement |
| **Advisory** | Suggests a verdict; human always decides | Bias direction matters — systematic harshness erodes trust |
| **Replace** | Verdict stands unless appealed | Segment-level agreement near human parity; false-pass rate near zero on high-stakes criteria |

**Never promote from triage to replace on aggregate agreement alone.** Require
segment tables, a false-pass audit on stratified samples, and a plan for appeals.

Re-validate when the grader's model, prompt, rubric, or the human standard changes.
A grader validated in January is unvalidated after a rubric rewrite in March.

## Traps

- **Same model grading its own stack** — shared blind spots. Validate against humans
  on held-out conversations the grader did not train on.
- **Eval set leakage** — if calibration cases appear in grader prompts or few-shot
  examples, agreement is meaningless.
- **Single-number dashboards** — "92% agreement" with n=40 in one language is not
  evidence for global rollout.
- **Confusing consistency with correctness** — a harsh grader can agree with a harsh
  human while both are wrong against policy.

## Present results to the user

1. **Purpose and mode** — triage, advisory, or replace; which decisions the grader
   will drive.
2. **Calibration design** — set size, how drawn, languages, channels, and whether items
   were held out from grader development.
3. **Agreement table by segment** — raw agreement, marginals, κ and AC1 (or weighted
   ordinal measure), with n per cell. Flag cells with too few cases to conclude.
4. **Bias diagnosis** — false-pass vs false-fail rates overall and by segment;
   noise vs bias call.
5. **Threshold recommendation** — derived from stated error costs, not from generic
   cutoffs; explicit go/no-go per segment and mode.
6. **Triage vs replace verdict** — what the grader may automate today and what still
   requires human verdict.
7. **Re-validation triggers** — model, prompt, rubric, or population changes that
   void the current validation.
