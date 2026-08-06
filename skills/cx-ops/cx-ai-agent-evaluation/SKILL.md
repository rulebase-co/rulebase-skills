---
name: cx-ai-agent-evaluation
description: Use to build an evaluation set and regression process for a customer-facing AI support agent, so prompt and model changes can be shipped without silently breaking answers. Trigger for "how do we test our support bot", "did the new prompt make it better", "evaluate our AI agent", building an eval set, comparing model versions, or an AI agent going to production without a test suite.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: playbook
---

# Evaluating an AI support agent

Support AI is usually shipped on vibes: someone tries ten questions, it looks good, it
goes live. Then a prompt tweak three weeks later breaks a category nobody re-tested,
and the first signal is a complaint.

The fix is ordinary software practice applied to a non-deterministic system: **a fixed
evaluation set, a defined grading procedure, and a regression run before every change.**

This is about answer quality. Whether the agent reduces contact volume, and whether it
causes harm, are separate questions with separate methods.

## Build the eval set from real traffic

Not from imagined questions. Real customers ask things nobody would think to write.

- **Draw from actual conversations**, sampled across contact drivers in proportion to
  volume, then deliberately over-weight the categories where being wrong is expensive.
- **Include the hard cases on purpose**: ambiguous requests, multi-part questions,
  questions the knowledge base does not answer, angry customers, out-of-scope requests,
  and requests to speak to a human. **The out-of-scope and no-answer cases are the most
  valuable items in the set**, because the correct behaviour there is to decline or hand
  off, and that is exactly what degrades silently when a prompt is tuned for
  helpfulness.
- **Cover every language you serve.** Model capability varies a lot across languages and
  an English-only eval set gives no coverage of the rest.
- **Include the adversarial cases** — attempts to manipulate the agent into ignoring
  its instructions or making commitments.
- **Size it to what you can afford to re-run.** A hundred well-chosen cases run on every
  change beat a thousand run once.

**Freeze it, version it, and keep it out of anything the agent can retrieve.** An eval
set that leaks into the knowledge base or a fine-tuning corpus stops measuring anything.

## Define what a correct answer is, per case

For each case, record the expected outcome — not the expected wording. Wording-match
scoring fails a correct answer phrased differently and is the most common reason teams
abandon eval sets.

Record:

- **The key facts** the answer must contain.
- **The facts it must not assert** — the plausible wrong answers, especially the
  neighbouring policy that a retrieval system will surface instead.
- **The required action**, where there is one: hand off to a human, ask a clarifying
  question, decline.
- **A citation requirement**, if the agent is supposed to ground its answers.

## Grade on dimensions that fail independently

A single quality score hides the failure that matters. Grade at least:

- **Factual correctness** against policy. The only one that can be a hard gate.
- **Completeness** — did it omit the condition, the fee, the next step? The most common
  real-world failure, and it is invisible to a correctness check that only looks for
  wrong statements.
- **Grounding** — is the claim supported by a real source, and does the cited source
  actually say it? **A confident answer citing a real document that does not support it
  is more dangerous than an uncited one**, because it passes review.
- **Appropriate deferral** — did it hand off when it should, and *not* hand off when it
  shouldn't?
- **Safety** — no unauthorised commitments, no regulated advice, no disclosure.
- **Tone**, against the documented standard. Last, and never a gate.

Report these separately. A change that improves tone and degrades grounding is a
regression, and a blended score will call it an improvement.

## Grading at a workable cost

Hand-grading is the gold standard and does not scale to every change. The workable
compromise:

- **Hand-grade the initial run** to establish truth for the set.
- **Use an automated grader for regression runs**, and **validate the grader against the
  human grades before trusting it**. Report their agreement. An unvalidated automatic
  grader is a random number generator with a plausible interface.
- **Re-validate the grader whenever the grader's own model changes.**
- **Hand-grade a sample of every run** anyway, to catch grader drift.
- **Never let the same model grade its own output** as the only check. It shares the
  blind spots.

## Regression, not just evaluation

The eval set earns its keep on the second and subsequent runs.

- **Run before every change** to prompt, model, tools, retrieval, or knowledge base.
  Knowledge-base edits are the sneaky one — nobody thinks of a documentation change as
  a deploy, and it changes the agent's behaviour as surely as a prompt does.
- **Compare case-by-case, not just in aggregate.** A stable overall score can hide ten
  cases fixed and ten broken, which is a coin flip presented as stability. **The
  newly-failing cases are the release decision**, whatever the total says.
- **Account for non-determinism.** The same input can produce different outputs. Run
  each case several times where it matters and report the variability, or a
  single-sample comparison will attribute noise to the change.
- **Keep a permanent regression tier**: every case that ever caused a production
  incident goes into the set forever. This is the set that stops repeat failures, and
  it is the highest-value part of the suite within a year.

## Offline evaluation is necessary and not sufficient

An eval set measures answers to fixed questions. It does not measure:

- **Multi-turn behaviour.** Most real failures happen in turn three, after a
  clarification or a correction. Include multi-turn cases explicitly.
- **Retrieval on the live corpus** as it drifts.
- **Real customer phrasing**, which changes.
- **Whether customers were satisfied**, which needs production signal: repeat contact
  after a bot resolution, handoff rate, explicit human requests, and complaints.

**Pair every offline set with a production sample.** Grade a small random sample of real
bot conversations on the same dimensions, on a cadence. Where offline scores are healthy
and production scores are not, the eval set has drifted from reality — and that is a
finding about the set, not about the agent.

## Present results to the user

1. **The set** — size, how it was drawn, category coverage, languages, and which hard
   cases are represented.
2. **Per-dimension results**, never blended into one number.
3. **Case-by-case diff against the previous run**, with newly-failing cases listed
   first. This is the release decision.
4. **Grader validation** — agreement with human grades, and when it was last checked.
5. **Variability**, where cases were run more than once.
6. **Production comparison**, if available, and any divergence from offline results.
7. **What the set does not cover**, said plainly — languages, multi-turn depth,
   categories with too few cases to conclude anything.
