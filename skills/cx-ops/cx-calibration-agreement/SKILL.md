---
name: cx-calibration-agreement
description: Use to measure and diagnose grader agreement in support QA — human vs human, or an AI grader vs human reviewers — separating random disagreement from one grader being systematically harsher. Trigger for "run a calibration", "how do our reviewers compare", "is the AI grading too harshly", "our QA scores have too many false positives", "why do reviewers disagree", contested or overturned evaluations, or checking a new grader or model version.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: analysis
---

# Grader agreement and calibration

Two graders can disagree in two completely different ways, and the fixes are
opposites:

- **Noise** — they disagree unpredictably, in both directions. The criterion is
  ambiguous. Fix the criterion.
- **Bias** — one is consistently harsher. They may agree on the ranking of every
  interaction while disagreeing on every verdict. Fix the threshold, or adjudicate.

Almost every "the AI is grading too harshly" and "we have too many false positives"
complaint is a bias finding being treated as a noise problem, or the reverse. This
skill tells them apart, and it does so with statistics that survive the extreme pass
rates real QA data has.

## First, which question is this?

**Calibration** — graders independently score a designed gold set. Clean, causal,
comparable over time, and the only way to measure a *criterion*. This is the
measurement instrument.

**Agreement in the wild** — comparing an AI verdict to the human review it received
in production. Cheap, plentiful, and **selection-biased**, because reviewers do not
review at random. If humans only look at low scores, or only at what someone
disputed, the agreement you measure is agreement on the hardest cases and will be far
worse than the true figure.

Both are useful. Never present a wild-agreement number as a calibration result, and
always state which population the figure came from and how items entered it.

## Never use raw percentage agreement

With a 95% pass rate, two graders who assign verdicts at random and independently
agree about 90% of the time. "We have 90% agreement" is therefore consistent with
having learned nothing at all.

But the standard fix has its own trap, and it bites hard on exactly this data.

### The kappa paradox

Take `p_o = 0.90` observed agreement, with both graders passing 95% of items:

```
Cohen's κ:   p_e = 0.95² + 0.05² = 0.905
             κ   = (0.90 − 0.905) / (1 − 0.905) = −0.05

Gwet's AC1:  p_e = 2 × 0.95 × 0.05 = 0.095
             AC1 = (0.90 − 0.095) / (1 − 0.095) =  0.89
```

**Same data. κ says worse than chance; AC1 says strong agreement.** Neither is a
bug: κ's chance-correction term explodes when one category dominates, which is the
normal condition in QA, where most criteria pass most of the time.

So:

- **Report both**, always, plus raw agreement and the marginal pass rates.
- **When prevalence is extreme** (a category above ~85% or below ~15%), trust AC1
  and treat κ as uninterpretable rather than as bad news.
- **When κ and AC1 disagree sharply, that is itself the finding**: the criterion
  almost never fails, so it carries little information. That is a scorecard-design
  problem, not an agreement problem.
- **For ordinal verdicts** (not met / partial / met), use weighted agreement — a
  met-vs-partial disagreement is not the same failure as met-vs-not-met, and
  unweighted statistics treat them identically.

```bash
node scripts/agreement.mjs --input verdicts.jsonl --ordinal not_met,partial,met --by channel
```

See [references/statistics.md](references/statistics.md) for the input shape, the
formulas, and how to read the combination of numbers.

## Separating bias from noise

This is the step that changes what you do next, and it is usually skipped.

**Compare the marginal rates.** If grader A passes 88% and grader B passes 79%, B is
nine points harsher regardless of how well they agree item by item. That gap is
bias, and no amount of criterion rewriting removes it.

**Test the asymmetry of the disagreements.** Among the items where they disagree,
count how often A was harsher versus B. Under pure noise those counts should be
roughly equal. A lopsided split is systematic severity — the script reports the split
and an exact binomial p-value for it.

Then act accordingly:

| Finding | What it means | Fix |
| --- | --- | --- |
| Low agreement, symmetric disagreements | Ambiguous criterion | Rewrite the criterion as an observable decision rule |
| High agreement, large marginal gap | One grader's threshold differs | Recalibrate the threshold or adjudicate; do not rewrite |
| Low agreement, asymmetric | Both problems | Fix the criterion first; re-measure before touching thresholds |
| High agreement, small gap | Working | Ship, monitor at cadence |

**A low agreement figure is a property of the criterion, not of the people.** Treat
it as a specification bug. Instructing graders to try harder does not move it.

## Differential agreement is a fairness issue

Compute agreement **per segment** — channel, language, market, team, tenure — not
just overall. If an AI grader agrees with humans 88% of the time on email and 62% on
voice, the aggregate figure of 84% hides a system that is unreliable on voice, and
every voice agent is being scored by a worse instrument than their email colleagues.

Two segmentations to always run, because they carry a real fairness risk:

- **Channel, especially voice.** Voice QA grades a transcript, and speech
  recognition errors are not randomly distributed — they track accent and audio
  quality. Differential agreement on voice is the signature of a criterion being
  applied to text that does not faithfully represent what was said.
- **Language and market.** A grader — human or model — that is weaker in one
  language systematically marks down the agents who work in it.

Where agreement differs materially by segment, say plainly that scores are not
comparable across those segments until it is fixed. That statement is more valuable
than the aggregate number.

## Contested and overturned evaluations

Overturn rate looks like an obvious quality signal and is one of the most misleading
numbers available, because **only disputed evaluations get re-reviewed**. A high
overturn rate among contested items is expected: people contest what they think is
wrong. It says nothing about the base rate.

Use it carefully:

- **The dispute rate itself** is the more honest signal. A criterion generating
  disproportionate disputes is under-specified, regardless of who wins them.
- **Compare overturn rates across criteria**, not against an absolute standard. The
  selection bias is roughly common; the differences are informative.
- **Look at second-level outcomes.** Items rejected at first level and accepted at
  second indicate an inconsistent adjudication standard, which erodes trust in the
  programme faster than a wrong score does.
- **Never coach from a disputed evaluation** while the dispute is open.

## Practicalities

- **Sample size.** Agreement statistics on 20 items have intervals wide enough to
  span "broken" to "strong". Bootstrap the interval and report it; the script does.
  Per-criterion agreement needs items where that criterion actually varies — a
  criterion that passed on all 30 gold items yields no information about it.
- **Independence.** Graders must not see each other's verdicts, and must not have
  discussed the items. Sequential review is not calibration; it measures compliance.
- **Refresh the gold set.** A memorised gold set stops measuring anything. Rotate it.
- **Re-measure after every change** to the rubric, the grader roster, or the AI model
  version. A model upgrade can move agreement in either direction and is invisible
  otherwise. Keep the gold set fixed across a model change so the comparison means
  something.

## Present results to the user

1. **Which question you answered** — designed calibration or wild agreement — and
   how items entered the sample.
2. **The numbers together**: raw agreement, κ, AC1, and each grader's marginal rate.
   Never κ alone.
3. **Bias vs noise verdict**, with the marginal gap and the disagreement asymmetry.
4. **Per-criterion breakdown**, worst first, flagging criteria with too little
   variation to assess.
5. **Per-segment agreement**, calling out any segment where the instrument is
   materially weaker and stating that scores are not comparable there.
6. **What to change** — criterion rewrites, threshold changes, or adjudication —
   mapped to the finding that justifies each.
7. **Confidence** — sample size, bootstrap intervals, and which cells were too small
   to assess.
