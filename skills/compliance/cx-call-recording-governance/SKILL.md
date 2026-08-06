---
name: cx-call-recording-governance
description: Use to review how call recordings are notified, stored, accessed, redacted and deleted, including the parts that differ from text conversations. Trigger for "review our call recording practices", "do we need to tell customers we're recording", "who can listen to our calls", recording retention, card details spoken on a call, or a request for a customer's own recording.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: analysis
---

# Call recording governance

Recordings are the highest-risk data a support operation holds and the least governed,
because they usually live in the telephony system rather than the helpdesk — owned by a
different team, with its own retention, its own access model, and frequently outside every
review that covers "support data".

Everything in this skill is a consequence of one fact: **a recording cannot be
selectively edited the way text can.** Redaction, minimisation and partial disclosure all
work differently, and most text-derived policies do not transfer.

Requirements vary by jurisdiction — notification, consent, and whether all parties must
agree all differ. **Nothing here states a legal requirement.** This is the operational
review; the determination is legal's.

## Notification and consent

- **Before recording starts.** A notification played after the recording begins has not
  notified anyone about the part already captured. Check the sequence in the system
  configuration, not just the script.
- **On every path.** Inbound, outbound, callbacks, transfers, conferences, voicemail, and
  calls that begin as something else. **Transfers and conferences are the routine gap** —
  a customer notified once at the start may be joined later by a third party under a
  different arrangement.
- **Outbound calls** need their own handling, and the notification cannot be assumed from an
  inbound script.
- **Agent-side recording of their own screen or voice** is employee monitoring with its own
  requirements.
- **Where an opt-out exists**, test that it works and that the call proceeds without
  degradation. An opt-out that ends the call is not an opt-out.
- **Recording resumed after a pause** — for card entry, typically — needs the pause to have
  actually stopped capture, not merely muted a monitor. Test this specifically; it is
  frequently assumed and occasionally false.

## What is on the recording that should not be

Callers say things nobody intended to capture:

- **Card numbers, CVVs and security answers**, read aloud. If your pause-and-resume is
  configured wrongly, or an agent forgets, this is stored card data in an audio file — and
  it lands inside payment-security scope, which changes who needs to be involved.
- **Health information and vulnerability disclosures**, volunteered.
- **Third parties in the background** — a family member, a colleague, a child.
- **Other customers**, where an agent is on a shared floor.
- **The agent's own personal information**, in an aside.

Automated detection of spoken sensitive data is imperfect. **Sample-review rather than
relying on a detector**, and report what you found as an estimate with its method, not as a
count.

## Redaction is genuinely harder here

- **Text redaction is well-understood; audio redaction is not.** Where a segment must be
  removed, the practical options are muting the segment or discarding the recording and
  keeping a redacted transcript. Both lose something.
- **A transcript is not a substitute** for a recording where tone matters — a complaint about
  how something was said cannot be assessed from text.
- **Redaction breaks reconstructability.** If a QA assessment was based on audio that has
  since been redacted, the assessment can no longer be explained. This tension is real;
  it should be a recorded decision rather than an accidental outcome.
- **Check whether redaction propagated** to the transcript, the QA record, any derived
  summary, and any index built from it. Muting audio and leaving the transcript intact is
  the common failure.

## Access

Recordings get listened to by more people than anyone expects:

- **Enumerate who can access them** — QA, team leads, training, workforce management,
  vendors, and whoever holds admin in the telephony platform.
- **Is access logged, and does anyone review the log?** Unreviewed access logging provides
  no assurance.
- **Can recordings be downloaded?** A downloaded recording leaves every control you have.
  Check whether the platform permits it and who used it.
- **Are recordings used for training material?** That is a further purpose, likely needing
  its own basis and probably consent.
- **Vendor access**, including from other countries — a transfer whether or not a system is
  involved.

## Retention, which is usually wrong

- **Recordings have their own retention setting**, set by the telephony team, frequently
  inconsistent with the helpdesk's. Compare them directly; a mismatch is one of the most
  common findings.
- **Transcripts often outlive the audio**, or the reverse. Both are problems: audio deleted
  with the transcript retained may leave you unable to verify a disputed transcript, and the
  transcript is still personal data.
- **Check deletion actually runs** and propagates to transcripts, derived summaries, QA
  records and backups.
- **Longer retention to feed an AI model** is a purpose change, not a technical detail, and
  it needs a decision rather than a configuration edit.

## Customer requests for their own recording

A recurring, awkward request:

- **The recording contains the agent's voice**, which is the agent's personal data. Whether
  it is disclosed, and in what form, is a balancing judgement for legal — flag it, do not
  decide it.
- **Third-party voices** need the same treatment, with less room for disclosure.
- **A transcript with redactions is frequently the practical answer**, and that is a decision
  to record rather than a shortcut to apply quietly.
- **Do not delete a requested recording**, including under scheduled retention, once a
  request is received.

## Guardrails

- **Do not state the legal requirement** for notification or consent. It varies materially
  by jurisdiction and by who is on the call.
- **Spoken card data is a payment-security matter**, not only a privacy one. It brings in a
  different control framework and a different set of people. Escalate rather than filing it
  as a data-protection finding.
- **Read-only.** Do not delete recordings; deletion is irreversible and may destroy evidence
  under hold.
- **Do not listen to recordings beyond the sample the review needs**, and do not transcribe
  sensitive content into the report.
- **Do not include recording excerpts or transcript quotes** in the output. Cite call ids.
- **A finding that recording occurred without notification** is potentially a live incident
  affecting every call on that path. Escalate immediately with the affected volume and date
  range.

## Present results to the user

1. **Notification and consent by path** — inbound, outbound, callback, transfer, conference,
   voicemail — configuration-verified rather than script-assumed.
2. **Pause-and-resume**, tested rather than assumed, with the card-data implication stated.
3. **Sensitive content estimate** from a sampled review, with the method and its limits.
4. **Redaction capability and propagation** across audio, transcript, QA record, summaries
   and indexes.
5. **Access** — who, whether logged, whether reviewed, downloadability, vendor and
   cross-border access.
6. **Retention** — recordings against transcripts against the helpdesk, with mismatches, and
   whether deletion runs and propagates.
7. **Further purposes** — training material, AI training — and whether each has a decision
   behind it.
8. **Customer-request handling**, with the agent-voice question routed to legal.
9. **Anything to escalate now** — unnotified recording, spoken card data — separated from the
   review findings.
