---
name: cx-customer-identity-resolution
description: Use to link one customer's conversations across channels and identifiers so per-customer support effort, repeat contact and multi-channel journeys can be measured. Trigger for "which customers contacted us on multiple channels", "how many separate tickets are actually the same person", "true contact rate per customer", stitching voice calls to email threads, or any per-customer metric where the helpdesk has no shared customer key.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: analysis
---

# Resolving customer identity across channels

This links **people**, not tickets. Deduplicating conversations that are the same
request is a different job; this one asks whether the person who called on Tuesday is
the person who emailed on Thursday, so that per-customer measures mean anything.

It matters because most per-customer CX metrics are silently wrong without it. Repeat
contact rate, first-contact resolution, cost to serve per customer, and "customers who
contacted us more than three times this month" all divide by a customer count that,
uncorrected, counts one person as three.

## The asymmetry that sets every threshold

**Merging two different customers is far worse than failing to merge one.**

A false merge puts one person's data in another person's record. Depending on what is
then done with it — a support view, an export, an at-risk list, a reply that
references the wrong history — it ranges from a bad metric to a data-protection
incident. A missed merge just leaves a metric slightly conservative.

So: **precision over recall, deliberately and explicitly.** Set thresholds so the
system under-merges, route the ambiguous middle to human review rather than resolving
it automatically, and state the direction of your remaining error when you report.

## Signals, ranked by reliability

Use them in this order, and stop as soon as a deterministic signal settles it.

| Signal | Reliability | Notes |
| --- | --- | --- |
| Authenticated account id | Highest | If the channel captures it, nothing else is needed. |
| Verified email on the account | High | Verified, not merely present in a header. |
| Phone number, normalised | Medium-high | Normalise to a canonical international format first. |
| Unverified email | Medium | Free-mail addresses are frequently shared or mistyped. |
| Name + company | Low | Never sufficient alone. |
| Device, session or cookie | Low | Shared machines and household devices. |
| Name alone | **Never** | Not a signal. Do not use it, at any confidence. |

**Deterministic first, probabilistic second.** Resolve everything you can on exact
matches of high-reliability identifiers, then apply fuzzy matching only to what remains
— and only to raise candidates for review, not to merge.

## The traps

Each of these produces confident false merges, and every one of them is common.

- **Shared and role addresses.** `support@`, `accounts@`, `info@`, `billing@` reach one
  address for many people. These are the single biggest source of catastrophic merges,
  because they are high-volume and look like a strong signal. Detect them by volume and
  by distinct-name count against the same address, and exclude them from automatic
  matching.
- **Your own staff's addresses and numbers.** Internal test accounts, agents' own
  emails, forwarded threads, and no-reply senders all accumulate into one enormous
  fake customer. Build the exclusion list before, not after.
- **Shared phone numbers.** Households, small businesses, and switchboard main lines.
  A single main number for a company is a company identifier, not a person identifier.
- **Phone normalisation.** The same number appears with and without country code, with
  spaces, dashes, parentheses, leading zeros and local trunk prefixes. Normalise to
  E.164 with a known default region before comparing, and record when you had to guess
  the region — a guessed region is a wrong number.
- **Extensions and short codes** attached to a main number.
- **Name transliteration and script.** The same person's name may appear in different
  scripts or transliterations across channels, and the same transliteration serves many
  distinct names. This makes name matching both a false-negative and a false-positive
  source, which is why it stays out of the matching logic.
- **Email plus-addressing and dots.** Provider-specific normalisation rules differ; be
  conservative, and do not apply one provider's rules to another's domain.
- **Legitimate identifier changes.** People change email addresses and phone numbers.
  A customer whose identifiers changed looks like two customers, and this is a
  *correct* conservative outcome rather than a bug — say so instead of loosening the
  rules to catch it.
- **Company versus person.** For B2B support, decide up front which grain you are
  resolving to. Many questions ("how much effort does this account cost us") want the
  company; others ("is this person contacting us repeatedly") want the person.
  Resolving to the wrong one silently answers a different question.

## Method

1. **Define the grain** — person or account — and say which.
2. **Build the exclusion list**: role addresses, internal addresses, no-reply senders,
   switchboard numbers, known test accounts.
3. **Normalise** identifiers: emails lowercased and trimmed, phones to E.164, account
   ids to a canonical form.
4. **Deterministic pass**: group on exact matches of high-reliability identifiers.
   Use transitive closure carefully — A matches B on email, B matches C on phone, so
   A, C are one person. **One bad edge merges a whole cluster**, which is why the
   exclusion list comes first. Cap cluster size and review anything unusually large;
   an oversized cluster is nearly always a shared identifier you missed.
5. **Candidate pass**: for what remains, generate candidate pairs on weaker signals and
   score them. Do not auto-merge.
6. **Three bands**: auto-merge (high confidence, deterministic), review queue
   (ambiguous), leave separate (default). Report the size of each band — the review
   queue's size determines whether this is operationally viable at all.
7. **Validate on a hand-labelled sample.** Take a sample of merges and a sample of
   near-misses, label them, and report precision and recall. Precision is the number
   that matters; quote it with an interval.

## Reporting metrics on resolved identities

- **State the resolution rate**: what share of conversations carry a usable identifier
  at all. Voice records in particular often lack one, and unresolvable conversations
  must be reported as a separate bucket rather than counted as unique customers, which
  inflates the denominator exactly where the data is weakest.
- **Give per-customer distributions, not means.** Support contact per customer is
  heavily right-skewed; the mean describes nobody. Report the distribution and the
  tail.
- **Say which direction the error runs.** With precision-first thresholds, unique
  customer counts are biased high and per-customer contact counts biased low. Anyone
  using the numbers needs to know that.

## Guardrails

- **Linking identities creates a richer personal-data record than either source held.**
  That has data-protection implications for purpose, retention and access. Flag it;
  do not decide it.
- **Never write merges back into a production system from an analysis.** Identity
  merges in a helpdesk are typically irreversible. If the output is intended to be
  applied, it becomes a reviewed mutation with a plan, a bound and an audit log — not
  a side effect of a report.
- **Do not build a cross-customer profile beyond the question asked.**
- **Report ids and aggregates, never transcripts.**
- **Do not use identity resolution to link a customer to an individual's personal
  identity outside the support relationship.**

## Present results to the user

1. **Grain and method** — person or account, which signals, which thresholds, and the
   precision-first stance.
2. **Coverage** — resolution rate, and the unresolvable bucket by channel.
3. **Band sizes** — auto-merged, queued for review, left separate.
4. **Validation** — precision and recall on the labelled sample, with sizes.
5. **Excluded identifiers**, and what they were.
6. **The metrics asked for**, as distributions, with the direction of the residual
   error stated.
7. **What is not resolvable with the data available**, and what identifier would fix
   it.
