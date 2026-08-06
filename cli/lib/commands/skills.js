/**
 * `rulebase skills …` — forwards to the rulebase-skills CLI.
 *
 * Deliberately a forwarder rather than a reimplementation. The installer is
 * already published, public and tested; duplicating its index fetching and file
 * writing here would give two things to keep in step for no benefit, and the
 * skills catalog is meant to stand on its own as vendor-neutral practice rather
 * than as a feature of a vendor's CLI.
 *
 * `npx` resolves a package by name, so `npx rulebase-skills` is what a user
 * should learn regardless. This exists so that someone who only knows about
 * `rulebase` is not stuck.
 */

export function skills(_flags, rest) {
  const args = rest.length ? ` ${rest.join(' ')}` : ' list';
  const lines = [
    '',
    '  Skills live in their own package, so that the catalog stands alone:',
    '',
    `      npx rulebase-skills${args}`,
    '',
    '  It installs into Claude Code, Codex or Cursor and needs no Rulebase account.',
    '  https://github.com/rulebase-co/rulebase-skills',
    '',
  ];
  return {
    text: lines.join('\n'),
    json: { forwardTo: `npx rulebase-skills${args}`.trim() },
    exitCode: 0,
  };
}
