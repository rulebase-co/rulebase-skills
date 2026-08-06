---
name: cx-scorecard-migration
description: Use to change a QA scorecard or rubric without breaking score comparability, historical series, or grader trust. Trigger for "we're updating the scorecard", "how do we migrate to a new rubric", "can we compare scores before and after the change", parallel run or dual-score window, scorecard versioning, mapping old criteria to new, or communicating a break in the QA trend line.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: playbook
---

# Scorecard migration

Scorecards change. Products change, policies change, regulators change, and the first
version was wrong. The failure mode is treating a rubric change like a wording tweak
while continuing to plot one trend line — agents, leadership, and auditors then draw
conclusions from data that crossed an unmarked cliff.

**A rubric change is a new instrument.** Handle it like one.

## Diagnose migration risk

| Situation | Risk if mishandled |
| --- | --- |
| Criteria renamed but verdict logic unchanged | Low — document mapping, bump patch version |
| Weights or verdict scales changed | Medium — scores not comparable; dual-run needed |
| Criteria added, removed, or split | High — break in series; re-baseline reporting |
| Auto-fail rules changed | Critical — compliance history may need restatement |
| AI grader prompt changed | Treat as rubric change even if human rubric text unchanged |

## Step 1: Version before you edit

Every scorecard needs:

- **Version id** (semantic: major.minor — major = not comparable, minor = comparable
  with documented mapping).
- **Effective date** — when new evaluations use the new version.
- **Owner** — who approved the change and why.
- **Changelog** — criteria added, removed, reweighted, auto-fail changes.

Store version on **each evaluation record**. A score without a scorecard version is
not auditable after migration.

**Never silently overwrite** the rubric text in place and keep the same version number.

## Step 2: Classify the change

| Change type | Comparable to prior? | Reporting action |
| --- | --- | --- |
| Clarification only (same pass/fail boundary) | Yes, with note | Patch version; optional re-score sample |
| Weight change | Partially | Same criteria, new weights — do not blend monthly averages |
| Verdict scale change (binary → 3-point) | No | New series |
| Criterion split or merge | No | Mapping table; old criterion retired |
| New auto-fail | No for compliance rate | Restate risk metrics from effective date |
| Purpose change (coaching → gating) | No | New programme, not migration |

If two or more rows in the "No" column apply, this is a **major migration**, not a
tweak.

## Step 3: Build old-to-new criterion mapping

For every retired or changed criterion, document:

```
Old criterion          → New criterion(s)     Mapping rule
Resolution accuracy    → Resolution + Follow-up  Split: follow-up unanswered → new criterion
Greeting               → (retired)             Dropped — ceremony, no outcome link
Compliance disclosure  → Compliance disclosure Rewritten boundary — treat as new
```

Mapping rules must be **operational**, not aspirational:

- **1:1 carry** — same decision boundary, new examples only.
- **Split** — which old failures map to which new criterion.
- **Merge** — how partial credit on old maps to new.
- **Retire** — no new equivalent; historical metric stops.

Unmapped criteria mean leadership will ask for a number you cannot honestly produce.

## Step 4: Run a parallel / dual-score window

Before cutover, score a sample with **both versions**:

- **Same conversations**, same graders (or same AI model config with both prompts).
- **Sample size** large enough to see per-criterion shift — typically the full gold
  set plus a random production stratum.
- **Duration** long enough to catch channel-specific effects — at minimum one full
  calibration cycle, often 4–8 weeks for production parallel run.

Dual-score outputs:

| Output | Use |
| --- | --- |
| Mean score shift (old vs new) | Set expectations for "break" communication |
| Per-criterion pass rate delta | Find criteria that moved most |
| Rank order correlation | If rank shuffles heavily, pause gating use |
| Auto-fail rate delta | Compliance reporting impact |

**Do not average old and new scores** on one evaluation. Each conversation gets two
evaluation records during the window, tagged by version.

## Step 5: Define the cutover

Pick one:

- **Hard cutover** — all evaluations after date D use v2. Clean, simple, breaks the
  series cleanly. Best when change is major.
- **Gradual grader cutover** — trainers first, then wider roster. Requires strict
  version tagging; confusing if mixed on the same team report.
- **Channel-by-channel** — when only one channel's rubric changes. Report per channel
  until all migrated.

At cutover:

1. Freeze edits to old version (read-only archive).
2. Switch AI grader config and human grader UI to new version.
3. Re-calibrate on a **new gold set** aligned to v2 — old gold verdicts may not map.
4. Publish break notice (Step 6).

## Step 6: Communicate the break point

Stakeholders will compare across the line unless you stop them. Provide:

- **Effective date and version ids** before cutover, not after someone notices.
- **Expected direction and magnitude** of score shift from dual-run ("overall pass
  rate likely 4–7 points lower — stricter resolution criterion, not quality collapse").
- **What remains comparable** — team rank within version, criterion-level trends within
  version, compliance auto-fail counts with mapping caveats.
- **What is not comparable** — monthly QA average, YoY trend, agent bonus thresholds
  tied to old scale.

For agents: explain **what changed in behaviour terms**, not rubric jargon. Link to
examples of pass under old vs new where helpful.

## Step 7: Historical data policy

Three legitimate positions — pick explicitly:

1. **Frozen history** — old evaluations stay as scored; reporting shows a vertical
   break. Preferred for audit trails.
2. **Re-score sample** — re-run old conversations on new rubric for trend analysis
   only; do not overwrite production records. Label as "synthetic backcast".
3. **Mapped aggregate** — apply mapping table to produce approximate historical series.
   Only when mapping is mostly 1:1; document error.

**Never rewrite stored evaluation verdicts** to match a new rubric without a labelled
re-score job and audit log. That destroys evidence.

## Step 8: Re-validate after migration

Four to eight weeks post-cutover:

- Re-measure grader agreement on v2 gold set.
- Check score distribution — new ceiling or floor?
- Re-check correlation with outcome metrics named at scorecard design.
- Compare auto-fail actioning — new rules may surface backlog.

A migration without validation assumes the new instrument works because the old one
didn't.

## Present results to the user

1. **Migration classification** — major vs minor, with comparability verdict.
2. **Version and changelog** — version ids, effective date, criterion-level changes.
3. **Mapping table** — old → new criteria with operational rules.
4. **Dual-score plan** — sample, duration, graders, metrics to capture.
5. **Cutover plan** — hard vs gradual, freeze rules, gold set refresh.
6. **Break communication draft** — what shifts, what stays comparable, audience-specific
   notes for agents, ops, and leadership.
7. **Historical data policy** — frozen, backcast, or mapped — with limitations stated.
