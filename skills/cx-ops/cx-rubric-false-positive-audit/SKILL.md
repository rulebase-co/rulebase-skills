---
name: cx-rubric-false-positive-audit
description: Use when a QA team says the scorecard is too harsh or produces too many false positives, to find which criteria are actually misfiring and fix those rather than lowering the bar everywhere. Trigger for "our evaluation scores keep tanking", "there are too many false positives", "how can we be more lenient", "what exceptions do I need to add to the scorecard", agents disputing evaluations, or a scorecard nobody trusts any more.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: playbook
---

# Auditing a rubric for false positives

The request usually arrives as "the scores keep dropping, there are too many false
positives, how do we make it more lenient". Underneath it is a real and serious
problem — a QA programme the team has stopped believing — and a proposed remedy that
would make it worse.

**Global leniency destroys the instrument.** Relaxing thresholds until the number looks
acceptable does not remove the false positives; it adds false negatives on top of
them, so the scorecard now misses real failures *and* still flags things that were
fine. The complaint does not go away, it just stops being measurable.

The right move is narrower: a false positive is a specific, checkable claim — the
rubric flagged something that was not actually a failure. Find them, work out why each
one happened, and fix the cause.

## Step 1: assemble the candidate set, from two places

The disputed evaluations are the obvious source and they are **selection-biased**:
they are the ones someone had the energy to contest. Use them, but not alone.

- **Disputed and contested evaluations** — high yield, biased toward vocal agents and
  toward criteria that feel unfair rather than criteria that are wrong.
- **A random sample of low-scoring and auto-failed evaluations that nobody contested.**
  This is the set that matters. Silent false positives are the ones quietly eroding
  trust, and they are invisible in dispute data by definition.

Sample both, and report the two rates separately. If the false-positive rate among
uncontested low scores is similar to the contested rate, the problem is systemic; if it
is much lower, the disputes are concentrated in a few criteria or a few people, which
is a different and easier problem.

## Step 2: adjudicate against policy, not against feeling

For each candidate, decide whether the flag was correct — by reference to documented
policy and the rubric's own stated test, not by whether the outcome feels harsh.

Read the conversation. Do not adjudicate from the evaluation summary; the summary is
the thing under audit.

## Step 3: classify the cause

This is the analytical core. Every false positive has one of five causes, and they
have **five different fixes**. Lumping them together is what produces the "just be
more lenient" request in the first place.

**1. Not observable in the medium.** The criterion cannot be assessed from what the
grader can see. Tone from a transcript with speech-recognition errors; "checked the
account" when the check happened in another system and left no trace in the
conversation; brevity penalised in a channel where brevity is correct.
*Fix: scope the criterion to the channels where it is assessable, or change what it
tests to something observable.* Not a leniency change.

**2. Wrong work type.** A two-turn password reset judged on discovery and probing. A
back-office task judged on customer empathy.
*Fix: scorecard scoping and conditions, so the criterion only applies where it makes
sense.* Frequently the single largest bucket, and it is invisible in aggregate scores
because it shows up as a general downward drag.

**3. Missing exception.** The behaviour being penalised was the correct behaviour in
this scenario, and the rubric does not know the scenario exists.
*Fix: add the exception, with the scenario named and a policy citation.*

**4. Grader threshold drift.** The criterion is fine and the grader — human or model —
is applying it more harshly than intended, or than they did last quarter.
*Fix: recalibration. Do not touch the rubric.* Look for a marginal-rate gap between
graders, or a step change in a criterion's fail rate that coincides with a new reviewer
or a model version change.

**5. Not a false positive.** The flag was correct and the team disagrees with the
standard.
*Fix: none available to you. This is a policy decision for whoever owns the standard.*

**Telling 3 apart from 5 is the whole job.** The test is documentary: does policy or
the knowledge base support what the agent did? If yes, it is a missing exception. If
no, the team is asking to lower the standard — which may be a perfectly reasonable
business decision, but it must be made explicitly by the person who owns it, not
absorbed quietly into a rubric edit. Say which one you found, and never relabel a 5 as
a 3 because the request came in as one.

## Step 4: check for the causes that look like harshness but are not

Before recommending any rubric change, rule out three things that produce a falling
score with no change in either the rubric or the team:

- **Mix shift.** Volume moving toward a structurally harder channel or queue drags the
  aggregate down while every segment holds steady. Decompose the movement before
  attributing it to the rubric.
- **Coverage shift.** If which conversations get evaluated changed, the score moves
  with no change in performance. Compare evaluated composition against eligible
  composition.
- **A rubric or scorecard change that already happened.** Check the version history
  first. A criterion added or re-weighted three weeks before the complaints started is
  the answer, and it is embarrassing to find it after a full audit.

## Step 5: quantify each fix before making it

For every proposed change, estimate the effect on a **frozen historical sample** before
shipping:

- How many evaluations in the window would have changed verdict?
- What would the aggregate score have been?
- Does it introduce false negatives? Test the change against a set of known-real
  failures and confirm they still fail. **A leniency change that lets real failures
  through is worse than the problem it solves**, and this is the check nobody runs.

Report the expected score shift, because the series will step and everyone will ask.

## Step 6: version and announce

Any rubric change breaks comparability. Bump the scorecard version, record the date,
and state plainly which historical periods are no longer comparable. A quiet edit turns
the next quarter's trend into fiction, and the trust problem you were hired to fix
comes back worse — now with the added complaint that the numbers change without notice.

Re-measure grader agreement on a fixed gold set after the change. A rewritten criterion
can be clearer *and* less reliable; you do not know until you look.

## What "more lenient" must never mean

- **Removing or softening auto-fails on compliance criteria.** These exist because
  rarity is the point. If they fire too often, the process is failing, not the rubric.
- **Capping the number of flags per evaluation.** This hides failures rather than
  correcting judgements and makes the data uninterpretable.
- **Raising thresholds without evidence per criterion.** That is the global leniency
  this skill exists to prevent.
- **Instructing graders to be kinder.** Unmeasurable, undocumented, and it decays.

If someone insists on a global relaxation after seeing the analysis, that is their call
to make — say clearly what it costs (false negatives, a broken series, no diagnosis of
the actual causes), record that the recommendation differed, and implement it as a
versioned, announced change rather than a quiet one.

## Present results to the user

1. **The two false-positive rates** — among disputed, and among uncontested low scores
   — with sample sizes and intervals. This frames everything else.
2. **Causes ranked by volume**, using the five-way classification, with example ids
   under each.
3. **What is not a rubric problem** — mix shift, coverage shift, grader drift, or a
   rubric change that already happened — with the evidence.
4. **Specific fixes per criterion**, mapped to the cause, with the estimated effect on
   the historical sample and the false-negative check result.
5. **The items that are not false positives**, named as a standards decision with an
   owner, and not folded into the fix list.
6. **Version and comparability impact** — expected score shift and which periods stop
   being comparable.
7. **What you could not adjudicate**, and why.
