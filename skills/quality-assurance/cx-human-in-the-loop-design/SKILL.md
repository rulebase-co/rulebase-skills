---
name: cx-human-in-the-loop-design
description: Use to decide where human approval gates belong in AI-assisted support workflows — which actions need confirm, latency and cost trade-offs, and how to avoid rubber-stamping. Trigger for "human in the loop design", "where should agents approve AI actions", "approval workflow for the bot", "AI auto-send vs review", "rubber stamping risk", or balancing speed and safety on assisted replies.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: playbook
---

# Human-in-the-loop design

Every approval gate adds **latency, labour cost, and a new failure mode**: agents
approve without reading because the queue is backed up. The design question is not
"should humans be involved?" but **where involvement changes outcomes enough to pay
for itself.**

Put the gate **before irreversible or high-cost actions**, not uniformly on every
token the model emits.

## Classify actions by reversibility and blast radius

| Tier | Examples | Default gate |
| --- | --- | --- |
| **Read-only** | Draft suggestion, internal summary, triage tag | None — log only |
| **Reversible customer comms** | Email/chat reply (editable before send) | Agent send button (human always in loop) |
| **Reversible record change** | Tag, note, priority bump | Policy-dependent; often auto with audit |
| **Hard to reverse** | Refund, credit, account closure, data export | Explicit confirm; dual control if regulated |
| **Irreversible** | Delete data, legal submission, external partner action | Named approver; no full auto |

**The gate belongs on the tier boundary**, not on every assist feature. A copilot
draft is tier 2 — the send click is the gate. A bot that posts refunds is tier 4 —
model output is never sufficient.

## Where to place the gate

```
Customer message → [retrieve/context] → [model proposes] → GATE → [execute]
```

Options for GATE placement:

| Placement | Pros | Cons |
| --- | --- | --- |
| **Before customer sees text** | Catches tone and policy errors | Handle time ↑; agents may rubber-stamp |
| **After send, sample QA** | Fast; scales | Harm already done; good for low-risk channels |
| **Before system mutation** | Prevents account damage | Needs clear action taxonomy |
| **Escalation queue** | Humans handle edge cases | Stranding if routing fails |

Mix tiers: auto-send low-risk macros on known drivers; require review on complaints,
regulated topics, or low model confidence.

## Latency and cost trade-off

Estimate for each gate design:

- **Seconds added per conversation** × volume × agent cost
- **Expected incidents prevented** × cost per incident (complaint, remediation, regulatory)

If the gate adds forty seconds on ten thousand conversations and prevents two
regulatory mis-statements a month, the maths may still favour the gate — but only if
agents actually read. **A gate that is always clicked in under two seconds is not a
gate.**

Report assumptions; do not invent industry-wide "optimal approval rates."

## Rubber-stamping failure mode

Rubber-stamping happens when:

- SLA pressure exceeds review capacity
- UI makes accept the path of least resistance (one click, pre-filled send)
- Suggestions are wrong often enough that agents stop reading but still click
- Incentives reward speed over quality

**Detection signals:**

- Time from suggestion display to send < plausible read time
- Accept rate near 100% with rising QA fail rate on assisted replies
- Identical bad suggestion accepted across many agents

**Mitigations:**

- Require **explicit diff review** on high-risk templates (checkbox, not pre-checked)
- **Random audit** with feedback to agents who approved bad sends
- **Throttle auto-send** when model confidence or retrieval score is low
- **Right-size the gate** — if everything is "high risk", nothing is

## What humans should decide vs what machines should rank

| Machine good at | Human good at |
| --- | --- |
| Ranking conversations for review | Judging novel disputes |
| Flagging missing disclosures | Context across long relationship history |
| First-pass draft | Accountability calls ("we were wrong") |
| Detecting injection patterns | Escalation judgement under ambiguity |

Use humans for **accountability and ambiguity**; use models for **drafting and triage**
— not the reverse.

## Document the policy

For each channel and action type, record:

- Auto-allowed / assist-only / confirm-required / forbidden
- Confidence or retrieval thresholds if used
- Fallback when gate queue exceeds SLA (escalate, do not silently auto-send)
- Owner for exceptions

Review when model, prompt, tools, or regulatory scope changes.

## Traps

- **Gate on volume, not risk** — reviewing easy resets while refunds auto-post.
- **Invisible auto-send** — customer cannot tell bot from human; accountability blur.
- **No metrics on gate quality** — only measuring speed.
- **Stranding behind the gate** — human queue full; customer waits with no status.

## Present results to the user

1. **Action taxonomy** — tiers for this programme with examples mapped.
2. **Proposed gate map** — where approval sits per channel and action.
3. **Latency and labour estimate** — assumptions stated.
4. **Risk reduction argument** — which incidents the gate targets; no fake ROI decimals.
5. **Rubber-stamp controls** — UX, audit, and detection signals.
6. **Policy table** — auto / assist / confirm / forbidden by scenario.
7. **Monitoring** — metrics to confirm the gate is working after launch.
