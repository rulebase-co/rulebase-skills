# Criterion library

Starting points, not a template to adopt wholesale. Every criterion here still
has to pass the four tests (observable, controllable, decidable, discriminating)
against your own conversations, and the examples must be replaced with real quotes
from your data before graders or a model see them.

Each entry gives the decision rule and the failure mode that makes the naive
version of the criterion useless.

## Resolution

### Resolution accuracy
**Verdict:** Met | Partially met | Not met · **Evidence:** quote the resolution message

- **Met** — the stated resolution is correct and complete for the problem the
  customer actually had, and no foreseeable follow-up remains.
- **Partially met** — correct but incomplete: answers the literal question and
  leaves an obvious next question unaddressed.
- **Not met** — factually wrong, or resolves a different problem than the one raised.

> Naive version: "Did the agent resolve the issue?" This collapses agent
> performance into whether the customer's request was grantable at all. An agent
> who correctly and clearly refuses an out-of-policy refund has met this
> criterion. Grade the handling, not the outcome.

### Addressed the underlying need
**Verdict:** Met | Not met · **Evidence:** quote the customer's stated problem and the agent's response

- **Met** — the response addresses why the customer contacted, including the
  unasked question when it is evident from the message.
- **Not met** — literal answer only, where the conversation shows a broader need.

> Only include this if graders can agree on it. It has the lowest κ of any
> criterion in common use, because "underlying need" invites interpretation. Tie
> it to explicit textual evidence or leave it out.

### First-contact completeness
**Verdict:** Met | Not met · **Evidence:** cite the message requesting information

- **Met** — all information needed from the customer was requested in one message.
- **Not met** — information was requested across multiple round trips that could
  have been combined.

> A strong, highly observable criterion, and one of the few that reliably
> correlates with repeat contact.

## Accuracy and compliance

### Policy accuracy
**Verdict:** Met | Not met · **Evidence:** quote the statement and cite the policy

- **Met** — statements about policy, fees, timelines, and eligibility are correct.
- **Not met** — any incorrect statement, including a promise the business cannot keep.

> Requires a grader with access to the policy as it stood at the time. Where AI
> grading is used, the policy must be supplied in the prompt or retrieved; a model
> asked to judge policy accuracy from the transcript alone will confabulate.

### Required disclosures — AUTO-FAIL
**Verdict:** Present | Absent · **Evidence:** quote the disclosure or note its absence

Keep one auto-fail per distinct regulatory obligation rather than a combined
"compliance" criterion, so remediation routes to the right owner.

### Identity verification — AUTO-FAIL
**Verdict:** Complete | Incomplete · **Evidence:** quote the verification exchange

- **Incomplete** — account-specific information was disclosed or changes actioned
  before the required verification steps completed.

### Vulnerability and complaint recognition — AUTO-FAIL
**Verdict:** Handled | Missed · **Evidence:** quote the customer's signal

- **Missed** — the customer disclosed vulnerability, financial hardship, bereavement,
  or expressed dissatisfaction meeting your complaint definition, and the agent did
  not follow the required path.

> In regulated markets a missed complaint is a reportable failure. Never let this
> average into a percentage score.

## Communication

### Clarity
**Verdict:** Met | Not met · **Evidence:** quote the unclear passage

- **Not met** — the response relies on internal jargon, system names, or team names
  a customer would not know, without explanation.

> "Was the response clear?" is not decidable. Anchoring it to unexplained internal
> vocabulary is, and it captures most of the real problem.

### Acknowledgement before action
**Verdict:** Met | Not met · **Evidence:** quote the opening response

- **Met** — the reply names the customer's specific situation before moving to
  process.
- **Not met** — opens with process or a template with no reference to what was said.

> This is the decidable replacement for "showed empathy". Empathy criteria
> written as adjectives are the most common source of grader disagreement and of
> agent disputes. Grade the observable behaviour.

### Set accurate expectations
**Verdict:** Met | Not applicable | Not met · **Evidence:** quote the commitment

- **Met** — where the issue was unresolved at close, the agent stated what happens
  next and by when.
- **Not met** — left open with no next step or timeframe.

## Process

### Correct routing
**Verdict:** Met | Not met · **Evidence:** cite the transfer or escalation

- **Not met** — transferred to a team that could not action it, or handled
  in-queue when escalation was required.

> Only include where routing rules are documented well enough that a grader can
> check them. Otherwise this becomes a proxy for grader opinion.

### Documentation quality
**Verdict:** Met | Not met · **Evidence:** quote the notes or disposition

- **Met** — notes and disposition let the next agent continue without re-reading
  the conversation.

> Controllable and observable, but weight it low unless repeat contacts in your
> data are actually being caused by poor handovers. It is frequently over-weighted
> because it is easy to grade.

## Criteria to avoid

| Criterion | Why it fails |
| --- | --- |
| "Showed empathy" | Not decidable. Replace with acknowledgement before action. |
| "Was professional" | Bundles tone, accuracy, and process. Split or cut. |
| "Followed the script" | Measures conformity. Correlates with worse outcomes when the script is a poor fit. |
| "Resolved within SLA" | Not controllable — driven by staffing and queue. Belongs in ops reporting. |
| "Customer was satisfied" | That is CSAT. Using it as a criterion makes the scorecard a proxy for the outcome it should predict. |
| "Used the customer's name" | Not discriminating; near-100% pass. Cosmetic and easily gamed. |
| "Offered additional help" | Drives template closers that add handle time and irritate customers. |
| "Grammar and spelling" | Rarely tied to outcomes; penalises non-native speakers for something a tool should catch. |

## Channel adjustments

A rubric built for email needs explicit changes before use elsewhere.

**Chat / messaging** — concurrency makes response gaps a staffing artefact, not an
agent choice. Expect fragmented multi-message turns; criteria that assume one
complete reply will misgrade. Session boundaries are ambiguous, so define what
counts as one conversation before sampling.

**Voice** — you are grading a transcript, so diarisation errors and ASR mistakes
become grading errors. Check the transcript quality on your gold set first;
criteria depending on exact wording (disclosures) need a human check on any
auto-fail. Interruptions and hold handling are voice-specific criteria with no
email equivalent.

**Bot / automated handling** — most agent-oriented criteria do not transfer. Grade
resolution accuracy, appropriate handoff (did it escalate when it should), and
whether it claimed to resolve something it did not. See
[references/ai-grading.md](references/ai-grading.md).
