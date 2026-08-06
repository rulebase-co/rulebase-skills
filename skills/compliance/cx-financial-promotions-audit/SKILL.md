---
name: cx-financial-promotions-audit
description: Use to check whether support conversations contain promotional content that has to meet financial-promotion or advertising standards, and whether it does. Trigger for "are agents promoting products in support", "do our support replies count as financial promotions", "check our macros for promotional content", balanced-presentation review, risk-warning requirements, or a marketing message reaching customers through a support channel.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: analysis
---

# Promotional content in support conversations

Support conversations are not usually thought of as marketing, so they escape the approval
process that marketing content goes through. Then an agent mentions a product, a macro
includes a paragraph about an upgrade, an automated reply carries a footer — and content
that would have needed sign-off, balance and a risk warning has reached thousands of
customers through a channel nobody reviews.

**What counts as a financial promotion, and what it must contain, is jurisdiction- and
product-specific, and it is a compliance and legal determination.** Nothing here states a
requirement. This finds the content, so someone qualified can assess it.

## Find the promotional content

It is rarely where you would look for marketing:

- **Macros and templates.** The highest-volume source by a wide margin, and the easiest to
  fix. One paragraph in one macro reaches every customer who received it — so the audit
  should start here and this is where the return is.
- **Automated replies and acknowledgements**, including footers and signature blocks. A
  promotional footer appended to every support reply is promotional content at maximum
  volume, and it is usually owned by whoever configured the mail template rather than by
  marketing.
- **Agent free-text**, where an agent mentions another product or an upgrade.
- **Knowledge-base articles** linked from support replies. A link to promotional content
  carries it into the conversation.
- **Bot and AI agent output.** A model that has been given product marketing material as
  context will produce promotional statements, and nobody approved the specific wording.
  **This is the newest and least-controlled source** — the output is generated per
  conversation, so there is no artefact to approve, which is itself the finding.
- **Proactive outbound messages** sent from support tooling.
- **Survey and CSAT emails**, which frequently carry marketing content.
- **Retention and save conversations**, where the pull toward a benefits-only presentation is
  strongest.

## What to check on each piece

Once compliance has told you what applies, the recurring themes:

- **Balance.** Benefits and risks presented with comparable prominence. A reply listing three
  advantages and no downside is unbalanced even if every sentence is true.
- **Required risk warnings** — present, and prominent rather than buried after the call to
  action.
- **Fair, clear and not misleading**, including by omission. Leaving out a material condition
  is misleading.
- **Accuracy of any figure** — rates, fees, returns — and whether they are current. Macros
  outlive the numbers in them; check the last-edited date against the last time the figure
  changed.
- **Comparisons**, where making one triggers additional requirements.
- **Approval status.** Was this content approved for promotional use, by whom, when, and is
  the approval still valid? Most support content has never been through the process, which
  is the structural finding.
- **Target audience.** Content approved for one audience appearing in conversations with
  another.

## The three structural findings

Almost every audit of this kind produces these, and they matter more than any individual
piece of wording:

**1. Support content is outside the approval workflow.** Marketing content goes through
review; macros do not. The fix is a gate on macro and template changes where the content
could be promotional, not a one-off review of the current library.

**2. Nobody owns the footer.** Automated footers and signature blocks are configured once,
by whoever set up the mail template, and reviewed never. They are the highest-volume
promotional content in the business.

**3. Generated output cannot be pre-approved.** A bot composing replies produces novel
promotional statements per conversation. The control has to be at the input and the
guardrail — what material is in its context, and what it is instructed not to say — plus
sampled output review. Treating it like static content and approving a version does not work.

## Quantify the exposure

For each finding, establish reach, because that determines the severity and whether it is a
reportable matter:

- **Macro usage counts** — how many customers received it, over what period.
- **Footer reach** — effectively every outbound message in the period.
- **Agent free-text frequency**, from a sample, extrapolated with the interval stated.
- **Bot output frequency**, from a sample.

Report absolute customer counts, not rates. "This macro was sent to 14,000 customers over
nine months" is the sentence that gets it fixed and that compliance needs.

Also establish **when it started**, since the exposure period bounds the affected population
and may matter for remediation.

## Guardrails

- **Do not determine whether content is a financial promotion or whether it complies.**
  Identify candidates, quantify reach, and route to compliance. This is the whole discipline
  of the skill.
- **Do not rewrite promotional content to fix it.** Approved wording comes from the people
  with authority to approve it.
- **Content already sent cannot be unsent.** If a non-compliant promotion reached customers,
  the questions are remediation and reportability, both of which belong to compliance and
  legal, and one of which may have a clock.
- **Do not treat this as an agent conduct issue.** Agents mention products because a macro,
  a script or an incentive told them to. Check those first.
- **Where an incentive rewards mentioning a product**, that is the finding, and it belongs in
  the report ahead of the wording.
- **Cite ids and quote the promotional text specifically** — here the wording *is* the
  finding, so quoting it is appropriate, but keep surrounding conversation out.

## Present results to the user

1. **The applicable standard, as compliance stated it**, and its source. If it has not been
   stated, that is the first finding.
2. **Candidate promotional content by source**, macros and footers first, with the exact text.
3. **Reach per item**, in absolute customer counts, with the exposure period and start date.
4. **Approval status** per item — approved, expired, never submitted.
5. **The three structural findings** — approval-workflow gap, footer ownership, generated
   output — with an owner for each.
6. **Figures that are out of date**, from comparing edit dates against rate and fee changes.
7. **Incentives that reward product mentions**, named ahead of any agent pattern.
8. **What compliance must determine**, and anything where content already sent may need
   remediation.
