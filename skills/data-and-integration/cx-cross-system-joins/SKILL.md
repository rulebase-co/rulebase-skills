---
name: cx-cross-system-joins
description: Use to join helpdesk data to CRM, billing and product systems so a cross-system metric means something — getting the grain, keys and timing right. Trigger for "join our support data to Salesforce", "link tickets to subscriptions", "our support and billing numbers don't match", cross-system reporting, "which account does this ticket belong to", or a join that silently drops or duplicates rows.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: analysis
---

# Joining support data to other systems

Most interesting CX questions need two systems. Cost to serve needs billing. Churn signal
needs subscriptions. Onboarding friction needs product usage. Revenue at risk needs the
ledger.

This is about joining the **systems** — grain, keys, timing, history. Matching a *person*
across channels when there is no shared key is a different problem with a different failure
mode, and it should be solved first if your helpdesk does not carry a reliable account
identifier.

**A cross-system join fails silently in both directions**: an inner join drops rows nobody
counted, and a one-to-many join duplicates rows nobody noticed. Both produce a number that
looks reasonable.

## Establish the grain on both sides, then say what the join produces

Write it down before writing SQL:

```
conversations       one row per conversation
accounts            one row per account
subscriptions       one row per (account, subscription) — an account can have several
invoices            one row per (account, period)
usage_daily         one row per (account, day)
```

Then state the join's output grain. Joining conversations to subscriptions gives one row per
(conversation, subscription) — so counting conversations after that join over-counts by the
number of subscriptions per account. **Aggregate the many side to the join grain first**, or
count distinct on the side you care about.

The tell-tale symptom is a total that rises when you add a dimension. If it does, the join
fanned out.

## Pick the key deliberately

In descending order of reliability:

1. **A shared account or customer id** propagated into the helpdesk at integration time. If
   present, use it and stop.
2. **An external id** the helpdesk stores for the CRM record.
3. **Verified email on the account**, not the email in the message header.
4. **Domain**, for B2B — which maps many people to one account and is therefore a
   one-to-many key, not an identity key.
5. **Normalised phone.**
6. **Name and company** — not a key. Do not join on it.

Two rules that prevent most damage:

- **Never join on an unverified email**, and never on a free-mail address as an account key.
  Shared and role addresses (`support@`, `accounts@`, `billing@`) map many customers onto one
  account and are the most common source of a catastrophic mis-join.
- **Exclude your own staff addresses and domains** before joining. Internal test accounts,
  forwarded threads and agent addresses accumulate into one enormous fake account.

## Timing is the trap that produces defensible wrong answers

Support data is mutable and other systems are historical. A naive join takes today's state
and applies it to last year's conversation.

- **A conversation from January belonged to whatever plan, tier and owner the account had in
  January.** Joining to the current subscription row attributes it to today's plan, which
  quietly rewrites history — and it always makes the current plan look worse or better than it
  was.
- **Use as-of joins** where the other system keeps history: pick the dimension row valid at the
  conversation's event time. If the other system does not keep history, say so, and say that
  the join is current-state only.
- **Accounts move.** Renames, merges, hierarchy changes, and re-parenting. A join through a
  hierarchy needs the hierarchy as of the event date too.
- **Use event time, not ingest time.** Backfills make these diverge by months, and an
  as-of join on ingest time is wrong in an invisible way.

## Decide the person-versus-account grain explicitly

For B2B this is the most consequential modelling choice, and it silently answers a different
question if you get it wrong:

- **"How much support effort does this account consume"** wants the account.
- **"Is this person contacting us repeatedly"** wants the person.
- **"Is our champion having a bad time"** wants the person *and* their role in the account.

State which one the analysis uses, and be careful about the hierarchy: a parent-level metric
that sums children double-counts anything attached at both levels.

## Report join quality as part of the result

The number nobody publishes and everybody should:

- **Match rate**, per side. What share of conversations resolved to an account, and what share
  of accounts have any conversations.
- **The unmatched population, characterised.** Not just its size. Unmatched conversations
  cluster — a channel that does not capture the identifier, a market, a self-serve segment —
  and **that clustering biases every cross-system metric in a specific direction.** Voice
  records in particular often carry no account id, so a cost-to-serve join can silently
  exclude the most expensive channel.
- **Fan-out**, measured: rows before and after the join.
- **Duplicate keys** on the supposedly-unique side.

State the direction of the residual error. If unmatched conversations skew toward self-serve
customers, every per-account metric is biased toward enterprise.

## Practical checks before trusting a join

- **Count rows before and after.** Any change that is not the change you intended is a bug.
- **Compare a known account by hand** against both source systems.
- **Check a total against each source's own figure.** If support says 40,000 conversations and
  the joined model says 31,000, the 9,000 are the finding.
- **Look for exactly-zero results.** A plausible filter returning nothing usually means a
  broken join, not an empty population — particularly where a duplicate or merge pointer is
  involved.
- **Test the as-of join on an account that changed plan** mid-period, and confirm the
  conversations either side land on the right plan.

## Guardrails

- **Joining support, CRM, billing and product data creates a personal-data profile none of the
  sources held.** That has purpose, retention and access implications. Flag it; do not decide
  it.
- **Do not build the join wider than the question.** A model that links everything to everything
  is a standing privacy exposure and it invites analyses nobody assessed.
- **Never propagate an unverified match into a production system.** An analysis can tolerate a
  wrong join; writing a wrong account link back into a helpdesk puts one customer's context on
  another's record.
- **Do not use a joined model to differentiate service by revenue** in a way you could not
  defend.
- **Report ids and aggregates.** Do not move message content into a joined model that a wider
  audience can read.

## Present results to the user

1. **The grain of every table, and the grain the join produces**, with the collapse applied
   before any count.
2. **The key used**, and the exclusions applied — role addresses, internal domains, free-mail.
3. **Timing** — as-of or current-state, on event time, and what the other system does not keep
   history for.
4. **Person or account grain**, named, with the hierarchy double-count check.
5. **Join quality** — match rate both ways, the unmatched population *characterised*, fan-out
   measured, duplicate keys.
6. **The direction of the residual bias**, stated plainly.
7. **Reconciliation** against each source's own totals, with the gap explained.
8. **The privacy question routed**, not resolved.
