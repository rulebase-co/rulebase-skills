---
name: cx-regulated-advice-boundary
description: Use to find where support agents cross from information into regulated advice or a personal recommendation, and to design the boundary so they can still be helpful. Trigger for "are agents giving advice", "where's the line between information and advice", "should agents recommend a product", guidance versus advice boundary, agents answering "what would you do", or a complaint that an agent recommended something.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: analysis
---

# The information / advice boundary

In several regulated sectors, giving a personal recommendation is an activity you need
permission for, delivered by qualified people through a defined process. Support agents
usually have none of those things — and customers ask them for advice constantly, in the
most natural way possible: *"what would you do?"*

The boundary is genuinely hard, so agents improvise. Some become unhelpfully evasive,
refusing to answer factual questions in case they stray; others cross the line trying to
be kind. Both are failures, and the second is the one with a regulatory consequence.

**Where exactly the line sits is a legal and compliance determination and it differs by
jurisdiction, sector and product. Nothing here states it.** This finds where agents are
near it, in what direction they err, and what would help.

## Get the definition before looking at anything

Ask compliance for the boundary as it applies to your products, and get it as testable
criteria rather than principles. Typically the distinguishing features are whether the
statement is **personal to the customer's circumstances** and whether it constitutes a
**recommendation to act**. General factual information about how a product works usually
sits on the safe side.

Without a written boundary you cannot audit against one — and if there is not one, that is
the finding. Agents cannot be expected to hold a line nobody has drawn, and every
subsequent conversation about individual performance is unfair.

## The four zones

Classify what agents actually said, because the middle two are where the work is:

- **Factual information.** How the product works, what the terms say, what the options are.
  Safe, and the majority.
- **Generic guidance.** Explaining considerations without applying them to this customer.
  Usually safe and often the most useful thing an agent can do — this is the zone to expand.
- **Implied recommendation.** No explicit advice, but the framing points at one: "most
  people in your situation choose X", "I'd probably go with the second one", selectively
  presenting one option's benefits. **The largest and least-recognised risk category**,
  because the agent does not experience it as advice.
- **Explicit personal recommendation.** "You should switch to X." The obvious breach, and
  the rarest.

Report the distribution. A programme that only looks for the fourth category will find
almost nothing and conclude everything is fine.

## Where to look

The high-yield conversations:

- **Direct requests** — "what would you do", "which is better for me", "what do you
  recommend", "would you switch". Search these phrasings in every language, and read what
  the agent said next.
- **Product comparison questions**, where the pull toward a recommendation is strongest.
- **Customers describing their circumstances** and asking an open question.
- **Financial-difficulty conversations**, where the temptation to suggest a course of action
  is high and the consequences are largest.
- **Cancellation and switching conversations**, where a retention motive adds pressure to
  recommend staying.
- **Conversations after a loss or a bad outcome**, where the agent is trying to console.

Two structural signals worth measuring, which need no language analysis:

- **Conversations where the customer asked for a recommendation and got a substantive
  answer** rather than a referral, measured as a rate.
- **Referral rate to the advised channel**, where one exists. A referral rate near zero on a
  product that generates advice-seeking questions means the boundary is being handled
  somewhere other than the referral.

## Look for over-caution too

An audit that only counts crossings will drive agents further into evasiveness, which is
its own harm and generates its own complaints:

- **Refusing to answer factual questions**, on the grounds that anything might be advice.
- **Reading terms verbatim** instead of explaining them.
- **Referring everything**, including questions the agent could and should answer.
- **Customers contacting repeatedly** because they never got a usable answer — check
  repeat-contact rate on advice-adjacent topics.

**Report both directions, and give the over-caution rate equal prominence.** The useful
outcome is agents who are confident about the wide zone where they can be genuinely
helpful, not agents who are frightened.

## The fix is usually a script, not training

Where agents cross the line, look at what they had to work with:

- **Is there an approved way to answer the common advice-seeking questions?** If not, agents
  will invent one, and they will invent it differently each time.
- **Is there a referral route, and does it work?** A boundary with no onward path forces the
  agent to choose between crossing it and abandoning the customer. Most will choose the
  customer.
- **Do the macros and knowledge articles model the right behaviour?** A macro containing an
  implied recommendation puts it into thousands of conversations, and it is a single fix.
- **Do the incentives push across the line?** A retention or conversion target on a
  product-related conversation produces recommendations reliably, from ordinary people.
  Check this before concluding anything about individuals.

Give agents the language for the guidance zone. Most crossings come from not having a good
way to be helpful, not from a desire to advise.

## Guardrails

- **Do not state where the regulatory line sits.** Use the definition compliance provides,
  and if there is not one, that is the primary finding.
- **Do not conclude that a specific statement was regulated advice.** Flag candidates with
  the evidence; the characterisation is compliance and legal's, and it may be a reportable
  matter with its own clock.
- **Do not turn this into individual performance management** without first checking the
  script, the macros, the referral route and the incentives. A pattern across several agents
  is systemic by definition.
- **Where a crossing may have caused customer detriment** — someone acted on it and lost out —
  that is an escalation, not an audit finding.
- **Cite ids and quote only the specific statement** at issue. These reviews reach compliance
  and sometimes regulators.

## Present results to the user

1. **The boundary definition used, and its source.** If none exists, say so first — it is
   the finding that has to be fixed before the rest means anything.
2. **The four-zone distribution**, with implied recommendations called out as the category
   most likely to be under-counted.
3. **Both error directions**, with the over-caution rate given equal weight, plus
   repeat-contact evidence on advice-adjacent topics.
4. **The structural measures** — substantive-answer rate on recommendation requests, and
   referral rate to the advised channel.
5. **Where the crossings cluster** — product, channel, market, conversation type.
6. **What agents had to work with** — approved answers, referral route, macros, incentives —
   with the systemic causes named before any individual pattern.
7. **Candidate crossings for compliance to characterise**, with evidence, separated from the
   general findings.
8. **Anything requiring immediate escalation** where a customer may have acted on it.
