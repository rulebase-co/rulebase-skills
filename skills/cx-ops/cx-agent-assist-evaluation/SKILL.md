---
name: cx-agent-assist-evaluation
description: Use to measure whether an agent-assist or copilot actually helps — beyond acceptance rate — through edit distance, time and quality trade-offs, and bad-suggestion uptake. Trigger for "is our copilot working", "measure agent assist ROI", "acceptance rate is high but is it good", "did the draft suggestion help", "evaluate our support copilot", or planning an A/B rollout of assist features.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: analysis
---

# Evaluating agent assist (copilot)

High acceptance rate is the metric vendors love and operators regret. An agent clicks
"accept" because it is faster than rewriting, because the suggestion is good, or
because they stopped reading. **Acceptance measures friction, not value.**

Evaluation must ask: **did the suggestion save time without degrading quality, and
how often did accepting a bad suggestion create risk?**

## Define the unit of observation

Pick one primary unit and stick to it:

- **Suggestion event** — each time the copilot offers text. Good for model and prompt
  iteration.
- **Reply sent** — the final customer-visible message. Good for customer outcome.
- **Conversation** — end-to-end handle time and repeat contact. Good for programme
  level, noisy for individual suggestions.

Log at minimum: suggestion shown, accepted / edited / dismissed, final sent text,
conversation id, channel, language, agent tenure band, and contact driver where
available.

## Measure value beyond acceptance

| Signal | What it tells you | Caveat |
| --- | --- | --- |
| **Acceptance rate** | Workflow friction | Confounded by suggestion quality and agent habit |
| **Edit distance** | How much change after accept | Normalise by suggestion length; empty edit ≠ good |
| **Time to send** | Efficiency | Only meaningful with handle-time context |
| **Dismiss rate** | Irrelevance or distrust | High dismiss on good suggestions = UX failure |
| **Suggestion-not-used but fast reply** | Copilot as distraction | Agent ignored assist and still replied quickly |

**Edit distance** is the workhorse: character- or token-level distance between
suggestion and sent reply, bucketed (sent verbatim / light edit / heavy rewrite /
discarded). A copilot that is accepted then heavily edited is not delivering value —
it is delivering a rough draft the agent distrusts.

Compare **time to send** for accepted vs dismissed vs no-suggestion baselines on
matched conversation types. A copilot that saves thirty seconds on password resets
but adds two minutes on disputes is two products.

## Quality must move with efficiency

Efficiency gains that increase policy errors or omit required steps are negative ROI.

On a stratified sample of assisted replies (not uniform — overweight regulated and
complaint threads):

- Grade **factual correctness, completeness, commitments, and tone** with the same
  rubric as unassisted replies.
- Tag **bad suggestions that were accepted** — wrong policy, missing disclosure,
  unauthorised promise. This is the failure mode acceptance rate hides.
- Compare assisted vs unassisted **on matched segments** (same channel, driver,
  tenure band). Raw global comparison confounds routing and case mix.

If quality drops in the segments where acceptance is highest, the copilot is
optimising the wrong behaviour.

## Acceptance of bad suggestions

Track explicitly:

- **Bad suggestion offered** — graded wrong or risky before the agent acts.
- **Bad suggestion accepted** — the agent sent it (or most of it).

The second rate is operational risk. Report both numerators with denominators and
confidence intervals at small n — **do not imply precision you do not have.**

Root-cause buckets: retrieval wrong, policy stale, over-confident generation, agent
rubber-stamping under SLA pressure.

## Experiment design without fake precision

**Randomised A/B** — best when you can assign agents or conversations cleanly and
power is honest. State primary metric upfront (e.g. median time to send on matched
drivers). Report confidence intervals; if n is small, say the experiment is
directional only.

**Staggered rollout** — team A gets assist, team B waits. Practical, but confounds
team effects. Match on tenure, channel mix, and baseline handle time; check parallel
trends before the switch.

**Before/after** — weakest. Seasonality and policy changes dominate. Use only with
held-out control team or interrupted time-series sanity check.

Never report lift to one decimal place when the underlying sample is a few hundred
conversations. **"Suggestive improvement, not confirmed"** is a valid output.

## Traps

- **Assist attribution in CRM** — "used copilot" flags are often wrong. Validate on a
  manual sample.
- **Cherry-picked demos** — eval on easy macros; production is angry multi-turn email.
- **Suggestion length bias** — longer suggestions look more "helpful" in edit-distance
  math but take longer to verify.
- **Tenure confound** — new agents accept more; veterans dismiss. Segment always.

## Present results to the user

1. **Scope** — product, channels, window, unit of observation, and how assist usage
   was detected.
2. **Usage funnel** — shown → accepted / edited / dismissed, by segment.
3. **Edit distance distribution** — verbatim vs light vs heavy vs discarded.
4. **Time analysis** — time to send vs baselines, with segment tables and caveats.
5. **Quality comparison** — assisted vs unassisted on matched samples; bad-suggestion
   offered vs accepted rates.
6. **Experiment readout** — design, primary metric, interval or directional label,
   confounds acknowledged.
7. **Recommendation** — keep, narrow to segments, change prompt/retrieval, or pause;
   what would falsify the conclusion.
