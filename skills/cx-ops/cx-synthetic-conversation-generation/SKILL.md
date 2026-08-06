---
name: cx-synthetic-conversation-generation
description: Use to build test conversations for QA and AI eval without putting production PII in fixtures — synthetic vs redacted real data, edge-case coverage, and leakage risk when generation is done poorly. Trigger for "synthetic test conversations", "eval data without PII", "generate test tickets", "redact transcripts for testing", "fixture conversations for the bot", or avoiding production data in test sets.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: playbook
---

# Synthetic conversation generation

Real transcripts are the richest source of test cases and the fastest way to **leak
PII into repos, eval sets, and vendor sandboxes.** Poor synthetic data is useless;
poorly redacted real data is a compliance incident.

Goal: **representative coverage without identifiable customers**, with explicit
labelling of what is synthetic vs derived.

## Choose the source strategy

| Approach | When to use | Risk |
| --- | --- | --- |
| **Fully synthetic** | Greenfield scenarios, adversarial cases, rare edge types | Unrealistic phrasing if not validated |
| **Redacted production** | Match real phrasing and driver mix | Re-identification if redaction weak |
| **Structured templates + variation** | Scale coverage of known drivers | Misses messy real-world turns |
| **Human-authored gold cases** | High-stakes regulated scenarios | Expensive; small set |

Usually combine: **redacted real for phrasing realism**, **synthetic for edges and
attacks**, **human gold for policy boundaries**.

## Fully synthetic: make it realistic

- Seed from **contact-driver taxonomy**, not from article titles.
- Vary **register, language, typos, anger, multi-turn confusion**.
- Include **negative cases**: out-of-scope, missing info, customer wrong about facts.
- Validate a sample against **real traffic distribution** — if 30% of volume is
  billing disputes, the set should not be 30% password resets.

Label every synthetic case `synthetic: true` in metadata. Never mix unlabelled synthetic
into calibration sets without documenting origin.

## Redacted production: redaction that holds

Minimum removals or replacements:

- Names, emails, phones, addresses, account numbers, order ids, payment details
- URLs with tokens, internal agent names, ticket ids tied to real people
- Rare quasi-identifiers (specific amounts + dates + product combo)

**Replace with consistent fictitious tokens** (`CUSTOMER_A`, `ORDER_001`) across turns
so multi-turn coherence remains.

After redaction, run a **re-identification review** on a sample: could someone internal
recognise the customer from timing, product, or story? If yes, strip more or discard.

Do not use production exports in **shared eval repos** without legal/process sign-off.

## Edge-case coverage checklist

Ensure explicit cases for:

- Multi-turn clarification and correction ("no, I meant the other card")
- Language mix and code-switching
- Anger, legal threats, vulnerability signals
- Prompt injection and social engineering (in sandbox only)
- Bot should defer: no KB, account-specific, authentication required
- Long silence gaps, channel switches (email → chat references)
- Attachment references (metadata only; no real files)

**Edge cases are where production bots fail silently** — overweight them in the set
relative to volume.

## Leakage risks when generating from real transcripts

| Failure | Consequence |
| --- | --- |
| LLM paraphrase of real chat | Embeds memorised PII or rare facts |
| Few-shot examples from production | Eval set becomes training leakage |
| Synthetic "based on ticket 12345" in prompt | Identifiers slip into output |
| Shared vendor thread with raw paste | Data leaves your boundary |

Rules:

- **Do not prompt with full raw transcripts** in external models without clearance.
- **Generate structure first** (driver, turns, expected outcome), then language.
- **Scan outputs** with the same PII detectors used in production logging.
- **Keep generation prompts out of retrieval** and out of agent KB.

## Versioning and hygiene

- Store fixtures in version control with **manifest**: origin, date, language, driver.
- **Freeze eval sets**; changes are version bumps, not silent edits.
- Separate **regression tier** (incident-derived) from **exploratory** sets.
- Rotate redacted samples when retention policy expires source tickets.

## Traps

- **Synthetic only in English** when bot serves six languages.
- **Happy-path bias** — synthetic customers are too polite and too literate.
- **Duplicate near-copies** — fifty variants of the same dispute inflate scores.
- **Using synthetic for grader calibration without human review** — circular quality.

## Present results to the user

1. **Strategy** — synthetic vs redacted vs hybrid; rationale.
2. **Manifest** — count by driver, language, origin label, edge-case tags.
3. **Redaction protocol** — fields removed, token scheme, approval path.
4. **Coverage gaps** — drivers or languages underrepresented.
5. **Leakage controls** — generation environment, scanning, storage boundaries.
6. **Sample cases** — 2–3 examples with metadata (no real PII).
7. **Maintenance** — refresh cadence, versioning, and retirement rules.
