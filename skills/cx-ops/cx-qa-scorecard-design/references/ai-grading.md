# AI-graded QA

Moving from sampled human grading to model grading changes which error dominates.
Understanding that trade is the whole job.

## The trade you are making

Human QA at 4 evaluations/agent/month is dominated by **random** sampling error —
±29 pp on an agent's monthly score. AI QA at 100% coverage removes almost all of
it: every conversation is graded, so there is no sample to be unrepresentative.

In exchange you take on **systematic** error. A model that is 8 points lenient on
long conversations is 8 points lenient on every long conversation, in the same
direction, forever. Random error shrinks with volume; systematic error does not.

**A biased grader applied to 100% of conversations is worse than a fair grader
applied to 5%**, because the bias now has the authority of completeness. Coverage
is not accuracy, and a dashboard showing 100% coverage invites everyone to forget
the difference.

So the work is: measure the bias, bound it, and keep measuring it.

## Design rules

**Ask for verdicts and evidence, never for a score.** Have the model return, per
criterion, a verdict plus a verbatim quote from the transcript supporting it. Do
the weighting and arithmetic in code.

```jsonc
{
  "criteria": [
    {
      "id": "resolution_accuracy",
      "verdict": "partially_met",
      "evidence": "You'll see the refund in 3-5 days.",
      "reasoning": "Correct process, but did not mention the £2 fee deduction."
    }
  ]
}
```

This buys three things: the arithmetic is right, every verdict is auditable
against the transcript, and an evidence field that cannot be filled is a strong
hallucination signal. Requiring a quote is the single highest-leverage constraint
in AI grading.

**Reject verdicts whose evidence is not in the transcript.** Verify the quote
appears in the source text and fail the evaluation if not. Cheap to implement,
and it catches the failure mode that most damages trust.

**Blind the grader to outcomes and identity.** Do not include CSAT scores, DSAT
flags, reopen status, complaint status, agent name, or tenure in the grading
context. A model told the conversation received a 1-star rating grades every
criterion down — the score then partly restates the outcome it is supposed to
predict, and the validation in
[references/calibration-and-validation.md](references/calibration-and-validation.md)
becomes circular. Pass the transcript, the rubric, and any policy the criteria
require. Nothing else.

**Supply what the criterion needs.** A model cannot judge policy accuracy without
the policy. If a criterion requires external context, retrieve and include it, or
drop the criterion. A model asked to judge something it cannot see will still
return a confident verdict.

**Strip internal notes unless the criterion is about them.** Internal notes
(`public: false`) are not customer-facing; grading tone or clarity over them
misgrades.

**Pin the model version.** Scores are comparable only within a model version. Treat
a model upgrade exactly like a rubric change: new version, re-validate, and do not
splice the trend lines. An unannounced provider-side change is a common cause of
"quality dropped in March" investigations that find nothing.

## Validation

**Per criterion, not overall.** Compute κ against a human gold set for each
criterion separately. Overall score correlation hides compensating errors — a
model that is lenient on clarity and harsh on accuracy can produce a well-correlated
total while both criteria are individually unreliable. Only per-criterion agreement
tells you which criteria the model can actually grade.

**Test-retest first.** Run the same 30 conversations three times and measure
self-agreement. A model that disagrees with itself cannot agree with humans; its
self-agreement is the ceiling on any κ you will achieve. Do this before blaming
the rubric for a low κ.

**Then bias checks.** For each, compare model verdicts against human verdicts
across the strata:

| Bias | Test |
| --- | --- |
| Length | Mean score by transcript-length quartile. Human-graded gold set should show the same gradient; if only the model's rises, it is length bias. |
| Leniency | Model pass rate minus human pass rate, per criterion. |
| Channel | Agreement per channel. Voice transcripts usually drop first. |
| Language | Agreement per language. Non-English and code-switched conversations commonly degrade. |
| Position | Shuffle criterion order; verdicts should not move. |

Report leniency as a per-criterion offset rather than correcting it silently. If
the offset is stable you can state it; if it varies by stratum, the criterion is
not ready.

**Then keep measuring.** Hold a continuous random audit stratum — a small
percentage of AI-graded conversations re-graded by humans, forever. This is the
only mechanism that detects drift. Without it you find out at the next annual
review.

## Human-in-the-loop, where it is non-negotiable

- **Auto-fails.** Never let a model's unreviewed verdict stand as a compliance
  breach or trigger disciplinary action. Model-flagged auto-fails are a queue for
  human confirmation, not a finding.
- **Disputes.** Agents must be able to contest a verdict and reach a human. The
  evidence quote makes this tractable; without it, disputes are unresolvable and
  the programme loses legitimacy fast.
- **Novel situations.** Conversations the model marks low-confidence, or that fall
  outside the rubric's designed scope, route to humans rather than getting a
  default verdict.

## What changes in the rubric

Criteria written for human graders often need tightening:

- **"Observable" gets stricter.** Humans quietly use context the model will not
  have. Any criterion where your graders were unconsciously drawing on account
  history or tribal knowledge will fail.
- **Ordinal scales get harder.** The met/partially-met boundary is where models are
  least consistent. Convert to binary where you can; where you cannot, expect the
  lowest κ there and write the partial anchor unusually precisely.
- **Rare criteria need supervision.** A criterion firing on 1% of conversations
  gives you very few positives to validate against, so its measured κ is itself
  unreliable. These are usually auto-fails, which need human confirmation anyway.

## What 100% coverage actually buys

Not a better score — a different unit of analysis. With every conversation graded
you can do things sampling never allowed:

- Segment quality by intent, channel, language, tenure, time of day, and queue,
  with real `n` in each cell.
- Detect a quality regression within days instead of a quarter.
- Find the specific conversations behind a metric move, rather than inferring.
- Coach from the agent's actual failures rather than from four conversations that
  happened to be sampled.

State the benefit in those terms. "We now grade 100%" is a coverage claim;
"we can now tell you that refund-related chats in Spanish fail resolution accuracy
three times more often than the mean" is the reason it was worth doing.
