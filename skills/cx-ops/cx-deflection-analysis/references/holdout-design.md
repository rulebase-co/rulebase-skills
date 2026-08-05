# Holdout design for automation impact

Containment describes what happened to sessions that occurred. It cannot tell you
whether the automation reduced total contact volume, because it has no
counterfactual: some contained sessions would never have become human contacts,
and that fraction is unobservable in historical data.

A holdout supplies the counterfactual.

## The design

Randomly assign a share of **eligible traffic** to a control arm that goes
straight to humans. Both arms then run concurrently under the same conditions.

**Randomise on customer, not on session.** Randomising per session lets the same
customer land in both arms, which contaminates the comparison and breaks the
primary metric below. Hash the stable customer id into buckets and keep the
assignment fixed for the whole experiment.

**Define eligibility explicitly and identically for both arms.** Eligibility is
whatever the bot would normally handle: channel, business hours, language,
intent scope. Anything the bot never sees must be excluded from both arms, or the
control arm carries volume the treatment arm never had a chance at.

**Primary metric: human contacts per assigned customer per period.** Not
containment, not deflection, not ticket count. Per-customer normalisation is what
makes leakage, channel switching, and return contacts all fall out automatically
— a customer who bounced from bot to phone contributes one human contact either
way, so the metric cannot be gamed by moving work between channels.

**Secondary metrics**, all per assigned customer:

- Resolution time end to end, first contact to final resolution
- CSAT, and DSAT rate specifically
- Repeat contact rate within the window
- Cost per assigned customer, using marginal cost
- Escalation and complaint rate

Watch the secondaries as guardrails. A volume reduction bought with a materially
worse resolution time or DSAT rate is not a win, and this design is the only one
that surfaces the trade cleanly.

## Sizing

For a two-proportion test on the share of assigned customers who reach a human,
at 95% confidence and 80% power:

| Baseline | Target | Absolute change | n per arm |
| --- | --- | --- | --- |
| 30% | 27% | 3 pp | 3,550 |
| 30% | 25% | 5 pp | 1,248 |
| 30% | 20% | 10 pp | 290 |
| 40% | 35% | 5 pp | 1,468 |
| 40% | 30% | 10 pp | 353 |
| 20% | 18% | 2 pp | 6,036 |
| 20% | 16% | 4 pp | 1,444 |

A relative 10% reduction, which is a realistic target for a mature bot, is
expensive to detect:

| Baseline | −10% relative | n per arm |
| --- | --- | --- |
| 15% | 13.5% | 8,521 |
| 20% | 18.0% | 6,036 |
| 30% | 27.0% | 3,550 |
| 40% | 36.0% | 2,308 |
| 50% | 45.0% | 1,562 |

```python
def n_per_arm(p1, p2, z_alpha=1.96, z_beta=0.8416):
    """Customers per arm for a two-proportion test at 95% conf / 80% power."""
    return ((z_alpha + z_beta) ** 2
            * (p1 * (1 - p1) + p2 * (1 - p2))
            / (p1 - p2) ** 2)
```

Two adjustments to make before quoting a duration:

- **`n` is customers, not sessions.** Convert using your own customers-per-period
  rate, and remember the control arm accrues at the holdout percentage.
- **Contacts per customer is over-dispersed.** A small number of customers contact
  many times, so the variance is well above the binomial assumption if you use the
  count rather than the binary "reached a human". Either use the binary primary
  metric above, or estimate the variance from your own history and size on that.

**Duration.** Run at least two full weekly cycles regardless of what the power
calculation permits, so weekday/weekend and payday-cycle effects are covered. Never
stop early because the result looks good; fix the end date before launch.

## Holdout size

A 5–10% holdout is the usual compromise. Smaller holdouts sound cheaper but the
control arm is the binding constraint on power — a 2% holdout can make the
experiment take five times as long as a 10% one, during which the bot's behaviour
will have changed anyway and the result is stale.

The honest framing for stakeholders: the holdout is not a cost, it is the only
mechanism that lets you state a savings number without an asterisk.

## Ethics and risk

- Holdout customers get a human, which is a better experience, not a worse one.
  This is an unusually easy experiment to justify.
- Exclude vulnerable-customer, complaint, and safeguarding paths from
  randomisation entirely. Route them to humans in both arms.
- Do not hold out customers who have explicitly requested an accessibility
  accommodation.

## When you cannot randomise

Pre/post is the common fallback and is weak. Everything else moved at the same
time: seasonality, marketing, product changes, price changes, staffing, other
automation. A pre/post comparison attributes all of it to the bot.

If pre/post is the only option, make the confounders explicit:

- **Normalise per active customer or per order**, never raw ticket counts. Volume
  tracks the business, and this is the single biggest source of false savings
  claims.
- **Use a comparison series** the bot did not touch — an intent, region, or
  language outside its scope. If that series moved the same way, the change is not
  the bot. This is the closest a non-randomised design gets to a control.
- **Match seasonality year over year**, not month over month.
- **Note every concurrent change** in the writeup, including the ones that make the
  bot look good.
- **Report a range, not a number**, and state that the design cannot separate the
  bot from concurrent changes.

A staggered rollout — enabling the bot region by region or queue by queue on a
schedule — is meaningfully stronger than pre/post and often politically easier
than a holdout, because nobody is denied the feature, only sequenced. If a full
holdout is refused, propose this instead of accepting pre/post.

## Reporting

State plainly which question you answered:

- **"Containment is 41%"** — descriptive. What happened to bot sessions.
- **"The bot reduced human contacts per customer by 12% (95% CI 8–16%)"** — causal,
  and only available from a randomised design.

Do not present the first as if it were the second. Most automation business cases
in circulation make exactly that substitution, which is why reported deflection
and observed headcount so rarely reconcile.
