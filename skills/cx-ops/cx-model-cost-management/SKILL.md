---
name: cx-model-cost-management
description: Use to analyse where LLM spend goes in support automation — cost per resolution, prompt bloat, retrieval size, retry loops, and the cost-vs-quality frontier from your own usage, not invented benchmarks. Trigger for "LLM cost per ticket", "why is our bot so expensive", "token usage breakdown", "reduce AI support costs", "cost vs quality tradeoff", or attributing spend to prompt, retrieval, or retries.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: analysis
---

# Model cost management

Support AI costs appear as a monthly invoice with no tie to outcomes. Finance asks
"cost per ticket"; engineering sees token spikes with no attribution. **You cannot
optimise what you do not decompose.**

Build cost from **your logs and your pricing** — never cite invented $/ticket industry
benchmarks. Vendor list prices × your measured tokens × your resolution definition.

## Define cost per resolution honestly

Pick a resolution definition and stick to it:

- **Bot-contained conversation** — no human agent message after bot last spoke
- **Any bot participation** — cheaper denominator, mixes handoffs
- **Issue resolved** — needs repeat-contact window; harder, more meaningful

```
Cost per resolution = total model spend in window / count of resolutions
```

Report **median and p90** — a few long multi-tool threads dominate means.

Segment by channel, language, contact driver, and model version. One headline average
hides drivers where automation is uneconomic.

## Where tokens actually go

Decompose a sample of conversations (or all if logging allows):

| Stage | Typical drivers | What to log |
| --- | --- | --- |
| **System prompt** | Static instructions, few-shots | Input tokens fixed per call |
| **Conversation history** | Unbounded thread growth | Turns included, summarisation |
| **Retrieval context** | k chunks × chunk size | Chars retrieved, deduped or not |
| **Tool loops** | Each round re-sends context | Iteration count |
| **Grader / classifier** | Second model pass | Calls per conversation |
| **Retries** | Rate limits, validation failures | Retry count, backoff |

**Prompt bloat** — system prompt and few-shots growing every sprint without eval —
is the most common silent doubling of input tokens.

**Retrieval size** — retrieving twelve long articles "for safety" when the model
only uses one paragraph.

**Retry loops** — tool error → model retries → exponential context resend.

Produce a **waterfall** for a median conversation and for p90.

## Cost vs quality frontier

Optimisation is not "cheapest model." Map points on your own frontier:

1. Fix quality bar (eval set or production sample grade).
2. Vary one lever: model tier, retrieval k, history window, summarisation.
3. Measure **quality delta and cost delta** on the same cases.

| Lever | Cost effect | Quality risk |
| --- | --- | --- |
| Smaller / cheaper model | ↓ spend | Regulated drivers, non-English |
| Shorter history | ↓ input | Loses thread context |
| Aggressive summarisation | ↓ input | Omits constraints customer stated |
| Lower retrieval k | ↓ input | Misses right doc |
| Drop grader on low-risk path | ↓ calls | Bad sends slip through |

**Do not cut on segments where error cost exceeds token savings** — compute that
trade-off explicitly for your highest-risk drivers.

## Practical reductions (after measurement)

Only after attribution:

- **Trim system prompt** — remove dead instructions; version and diff like code.
- **Cap history** — last N turns or summarise with eval regression on multi-turn cases.
- **Right-size retrieval** — rerank to fewer chunks; measure recall impact separately.
- **Stop double model calls** — grader on sample, not every message.
- **Cache stable context** — system prompt and KB snippets where platform supports it.
- **Fix retry storms** — tool timeouts and validation before the model loops.

Each change ships through the **same eval gate as prompt changes** — cost cuts that
break deferral are net negative.

## Monitoring

Track weekly:

- Total spend, conversations, resolutions, cost per resolution
- Input vs output token ratio (output-heavy → verbose prompts or long answers)
- Tool iterations p50 / p95
- Spend by model version (detect accidental prod on flagship tier)

Alert on **spend per resolution spike** with driver breakdown, not only total invoice.

## Traps

- **Attributing shared infra only to bot** — include retrieval, embeddings, grader.
- **Ignoring human cost** — cheap model + more escalations can raise total cost to serve.
- **Optimising English only** — other languages may need different tier for same quality.
- **One-week window after launch** — novelty and marketing traffic skew denominators.

## Present results to the user

1. **Resolution definition and denominators** — what the ratio means.
2. **Headline cost per resolution** — median, p90, by segment table.
3. **Token waterfall** — where spend accumulates on median vs p90 conversations.
4. **Top levers** — ranked by savings potential with measured or estimated impact.
5. **Frontier points** — quality vs cost trades tested or proposed; no fake precision.
6. **Recommendations** — specific changes, eval required, owner.
7. **Gaps in logging** — what could not be attributed and what to instrument next.
