---
name: cx-qa-scorecard-design
description: Use to design, rebuild, or critique a customer-service QA scorecard or rubric. Trigger for "build a QA scorecard", "our QA scores don't mean anything", "design a quality rubric", "everyone scores 98%", scorecard criteria and weighting, QA calibration, inter-rater agreement, choosing a sample size for quality monitoring, or setting up AI-graded QA.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: playbook
---

# Designing a QA scorecard that means something

A scorecard is a measuring instrument. Most are built as checklists of things
that sound like quality, then discovered — usually a year in — to predict nothing
and change no behaviour. This is the procedure for building one that does, and
for diagnosing one that doesn't.

## Diagnose before you build

If a scorecard already exists, find which of these it has. Each has a different
fix, and rewriting criteria won't fix problems 1 or 5.

| Symptom | Underlying fault |
| --- | --- |
| Nearly everyone scores 95–100% | Ceiling effect: criteria don't discriminate |
| Graders disagree on the same conversation | Criteria are adjectives, not decision rules |
| High QA scores, flat or falling CSAT | Scorecard measures conformity, not quality |
| Agents contest scores constantly | Criteria include things agents don't control |
| 25+ line items | Graders satisfice; scores become noise |
| One number covers regulatory and soft skills | A compliance breach averages away |

## Step 1: Name the decision the score must support

Write it down before touching criteria. Scorecards commonly serve one of:

- **Coaching** — where should this agent's next 1:1 focus?
- **Assurance** — did we meet a regulatory or contractual obligation?
- **Gating** — promotion, bonus, probation.
- **Automation quality** — is the bot resolving well or just closing?

These need different instruments. Coaching wants many granular, low-stakes,
frequently-observed criteria. Assurance wants few, binary, defensible ones with
evidence trails. Gating changes agent incentives and invites gaming, so it must
be built from criteria that cannot be satisfied cosmetically.

**One scorecard serving all four is the single most common root cause of a
meaningless scorecard.** If asked to build one that does everything, say so and
propose splitting: a compliance checklist (binary, 100% or risk-sampled) plus a
coaching rubric (richer, sampled).

## Step 2: Choose the outcomes you want to move

Pick one or two measurable outcomes the score should predict:

- CSAT / DSAT rate
- Repeat contact rate within 7 days on the same intent
- Reopen or escalation rate
- Compliance breach count
- Handle time, only where it is not in tension with the above

These are how you validate the scorecard in Step 8. A scorecard with no named
outcome cannot be shown to work or be wrong.

## Step 3: Generate criteria from evidence, not from a template

Vendor templates produce generic criteria that describe support in the abstract.
Instead, read real conversations, roughly 20–30 of each:

- DSAT / low-rated conversations
- Conversations followed by a repeat contact on the same intent
- Conversations that escalated or reopened
- A control set of high-rated conversations

Write down what actually went wrong, in observable terms. "Agent answered the
question they were asked instead of the question behind it" is a criterion.
"Lacked empathy" is a summary of a feeling.

Common criteria organised by category, with worked pass/fail wording:
[references/criterion-library.md](references/criterion-library.md).

## Step 4: Filter every candidate through four tests

Drop or rewrite anything that fails one.

**Observable** — decidable from the conversation record alone. If a grader needs
the CRM, the refund policy in force that week, or the agent's intent, it will be
graded inconsistently. This test is stricter for AI grading, which sees only what
you pass it.

**Controllable** — the agent could have acted differently. Queue wait time,
policy-mandated refusals, and broken tooling are real problems that belong in
operational reporting, not on an agent's score.

**Decidable** — two trained graders independently reach the same verdict. If they
don't, the criterion is a vibe. Rewrite as a decision rule with a stated
evidence requirement, or cut it.

**Discriminating** — it varies across conversations. A criterion 99% of
conversations pass carries no information. Either it's genuinely critical (move it
to auto-fail, where a rare failure is the point) or it's ceremony (cut it).

Aim for **5–9 scored criteria**. Beyond that, grader attention degrades faster
than the added criteria inform.

## Step 5: Separate auto-fail from scored

These are different mechanisms and must not share a scale.

**Auto-fail** criteria are binary, rare, and consequential: missed a required
disclosure, gave regulated advice, failed identity verification, mishandled a
vulnerable-customer disclosure, was abusive. An auto-fail zeroes the evaluation
and routes to a named owner — it is an incident, not a low score. Averaging a
disclosure breach into a 92% is how compliance failures get lost.

**Scored** criteria are the graded, weighted body of the rubric.

Keep auto-fails few (3–6). If a list of 15 auto-fails accumulates, they are not
really catastrophic and belong in the scored set.

## Step 6: Weight by consequence, not frequency

Weight what is costly when absent, not what appears most often. A resolution
accuracy criterion that fires on 8% of conversations but drives repeat contacts
deserves more weight than a greeting criterion that applies to all of them.

