---
name: cx-gold-set-management
description: Use to build, rotate, and retire calibration gold sets so they keep measuring agreement instead of memorisation. Trigger for "refresh our calibration set", "graders know the gold set by heart", "how often should we rotate calibration cases", "our calibration scores look perfect but production agreement is bad", gold set size, stratified calibration sampling, or retiring cases that no longer discriminate.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: playbook
---

# Gold set management

A gold set is the reference standard for whether graders apply the rubric the same
way. Most programmes build one once, reuse it until everyone has memorised the
verdicts, and then report calibration numbers that measure recall, not agreement.

**A memorised gold set is worse than no gold set** — it produces false confidence
while production disagreement grows.

## Diagnose a stale set

| Symptom | Likely cause |
| --- | --- |
| Calibration κ near perfect; wild agreement poor | Graders memorised verdicts, not rules |
| Same conversations reappear for years | No rotation cadence |
| Gold set scores improve; dispute rate flat | Set no longer discriminates |
| New graders calibrate fast; tenured graders disagree in production | Onboarding set ≠ operating set |
| Set is 200+ conversations | Too large to re-score; rotation becomes a project |

## What a gold set is for — and what it is not

**For:** measuring agreement on criteria, onboarding graders, validating rubric
changes, comparing grader or model versions on a fixed reference.

**Not for:** coaching examples (those come from live sampling), compliance evidence
(the set is a measurement artefact, not a population sample), or agent performance
ranking.

Keep purposes separate. A set built for onboarding breadth will fail as a
calibration instrument.

## Step 1: Size for re-scoring, not coverage

The gold set must be small enough that 3+ graders can independently score the full
set in one session, and that you can rotate it without a quarter-long project.

Practical bounds:

- **20–40 conversations** for initial calibration on a scorecard with 5–9 criteria.
- **Add conversations, not criteria**, when per-criterion agreement needs more items
  where that criterion varies. A criterion that passes on every gold item teaches
  nothing about it.
- **Cap total scored criteria × conversations** so a full pass takes under two hours
  per grader. Sets that exceed that get skipped or rushed.

If the programme insists on a large library, split it: a **core rotation set**
(20–40, scored monthly) and an **extended bank** (drawn from for refresh, not scored
every cycle).

## Step 2: Build with stratified sampling

A gold set must vary on the dimensions where graders disagree in production. A set
drawn only from "typical" email tickets will miss voice, edge cases, and the
criteria that actually break.

Strata to cover, weighted by where disagreement or risk concentrates:

| Stratum | Why include it |
| --- | --- |
| Channel | Voice transcripts, chat async, email — different evidence shapes |
| Intent / queue | Policy-heavy vs transactional; criteria fire differently |
| Outcome signal | DSAT, repeat contact, escalation — where quality failed |
| Edge cases | Vulnerability, regulated topic, partial resolution |
| Control | Unambiguous passes — detect leniency drift |

Within each stratum, pick conversations where **at least one criterion is genuinely
debatable** — not the clearest pass or the most dramatic fail. The goal is
discrimination, not drama.

**Do not hand-pick favourites.** Use a defined frame and random draw within strata,
then curate only to remove PII or duplicates. "Cases we always argue about" belong
in the set; "cases the QA lead loves" may not.

## Step 3: Annotate as a specification, not a score sheet

Each gold item needs:

- **Reference verdicts per criterion**, with evidence quotes — these are the
  adjudicated standard until the set rotates.
- **Notes on ambiguity** where reasonable graders could disagree — flag for rubric
  rewrite rather than pretending consensus exists.
- **Segment tags** (channel, language, queue) for differential agreement analysis.

Store gold sets **versioned**. A score compared against gold set v3 is not
comparable to gold set v2.

## Step 4: Set a rotation cadence before memorisation

Rotation is not optional. Define cadence by exposure, not calendar alone:

| Signal | Action |
| --- | --- |
| Same graders have scored the set 3+ times | Replace 30–50% of items |
| New hire cohort has seen the set in training | Refresh before they join calibration |
| Rubric version changes | New set aligned to new criteria; do not reuse old verdicts |
| Per-item agreement hits ceiling | Retire items where everyone agrees instantly |

**Default cadence:** partial rotation every quarter, full rebuild annually, or
immediately after a major rubric change.

Rotation procedure:

1. Retire items that no longer discriminate (see Step 5).
2. Draw replacements from the same stratified frame.
3. Adjudicate reference verdicts with a panel — not the QA lead alone.
4. Run a pilot score with 2–3 graders before the set goes live.
5. Publish version, effective date, and what changed.

## Step 5: Retire cases that stop working

Remove an item when:

- **Agreement is perfect for 2+ cycles** and the criterion still disagrees in
  production — the item is too easy or too familiar.
- **The conversation no longer reflects current policy or product** — grading it
  teaches obsolete rules.
- **PII or customer context makes it unusable** — redact or drop.
- **Adjudicated verdict was wrong** and correcting it would surprise everyone who
  memorised the old answer — retire and replace rather than "fix in place".

Keep a **retired log**: item id, reason, date. Auditors ask why calibration history
jumped.

## Step 6: Run calibration sessions correctly

Independence rules (non-negotiable):

- Graders score **before** seeing reference verdicts or each other's work.
- No "walkthrough" of the gold set in the same week as measurement.
- Sequential review is training, not calibration — do not report its numbers.

After scoring, measure agreement per criterion (chance-corrected statistics, not raw
percentage). Items with persistent disagreement go to adjudication or rubric rewrite,
not to "the grader was wrong" without evidence.

## Step 7: Link gold set health to programme decisions

| Gold set health | Programme implication |
| --- | --- |
| Healthy rotation, stable wild agreement | Trust calibration cadence |
| Stale set, good calibration, bad wild | Pause gating decisions; fix rotation |
| Low agreement on specific criteria | Rubric rewrite, not more training |
| Differential agreement by channel | Segment-specific criteria or graders |

## Present results to the user

1. **Stale-set diagnosis** — which failure mode applies, with evidence (memorisation
   signals, size, age, agreement vs wild gap).
2. **Gold set specification** — target size, strata and counts per stratum, criteria
   coverage requirements.
3. **Rotation plan** — cadence, partial vs full refresh triggers, ownership.
4. **Retirement criteria** — explicit rules for dropping items, with current candidates
   if auditing an existing set.
5. **Version changelog** — gold set id, effective date, items added/removed, rubric
   version it aligns to.
6. **Session protocol** — independence rules, scoring window, agreement statistics to
   compute, and what happens when agreement fails threshold.
