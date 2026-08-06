---
name: cx-prompt-change-management
description: Use to ship prompt and system-instruction changes safely — versioned as config, staged with an eval gate, rollback-ready, and documented in a changelog. Trigger for "how do we deploy prompt changes", "prompt rollback", "version our system instructions", "CI for prompts", "staging before promoting the bot prompt", or treating prompts like production config.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: playbook
---

# Prompt change management

Prompts are treated like copy someone edits in a dashboard: no diff, no rollback, no
record of who changed what. Then a "small tweak" breaks deferral behaviour in Dutch
and the first signal is a spike in complaints.

**A prompt is production configuration.** It needs versioning, staging, an evaluation
gate before promote, a rollback path, and a changelog — the same discipline as an
API deploy.

## Prompt as config-as-code

Store system instructions, tool descriptions, and grader prompts in **version control**,
not only in a vendor UI:

- One canonical source per environment (or export that syncs from git).
- **Semantic or dated versions** — `support-agent/v2025-03-14` beats "latest".
- Pull requests for changes: author, reviewer, linked eval run id.
- **Never edit production in place** without capturing the previous text first.

If the platform cannot git-sync, maintain a repo mirror and a manual promote checklist
that copies exact text both ways. Drift between repo and live is a recurring incident
source.

## What counts as a prompt change

Treat all of these as deploys requiring the same gate:

- System / developer instructions
- Few-shot examples embedded in the prompt
- Tool-use descriptions and parameter schemas exposed to the model
- Grader or classifier prompts downstream of the agent
- **Retrieval query templates** and reranker instructions

Knowledge-base content changes are adjacent: they alter behaviour without a "prompt"
edit. Route KB changes through the same eval set where they affect answers.

## Staging environments

Minimum viable pipeline:

```
dev (experiment) → staging (pre-prod parity) → production
```

**Staging must mirror production** in model, tools, retrieval corpus snapshot, and
locale set. A staging bot on a cheaper model with a stale KB is a demo, not a gate.

For each promote:

1. Pin **model id, temperature, tool list, KB snapshot id, and prompt version**.
2. Run the **regression eval set** against staging.
3. Compare **case-by-case** to the current production baseline — newly failing cases
   first, not blended score.
4. Record pass/fail with eval artefact attached to the change ticket.

## Eval gate before promote

No promote without:

- **Fixed eval set** frozen and versioned (see agent evaluation practice).
- **Per-dimension grades** — correctness, completeness, grounding, deferral, safety.
- **Case diff** against previous prompt version on the same model and KB pin.
- **Grader validation** if an automated grader gates the run — human agreement on a
  sample, or human grade for high-stakes releases.

Hard blockers (examples — set your own from policy):

- Any new failure on a **permanent regression tier** case (past incidents).
- Safety or unauthorised-commitment regression on any case.
- Deferral regression on out-of-scope / no-answer cases.

Soft signals (investigate, may still ship with owner sign-off):

- Tone-only shifts
- Non-deterministic flips on low-stakes cases — account with multi-sample runs

## Rollback path

Before every promote:

- **Snapshot current production prompt** to a labelled version you can restore in one
  step.
- Know **time-to-rollback** on your platform — minutes vs hours matters.
- Define **who can rollback** without a full change window.

Rollback triggers:

- Eval regression on critical cases in production sample
- Handoff-rate or repeat-contact spike on bot-resolved conversations
- Safety incident

After rollback, **forward-fix in dev** — do not stack edits on a bad production
version. Re-run the full gate.

## Changelog

Every promoted version gets a changelog entry:

| Field | Content |
| --- | --- |
| Version id | Prompt + KB + model pin |
| Date / author | Who shipped it |
| Intent | What behaviour should change |
| Eval summary | Pass/fail diff, link to artefact |
| Known trade-offs | Cases deliberately accepted as worse |
| Rollback version | What to restore |

Customer-facing behaviour changes may need comms or internal ops notice — the changelog
is for engineering and QA, not a substitute for ops briefing when handoff rules move.

## Non-determinism and canary

Same input can yield different outputs. For borderline promotes:

- Run critical cases **multiple times** in staging; document variance.
- **Canary in production** — route a small traffic slice to the new prompt before
  full cutover when the platform supports it.
- Monitor production sample grades on the same dimensions as offline eval.

## Traps

- **Prompt-only fix for retrieval failure** — eval keeps failing; team keeps tuning
  instructions. Fix the right layer.
- **Eval set rot** — set never updated; green staging, broken production. Refresh from
  live traffic on a cadence.
- **Dashboard "latest"** — unlabelled live prompt; rollback impossible. Always label.
- **Skipping gate for "wording only"** — wording changes deferral and commitment
  behaviour constantly.

## Present results to the user

1. **Current pipeline** — where prompts live, environments, and gaps vs config-as-code.
2. **Change under consideration** — version id, diff summary, pins (model, KB, tools).
3. **Eval gate result** — case diff, blockers, soft signals, artefact reference.
4. **Promote or hold** — explicit recommendation and required sign-offs.
5. **Rollback plan** — previous version id, steps, owner, expected time.
6. **Changelog entry** — draft text ready to commit on promote.
7. **Post-promote monitoring** — what to watch in production sample and for how long.
