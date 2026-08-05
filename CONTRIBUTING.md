# Contributing

The authoring standard is [AGENTS.md](AGENTS.md). Read it first — CI enforces most
of it, and the parts it can't enforce are what make a skill worth installing.

## Workflow

```bash
git clone https://github.com/rulebase-co/skills.git
cd skills
npm run check      # validate (strict) + tests. No install step needed.
```

There are no dependencies to install. The validator and tests use only Node 20+
built-ins, and skill scripts must do the same.

1. Branch.
2. Add or edit a skill under `skills/<category>/<skill-name>/`.
3. Add the skill name to a grouping in `skills.sh.json`.
4. Run `npm run check` until clean.
5. Test that the skill actually triggers (see below).
6. Open a PR describing what the skill knows that the vendor docs don't.

## What gets a skill merged

The bar is **non-obvious, verified knowledge**. A skill that paraphrases official
documentation has negative value: it costs context and displaces something useful.

Ask what the skill saves someone from. Good answers look like:

- "The endpoint you'd naturally use silently caps at 1,000 results."
- "This metric counts customers who gave up as successes."
- "A monthly QA score from four samples has a ±29 point confidence interval."

If you can't state that sentence, the skill isn't ready.

## Rules that get PRs sent back

**Unverified numbers.** Every rate limit, cap, statistical threshold, and industry
figure needs a source or a computation. No invented benchmarks — one made-up
statistic makes the whole catalog untrustworthy.

**Cross-skill references.** Skills install standalone, so a link to
`../other-skill/` breaks at install time. Duplicate shared reference material. The
validator catches this.

**A description without triggers.** At startup the agent sees only the name and
description. A description that explains the skill but never names the phrases or
situations that should activate it will never fire. Write both halves.

**npm dependencies in skill scripts.** Skills get copied into arbitrary projects.
A script requiring `npm install` fails there. Use `fetch` and `node:*`.

**Credentials as CLI arguments.** Environment variables only. Argv appears in shell
history, in `ps`, and in agent transcripts.

**A bloated SKILL.md.** Hard limit 500 lines, warned at 400. Detail goes in
`references/`, which loads only when needed.

**Untested scripts.** Anything in `scripts/` needs coverage in `tests/` for its
failure paths — pagination, retries, resume, malformed input. Happy-path-only
scripts break in production.

## Testing that a skill triggers

The most common failure is a well-written skill that never loads.

In a fresh session with the skill installed, describe your problem the way a real
user would — **not** using the skill's name:

> "our containment rate says 70% but ticket volume hasn't moved"

If the agent doesn't load the skill, the description is wrong. Fix the description,
not the body. Iterate until it fires on two or three different natural phrasings.

## Adding a platform

New platforms follow the `platform` archetype. Before writing, find the answers to:

- **Auth**: which method, and the least-privileged scope that works.
- **The wrong endpoint**: what does a competent person reach for first, and how
  does it fail? This is the core of the skill.
- **The right endpoint**, with pagination style and page size.
- **Rate limits**, including any endpoint-specific limit that differs from the
  account limit, plus the 429 contract (`Retry-After`?).
- **Resumability**: what is checkpointable.
- **Silent gaps**: deleted, archived, redacted, or merged records; anything the API
  returns that the UI doesn't, or vice versa.
- **A normalised output shape**, so analyses can be written once across platforms.

Verify against the vendor's own docs and cite them. If you have sandbox access,
run the script against it and say so in the PR.

## Style

Write for someone competent who hasn't hit this specific problem yet. State the
constraint, then the fix. Skip the encouragement, and don't hedge conclusions you
can support — but do state limits plainly where they exist.

Use British or American spelling consistently within a file.
