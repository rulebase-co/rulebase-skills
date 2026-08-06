---
name: cx-agent-experience-audit
description: Use to find agent-side friction — tooling, permissions, dead ends, macro gaps, system hops — by shadowing real work and counting cost per contact before defaulting to training. Trigger for "agent experience audit", "why is handle time so high", "tooling friction", "agents switching systems", "shadow an agent", macro gaps, permission blocks, or "we need more training" when the stack is the problem.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: playbook
---

# Agent experience audit

When quality or handle time slips, the default fix is **more training**. Often the
binding constraint is **the job itself**: six systems per ticket, a macro that stopped
working, an approval that requires a manager who is offline, a KB article that
contradicts policy. Agents compensate with workarounds; WFM sees occupancy; customers
see inconsistency.

**Fix the top friction before buying more training.** An audit quantifies where time and
errors go that agents cannot control.

## Step 1: pick representative work

Do not audit from memory or a tour from engineering.

- **Sample contact drivers** that cover most volume — include the worst handle-time
  and highest repeat-contact strata.
- **Include channel variants** — voice often has different tooling from async.
- **Include vendor agents** if they use narrower access; friction there is frequently
  yours, not theirs.
- **Sessions:** shadow at least 3–5 agents across shifts, 90–120 minutes each, or
  equivalent ticket replay with screen recording if shadowing is impossible.

State what you did not observe (overnight, specific language, new hire vs tenured).

## Step 2: shadow protocol

For each session, the observer records **without coaching**:

| Field | Capture |
| --- | --- |
| Contact id / driver | For traceability |
| Systems opened (in order) | Name each; count hops |
| Time in each system | Rough buckets: >30s matters |
| Copy-paste or re-key events | Same data entered twice |
| Dead ends | Permission denied, 404 KB, broken macro, queue loop |
| Workarounds | Slack ask, personal notes, unofficial spreadsheet |
| Escalation reason | Authority vs knowledge vs tooling |
| Customer-visible delay | Hold, "let me check", async gap |

**Count systems per contact** — a simple metric that shocks stakeholders:

```
System hops = distinct tools or browser contexts required to resolve
```

Also track **unnecessary hops** — those that exist because integration or process failed.

## Step 3: classify friction

Bucket findings so fixes have owners:

| Type | Examples | Typical owner |
| --- | --- | --- |
| **Permission / access** | Cannot refund; cannot see order; vendor sandbox | IT, security, vendor management |
| **Data fragmentation** | Customer in three places; history not in ticket | Product, CRM, integrations |
| **Knowledge** | Missing, wrong, or contradictory article | KM, policy owner |
| **Macro / workflow** | Broken snippet, outdated path, wrong language | Ops tooling, WFM |
| **Routing / queue** | Wrong skill offered; ping-pong between teams | Routing, workforce |
| **UI / reliability** | Timeouts, slow search, no mobile layout | Product, IT |
| **Policy ambiguity** | Agent must guess; managers disagree | Policy, QA |

Tag each as **time cost**, **quality risk**, or **both**.

## Step 4: prioritise fixes

Rank by **volume × severity × fixability**:

- **Volume** — share of contacts hitting this friction
- **Severity** — minutes added, error rate, or escalation probability (estimate from
  shadow sample; do not invent benchmarks)
- **Fixability** — quick config vs multi-quarter integration

Produce a **top three** list. More than three dilutes execution. Training belongs on
the list only when the friction is genuinely skill-based (judgement under clear policy),
not when the tool failed.

## Step 5: validate with data where possible

Shadow finds hypotheses. Confirm with:

- **Handle time decomposition** by driver — spike with same systems implicated
- **Escalation reason codes** — tooling vs knowledge
- **Macro usage logs** — broken or abandoned snippets
- **Assist / chat-to-peer rate** — informal workarounds
- **Repeat contact** on strata with high hop count

If systems do not log hops, the shadow sample *is* the evidence — say so.

## Step 6: close the loop

After a fix ships, re-shadow the same driver sample. Audits that end at a slide deck
do not change agent experience.

## Traps

- **Shadowing only top performers** — they have the best workarounds; friction hides.
- **Blaming agents for workarounds** that exist because the official path fails.
- **Training budget before permission fix** — cheapest hour often sits in access policy.
- **Engineering estimates without shadow evidence** — "it only takes two clicks" vs reality.
- **Ignoring async multi-tab workflows** — hop count is higher than voice in many stacks.
- **One-off hero macros** — fix the canonical path instead of person-specific scripts.

## Present results to the user

1. **Scope** — drivers, channels, agents shadowed, and gaps in coverage.
2. **Friction log** — anonymised table of contacts with system hops, dead ends, and
   workarounds.
3. **Systems-per-contact summary** — median and max hops by driver; unnecessary hop share.
4. **Classified findings** — typed, owned, time vs quality impact.
5. **Top three fixes** — ranked with volume/severity/fixability; training only if justified.
6. **Data validation** — what logs confirmed or contradicted shadow findings.
7. **Re-audit plan** — same sample after fixes, with date owner.
