---
name: cx-bot-knowledge-grounding
description: Use to audit retrieval and grounding as the ceiling on bot answer quality — separating missing knowledge from wrong chunks, and measuring retrieval apart from generation. Trigger for "why does the bot make things up", "RAG audit", "wrong article cited", "retrieval quality", "bot answers not in the KB", "grounding failures", or KB gaps vs search failures.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: analysis
---

# Bot knowledge grounding audit

A fluent wrong answer is usually two failures stacked: **retrieval did not surface
the right source**, and **generation asserted anyway**. Teams tune the model when the
KB is empty, or expand the KB when search returns the wrong chunk. **Measure retrieval
and generation separately** or you will fix the wrong layer.

Retrieval quality is the **ceiling** on answer quality. Perfect generation cannot
exceed what relevant, correct sources contain.

## Failure taxonomy

For each bad or unsupported answer, classify root cause:

| Class | Definition | Typical fix |
| --- | --- | --- |
| **Missing KB** | No documented answer exists | Content programme |
| **KB present, not retrieved** | Right doc exists; search missed it | Embeddings, chunking, query rewrite |
| **Wrong chunk retrieved** | Related but incorrect passage ranked first | Chunk boundaries, metadata filters, reranker |
| **Right chunk, wrong generation** | Source supports a different conclusion | Prompt, model, citation enforcement |
| **Fabrication with citation** | Cites real doc that does not support claim | Generation + review; often worse than no cite |
| **Correct deferral missed** | Should hand off; retrieved noise encouraged answer | Prompt + retrieval threshold |

**Cite grounding failures with evidence**: conversation id, customer question (redacted),
chunk ids or URLs retrieved, what the bot claimed, and what the source actually says.

## Measure retrieval without generation

Run retrieval-only evaluation on a labelled query set:

- **Query** — from real customer phrasing, not only article titles.
- **Expected document(s)** — human-labelled relevant sources.
- **Metrics** — recall@k (is the right doc in the top k?), MRR, nDCG if graded
  relevance is ordinal.

Report by **language, product area, and query type** (how-to vs policy vs account-specific).

Retrieval can look healthy at k=5 and still fail in production if the bot only passes
k=1 to the model, or if metadata filters exclude the right locale.

## Measure generation given retrieval

Fix retrieval logs, then re-run or replay:

- **Supported** — claim entailed by retrieved text.
- **Unsupported** — claim not in retrieved set.
- **Contradicted** — claim conflicts with retrieved text.

This split tells you whether to invest in search or in "answer only from context"
prompting.

## Missing KB vs wrong chunk

Signals for **missing KB**:

- Repeated questions on the same driver with fabrication or hand-waving
- Human agents consistently use macros or tribal knowledge not in search index
- Retrieval returns empty or irrelevant with low scores across paraphrases

Signals for **wrong chunk**:

- Retrieved docs are thematically related (same product, wrong scenario)
- Correct doc exists in corpus but ranks below an outdated article
- Chunk cuts mid-table or mid-exception list

Run a **coverage map**: top contact drivers × "documented / partial / absent" ×
"retrievable when documented". A documented but unretrievable answer is a search bug.

## Stratified sampling for grounding audit

Do not sample uniformly. Over-weight:

- Regulated, fees, eligibility, timelines
- Drivers with high repeat contact after bot resolution
- Languages with known thin content
- Cases where the bot cited something

For each sampled answer:

1. List retrieved chunks (ranked).
2. Judge support per key claim.
3. Assign taxonomy class above.

## Traps

- **Citation as proof** — link present, claim wrong. Always read chunk text.
- **Stale KB** — retrieval correct for old policy. Track doc version in eval.
- **Account-specific questions** — no KB will answer; correct behaviour is deferral.
  Score deferral separately from retrieval recall.
- **English eval on multilingual bot** — retrieval indices differ per language.
- **Synthetic queries** — easy article titles inflate recall@k vs real phrasing.

## Present results to the user

1. **Scope** — bot, corpus snapshot id, languages, sample design.
2. **Retrieval metrics** — recall@k and segments; query set size and limitations.
3. **Generation-given-retrieval** — supported / unsupported / contradicted rates.
4. **Failure taxonomy table** — counts by class with representative cited examples
   (ids, minimal quotes, redacted).
5. **Coverage map** — drivers where KB is absent vs unretrievable vs healthy.
6. **Priority fixes** — ordered by customer risk and which layer owns them.
7. **What was not measured** — account-specific paths, tools/API grounding, live corpus
   drift since snapshot.
