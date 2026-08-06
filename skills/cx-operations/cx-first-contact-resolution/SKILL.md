---
name: cx-first-contact-resolution
description: Use to measure first contact resolution and repeat contact rate defensibly, from conversation data rather than from agent-set dispositions. Trigger for "what's our FCR", "how many customers come back", "repeat contact rate", "are we resolving issues first time", one-and-done rate, or an FCR number that looks implausibly high.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: analysis
---

# First contact resolution

FCR is the most widely reported CX metric that is most often measured in a way that
cannot be wrong. If the agent who handled the contact is the one who marks it
resolved, the metric measures agent optimism, and it will sit reassuringly in the high
eighties forever.

The defensible version inverts it: **measure repeat contact, and derive FCR from
that.** A contact was resolved first time if the customer did not come back about the
same thing.

## Why the common definitions fail

- **Agent disposition.** Self-reported, unfalsifiable, and directly incentivised if it
  is on a dashboard. Not a measurement.
- **"Ticket closed without reopening."** Measures your reopen policy. Most helpdesks
  auto-close after a few days and force a new ticket after that, so the customer coming
  back looks like a brand-new contact and FCR stays high by construction.
- **Survey question ("was your issue resolved?").** Better, but it inherits the survey's
  response bias, and it is answered before the customer has discovered the issue is not
  actually fixed.
- **One-ticket-per-customer counting.** Breaks completely without identity resolution
  across channels: a customer who emails then calls counts as two resolved contacts.

## The defensible definition

> **Repeat contact rate** = the share of contacts followed by another contact **from
> the same customer**, **about the same issue**, within a defined window.
>
> **FCR** = 1 − repeat contact rate.

Four parameters, and every one of them has to be declared for the number to mean
anything:

**1. Same customer.** Requires identity resolution across channels. Without it you
undercount repeats badly, and you undercount them most in exactly the operations with
the worst channel-switching problem. If you cannot resolve identity, say the metric is
channel-local and do not present it as an organisation-wide FCR.

**2. Same issue.** The hard one. Options, in increasing order of quality:

- *Any repeat contact* — simple, and it penalises a customer with two unrelated
  problems. Usable as a bound, not as the metric.
- *Same category or intent* — reasonable, but only as good as your taxonomy, and it
  breaks when the repeat is categorised differently precisely because it was
  mishandled.
- *Semantic similarity of the customer's own words* — usually the best available, with
  a threshold validated by hand-labelling.

Whatever you choose, **hand-label a sample and report the accuracy of the same-issue
judgement.** It is the largest source of error in the metric.

**3. The window.** Convention is 7 days; 24–72 hours is common for high-velocity
consumer support. The choice is not neutral: a longer window catches slow-burning
failures and also catches genuinely new problems. Report the metric at two windows so
the reader can see the sensitivity, and never compare an FCR at 7 days to one at 24
hours.

**4. Which contact anchors it.** Measure forward from the *first* contact in a cluster,
not from every contact, or a customer who contacts five times contributes four repeats
and distorts everything.

## Censoring, again

Contacts near the end of your window have not had a full repeat window to be followed
up in. Including them inflates FCR, because they cannot yet have a repeat.

**Truncate the analysis window by the repeat window.** For 7-day FCR over a month, only
contacts from the first 23 days are eligible. Say you did this, and say how many
contacts it excluded. This is the single most common arithmetic error in an FCR
calculation and it always biases the number upward.

## What it does and does not tell you

**A high FCR is not automatically good.** It rises when customers give up, when a
channel is hard to reach, and when the first contact deflects rather than resolves. It
falls when you make it easier to come back. Read it alongside abandonment, channel
accessibility, and CSAT rather than alone.

**Do not rank agents on raw FCR.** Repeat contact is driven mostly by contact reason,
product area and customer, and only marginally by the agent. An agent handling
account-closure requests will have a worse FCR than one handling password resets, and
the ranking mostly re-reports the queue assignment. If you must compare people,
restrict to like-for-like work and report the interval.

**FCR is most useful segmented by contact driver.** The organisation-wide number moves
slowly and says nothing actionable. "Card disputes have a 41% repeat rate" names a
process to fix, and that is what the metric is for.

## Traps

- **Transfers and internal handoffs are not repeat contacts.** One customer contact
  handled by three people is still one contact. Count customer-initiated contacts only.
- **Automated and notification traffic** inflates both numerator and denominator.
  Exclude it and report the rule.
- **A repeat on a *different* issue is not a failure**, unless your same-issue test is
  too loose — which is exactly what the hand-labelled accuracy check catches.
- **Proactive outbound contact** is not a customer repeat.
- **Bot-then-human is one contact**, not a repeat, unless the customer came back later.
- **Channel-switch repeats are the most important ones** and the easiest to miss. A
  customer who chats, fails, then calls is the clearest possible resolution failure and
  it is invisible without identity resolution.

## Present results to the user

1. **The four parameters** — identity basis, same-issue test, window, anchoring — before
   the number.
2. **Same-issue accuracy** from the hand-labelled sample, with the sample size.
3. **The rate**, at two windows, with the denominator and the truncation applied.
4. **By contact driver**, ranked by repeat volume rather than by rate — this is the
   actionable output.
5. **By channel**, including channel-switch repeats called out separately.
6. **Countervailing metrics** — abandonment and accessibility — so a high FCR is not
   read as unambiguously good.
7. **What you excluded**, and what the metric cannot support (in particular, agent
   ranking).
