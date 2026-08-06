---
name: cx-policy-practice-divergence
description: Use to check whether what agents actually tell customers matches documented policy, across every conversation where a topic came up. Trigger for "did we give customers the wrong information about X", "are we answering this consistently", "find every instance where agents said X", "check our answers against the knowledge base", answer-consistency audits, or a complaint that hinges on what a customer was told.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: analysis
---

# Policy versus practice

The question is whether the answer customers receive is the answer the company
intends. It is asked in two situations: a specific complaint where someone may have
been misinformed, and a proactive audit of a topic that matters.

The analysis fails in a specific way if you are not careful, and the failure
manufactures violations that do not exist. See step 2.

## Four outcomes, not two

For each conversation where the topic arose, classify what the agent asserted:

| Outcome | Meaning | Owner |
| --- | --- | --- |
| **Matches** | The answer given agrees with documented policy | — |
| **Contradicts** | The answer given conflicts with documented policy | Compliance / QA |
| **Policy silent** | There is no documented answer; the agent improvised | Knowledge / policy owner |
| **No answer given** | The topic arose and was deflected, escalated, or ignored | Process / training |

**"Policy silent" is usually the largest bucket and the most actionable finding**,
and an audit framed as pass/fail never surfaces it. When six agents give six
different reasonable answers to the same question, nobody has done anything wrong —
the documentation has a hole, and every one of those answers is a future complaint.
Report it as a documentation gap with the specific question that needs an answer.

The distinction between "contradicts" and "policy silent" decides who owns the fix,
so make it deliberately rather than defaulting everything to a coaching finding.

## Step 1: define the claim precisely

An audit of "wire instructions" is unrunnable. An audit of "whether customers were
told that an intermediary bank fee may be deducted" is runnable.

Write the claim as a single testable assertion, then write down what the documented
answer to it is, with a citation to the specific policy or knowledge-base document
and its version. If you cannot find a documented answer, you have already found the
most important thing — stop and report that rather than inventing a standard to
audit against.

## Step 2: compare against the policy in force at the time

**This is the trap.** Policies change. Comparing eight months of conversations
against today's knowledge base will produce a large pile of "contradictions" that
were correct answers when they were given.

So:

- **Establish the policy timeline first** — when the documented answer changed, and
  what it was before. Document history, changelogs and the knowledge base's own
  revision dates are the sources.
- **Bucket conversations by the policy version in force on their date.**
- **Where you cannot date the policy, say so and do not classify contradictions.**
  Report the conversations as unclassifiable. An undated audit is not evidence.

A change in the documented answer with no communication to the team is itself a
finding, and it usually explains a cluster of "contradictions" that all fall in the
same fortnight.

## Step 3: find the population, and report your recall

For a compliance question you need **every** conversation where the topic arose, not
a random sample. That makes retrieval the weak link, and an audit that does not
report its own recall is not auditable.

- **Search several ways.** Keyword and phrase variants, the product or feature name,
  tags and categories, the knowledge-base article's own vocabulary, and semantic
  search if available. Customers and agents do not use your internal terms.
- **Search in every language your team works in.** A single-language sweep of a
  multilingual operation misses whole markets and will read as a clean result.
- **Estimate recall.** Take a sample of conversations you did *not* retrieve, from a
  plausible neighbourhood, and check how many should have been. Report the estimate.
  "We found 34 instances" and "we found 34 of an estimated 40–50" are different
  claims.
- **State the window** and why it was chosen.

## Step 4: evidence standard

- **Read the conversation. Never classify from an evaluation summary or a search
  snippet.** A summary that says the agent explained the fee policy is not evidence
  of what the agent said.
- **Quote the specific assertion**, with conversation id, timestamp, author, and
  channel. A contradiction claim without the sentence that contradicts is an
  allegation.
- **Check who was speaking.** An automated reply is not an agent giving advice, and a
  bot contradicting policy is a configuration finding with a completely different
  owner and remedy. Verify author type rather than assuming.
- **Distinguish an incorrect statement from an incomplete one.** "You'll receive the
  funds in two days" when policy says two to five is not the same failure as
  quoting the wrong fee, and conflating them inflates the finding.
- **Look for the correction.** An agent who misspoke and corrected it in the next
  message has not misinformed the customer. Read the whole thread before classifying.

## Consistency and correctness are different measurements

Report both, because they have different remedies:

- **Consistency** — do agents give the same answer as each other? Low consistency
  means the answer is not discoverable, whatever the policy says.
- **Correctness** — does the answer match policy? A team can be perfectly consistent
  and uniformly wrong, which happens when a stale macro or a widely shared internal
  note is the real source of truth.

If consistency is high and correctness is low, look for the shared wrong source — a
macro, a pinned message, a training deck, an outdated article that ranks first in
search. That artefact is the fix, and coaching individuals will not work.

## When the finding is a compliance matter

If the topic is regulated — funds availability, disclosures, complaint handling,
credit decisions, data rights — a confirmed contradiction is not a coaching note.
It has a reporting obligation and a timeline that you do not get to set.

Escalate it as a finding with the evidence attached, name the affected customers by
id, and say plainly that remediation and any regulatory notification are decisions
for compliance and legal. Do not assess the regulatory consequence yourself, and do
not soften the finding because the volume is small.

## Present results to the user

1. **The claim**, as one testable assertion, and the documented answer with its
   citation and version.
2. **The policy timeline**, if the documented answer changed inside the window.
3. **Retrieval** — how you searched, how many conversations you found, your recall
   estimate, and the languages covered.
4. **The four-way classification**, with counts, and conversation ids under each.
5. **Consistency and correctness**, separately.
6. **The shared wrong source**, if consistency is high and correctness is not.
7. **Findings by owner** — compliance, knowledge, process, training — because these
   go to different people.
8. **What you could not classify**, and why. Undated policy, unretrievable
   transcripts, languages you cannot assess.

Cite ids. Keep quoted material to the minimum that supports the finding, and redact
customer details. Do not paste transcripts into chat.