Practical constraints: use no more than three weight tiers (for example 3 / 2 /
1), and make sure no single criterion can swing the total by more than about a
third. If it can, it isn't a criterion — it's the score.

## Step 7: Write each criterion as a decision rule

Every criterion needs a name, the verdict options, the evidence required, and at
least one pass and one fail example drawn from real conversations.

Prefer **binary**. Use a **3-point anchored** scale only where partial credit is
genuinely meaningful, and write the anchor for each point. Never use an
unanchored 1–5 scale: graders cluster on 4, which destroys variance.

```
Criterion: Resolution accuracy                                   Weight: 3
Verdict:   Met | Partially met | Not met
Evidence:  Quote the message containing the resolution.

Met            The stated resolution is correct and complete for the
               customer's actual problem, and no follow-up is needed.
Partially met  Correct but incomplete: solves the immediate ask and leaves a
               foreseeable next question unanswered.
Not met        Incorrect, or addresses a different problem than the one raised.

Pass example: [real quote]
Fail example: [real quote]
```

## Step 8: Decide coverage, and be honest about the error bars

This is where most QA programmes quietly break. For a pass rate `p` from `n`
evaluations, the standard error is `sqrt(p(1-p)/n)`.

At the common cadence of **4 evaluations per agent per month**, with p = 0.9, the
95% confidence interval is roughly **±29 percentage points**. An agent scoring
75% and one scoring 100% are statistically indistinguishable. Any coaching,
ranking, or bonus decision made on that number is being made on noise.

Three legitimate responses:

1. **Raise n.** AI grading makes 100% coverage feasible; see
   [references/ai-grading.md](references/ai-grading.md).
2. **Pool.** Report agent scores over a quarter, or report only at team level
   where n is large enough.
3. **Restrict the claim.** Use small samples for coaching examples — a concrete
   conversation to discuss — and never for ranking.

On sampling design: **keep a random stratum for measurement and a risk-weighted
stratum for detection.** Risk-weighted sampling (long conversations, DSAT,
refunds, vulnerability signals) finds breaches far more efficiently, but the pass
rate it produces is biased downward and must never be reported as the overall
quality rate. Two strata, two purposes, reported separately.

## Step 9: Calibrate, and measure agreement rather than assuming it

Before the scorecard goes live, have 3+ graders independently score the same
20–30 conversation gold set, then measure agreement per criterion.

**Do not use raw percentage agreement.** With a 95% pass rate, two graders
agreeing at random hit ~90%. Use a chance-corrected statistic — Cohen's kappa
for two graders, Fleiss' kappa or Krippendorff's alpha for more. Treat κ above
0.7 as usable, 0.4–0.7 as needing rewrites, below 0.4 as broken.

Agreement is a property of the criterion, not the grader. A criterion that no
group of trained graders can agree on cannot be fixed by more training.

Method and cadence: [references/calibration-and-validation.md](references/calibration-and-validation.md).

## Step 10: Validate that the score predicts something

Four to eight weeks after launch, test the scorecard against the Step 2 outcomes:

- Correlate agent-level QA score with CSAT and repeat-contact rate. Near-zero
  correlation means the instrument measures conformity, not quality.
- Check the score distribution. If the interquartile range is inside 5 points,
  you have a ceiling effect and no coaching signal.
- Check per-criterion variance. Criteria that never fail should be cut or
  promoted to auto-fail.
- Check whether scores moved after coaching. A scorecard that never moves is
  either measuring something uncoachable or not being used.

Schedule this review when the scorecard launches. Unvalidated scorecards
accumulate authority faster than they earn it.

## Deliverable

Produce:

1. **Scorecard specification** — purpose, target outcomes, auto-fail list, scored
   criteria with weights, verdicts, evidence requirements, and real examples.
2. **Coverage plan** — sample size per agent per period, the resulting confidence
   interval stated explicitly, and the random/risk stratum split.
3. **Calibration plan** — gold set, graders, agreement statistic and threshold,
   cadence.
4. **Validation plan** — the outcome correlations to check, when, and what result
   would trigger a rebuild.
5. **Changelog** — scorecards drift. Version them; a score is only comparable
   over time within one version.

## Present results to the user

- Lead with the **purpose decision** from Step 1 and, if you split the scorecard,
  why.
- Show the criteria as a table: criterion, weight, verdict type, auto-fail y/n.
- State the **confidence interval** for the proposed sample size in plain terms
  ("at 5 evaluations/agent/month, an agent's monthly score is ±26pp — usable for
  picking coaching examples, not for ranking").
- Name what you **cut** from an existing scorecard and which of the four tests it
  failed. This is usually the most contested part; be specific.
- Flag any criterion you were unable to make observable or decidable, rather than
  shipping it and letting it fail quietly in production.
