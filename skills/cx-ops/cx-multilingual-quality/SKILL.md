---
name: cx-multilingual-quality
description: Use to measure and compare support quality across languages and markets without penalising agents for the instrument being weaker in their language. Trigger for "compare quality across markets", "our Dutch team scores lower", "quality by language", grading conversations in a language the reviewer doesn't speak, machine-translated QA, or setting up QA for a new market.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: analysis
---

# Quality across languages

Multilingual support quality data has a structural problem: **the measurement is
usually weaker in exactly the languages that score worse**, so a real difference and a
measurement artefact look identical in the output.

Getting this wrong has consequences beyond a bad number. Scores drive coaching, ranking
and sometimes pay, so a systematically harsher instrument in one language is
discrimination by mechanism rather than by intent.

## Establish instrument parity before comparing anything

Do this first. If it fails, the comparison does not happen.

**1. Who is grading, and can they read it?** A reviewer grading a language they do not
speak is assessing structure and process, not communication. That is a legitimate
partial evaluation — but only if the language-dependent criteria are excluded rather
than guessed at.

**2. Is machine translation in the loop?** Grading a translation grades the translator.
Translation flattens register, loses idiom, and silently repairs grammatical errors —
so tone and clarity criteria applied to translated text measure the translation engine.
**Never grade a tone, empathy, grammar or clarity criterion from a translation.** If
translation is unavoidable, mark those criteria not-assessed and say so.

**3. What is grader agreement, per language?** This is the decisive check. If agreement
is materially lower in one language, the instrument is less reliable there and its
scores are not comparable. Report agreement per language beside every per-language
score.

**4. Voice adds a second layer.** Speech recognition quality varies by language, by
accent within a language, and by audio conditions — and recognition errors track accent
directly. Voice QA in a language with weaker recognition support is measuring the
recogniser. Check transcription quality per language before grading, and treat criteria
that depend on exact wording as unavailable where it is poor.

## Separate the four things that produce a language gap

When a market scores lower, it is one or more of these. They have entirely different
remedies and the analysis has to distinguish them:

- **Instrument** — grading is less reliable or less possible in that language.
- **Mix** — that market handles a different contact mix, or a different channel mix.
  Frequently the whole gap; check it before anything else.
- **Rubric fit** — the criterion encodes a convention that does not transfer.
  Directness reads as rude in some cultures and as efficient in others; formality
  conventions differ sharply; some languages have formal/informal registers with no
  English equivalent and a rubric written in English simply has no rule for them.
- **Genuine capability** — training, staffing, tenure, documentation coverage in that
  language.

**Rubric fit is the one most often mistaken for capability.** A tone criterion written
against one market's norms will mark down every market with different norms, uniformly
and forever. The signal is a whole-market offset on specific criteria while others are
level — check criterion-level gaps, not just overall scores.

## Check the supporting material, not just the agents

A market scoring low very often has less to work with:

- **Knowledge-base coverage in that language**, and whether translations are current.
  Agents working from stale translated articles will give stale answers.
- **Macros and templates**, and whether they were translated well or at all.
- **Training material** availability.
- **Escalation paths** staffed in that language and timezone.

Quantify the gap. "The Dutch team scores 6 points lower and has 40% of the knowledge
base available in Dutch" is a resourcing finding, and it will not be fixed by coaching.

## Measuring, in practice

- **Report per-language scores with per-language agreement**, always paired. A score
  without its reliability is not interpretable here.
- **Compare within contact driver and channel**, not across whole markets.
- **State which criteria were assessed** per language, and which were excluded as
  unassessable. A market graded on eight criteria and another on twelve are not
  comparable, and this is a common silent difference.
- **Do not aggregate a global quality score across languages** with materially different
  instrument reliability. Report per-market, and if a single number is demanded, say
  what it hides.
- **Small markets have small samples.** Suppress and do not rank.

## Improving it

- **Grade in-language wherever possible.** A bilingual reviewer beats every workaround.
- **If using an AI grader, validate it per language** against in-language human
  reviewers before trusting it. Model capability differs substantially across languages,
  and per-language validation is the only way to know where it holds.
- **Write criteria so they transfer** — behaviour and outcome rather than phrasing.
  "Acknowledged the customer's deadline" transfers; "used warm, conversational language"
  does not.
- **Localise the rubric where the convention genuinely differs**, and record it as a
  scoped variant rather than an exception, so scores stay explainable.
- **Never coach an agent on phrasing in a language the coach cannot assess.** Route it
  to someone who can, or leave it.

## Present results to the user

1. **Instrument parity**, first — grader language coverage, translation in the loop,
   agreement per language, transcription quality for voice. If parity fails, say the
   comparison is not valid and stop.
2. **Which criteria were assessed per language**, and which were excluded.
3. **Mix comparison** across markets, before any performance claim.
4. **Per-language results within comparable strata**, with agreement and intervals
   alongside.
5. **Criterion-level gaps**, to separate a rubric-fit problem from a capability one.
6. **Supporting-material gaps** — knowledge base, macros, training, escalation coverage
   per language — quantified.
7. **What is not comparable**, and what would make it so.
