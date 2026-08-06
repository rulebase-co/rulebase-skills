/**
 * Tests for the rulebase-skills CLI and the index it depends on.
 *
 * The CLI is pointed at a mock raw host via RULEBASE_SKILLS_RAW_BASE, so the
 * download path is genuinely exercised rather than stubbed. The load-bearing
 * cases are that install writes every file the index lists (a missing
 * references/ file makes a skill silently useless once installed) and that the
 * committed index matches the repository.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withMockApi, runScript, tempOut } from './helpers/mock-api.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '../bin/rulebase-skills.js');
const BUILD_INDEX = resolve(HERE, '../scripts/build-index.mjs');
const REPO_ROOT = resolve(HERE, '..');

const index = JSON.parse(readFileSync(join(REPO_ROOT, 'skills-index.json'), 'utf8'));

/** Serves skills-index.json and any skill file straight off disk. */
function planner() {
  return (req) => {
    const path = decodeURIComponent(req.url.replace(/^\//, ''));
    if (path === 'skills-index.json') {
      return { status: 200, body: index };
    }
    const onDisk = join(REPO_ROOT, path);
    if (path.startsWith('skills/') && existsSync(onDisk) && statSync(onDisk).isFile()) {
      return { status: 200, headers: { 'content-type': 'text/plain' }, body: readFileSync(onDisk, 'utf8') };
    }
    return { status: 404, body: 'not found' };
  };
}

const env = (base) => ({ RULEBASE_SKILLS_RAW_BASE: base });

// ------------------------------------------------------------------ the index

test('the committed index matches the repository', async () => {
  const res = await runScript(BUILD_INDEX, ['--check'], {});
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stderr, /is current/);
});

test('the index lists every skill directory, and no others', () => {
  const dirs = [];
  const walk = (dir, depth = 1) => {
    if (existsSync(join(dir, 'SKILL.md'))) {
      dirs.push(dir.replace(`${REPO_ROOT}/`, ''));
      return;
    }
    if (depth >= 3) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.')) walk(join(dir, e.name), depth + 1);
    }
  };
  walk(join(REPO_ROOT, 'skills'));

  assert.equal(index.count, dirs.length);
  assert.deepEqual(index.skills.map((s) => s.path).sort(), dirs.sort());
});

test('every file the index promises actually exists', () => {
  for (const s of index.skills) {
    for (const f of s.files) {
      assert.ok(existsSync(join(REPO_ROOT, s.path, f)), `${s.slug} lists a missing file: ${f}`);
    }
    assert.ok(s.files.includes('SKILL.md'), `${s.slug} has no SKILL.md in its file list`);
  }
});

test('the index carries no generation timestamp, so rebuilds are not spurious diffs', () => {
  assert.ok(!('generatedAt' in index));
  const first = readFileSync(join(REPO_ROOT, 'skills-index.json'), 'utf8');
  // Rebuilding must be byte-identical or --check would fail on every commit.
  assert.ok(first.endsWith('\n'));
});

// -------------------------------------------------------------------- the CLI

test('list groups by category and reports the total', async () => {
  await withMockApi(planner(), async ({ base }) => {
    const res = await runScript(CLI, ['list'], env(base));
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /compliance {2}\(32\)/);
    assert.match(res.stdout, /revops {2}\(14\)/);
    assert.match(res.stdout, new RegExp(`${index.count} of ${index.count} skills`));
  });
});

test('list --category narrows to one category', async () => {
  await withMockApi(planner(), async ({ base }) => {
    const res = await runScript(CLI, ['list', '--category', 'revops'], env(base));
    assert.match(res.stdout, /14 of \d+ skills/);
    assert.ok(!res.stdout.includes('cx-complaints-sla'), 'should not list other categories');
  });
});

test('list rejects an unknown category with the valid ones', async () => {
  await withMockApi(planner(), async ({ base }) => {
    const res = await runScript(CLI, ['list', '--category', 'nope'], env(base));
    assert.equal(res.code, 1);
    assert.match(res.stderr, /Available: /);
  });
});

test('search matches slug and description', async () => {
  await withMockApi(planner(), async ({ base }) => {
    const res = await runScript(CLI, ['search', 'churn'], env(base));
    assert.match(res.stdout, /cx-churn-signal/);

    const miss = await runScript(CLI, ['search', 'zzzznotathing'], env(base));
    assert.match(miss.stdout, /no match/);
    assert.equal(miss.code, 0, 'no match is not an error');
  });
});

test('a spaced query matches a hyphenated slug', async () => {
  // The obvious thing to type for cx-revenue-at-risk. Substring-matching the raw
  // query against the slug fails here, which is why search tokenises.
  await withMockApi(planner(), async ({ base }) => {
    const quoted = await runScript(CLI, ['search', 'revenue at risk'], env(base));
    assert.match(quoted.stdout, /cx-revenue-at-risk/);

    // Unquoted, too — the words arrive as separate argv entries.
    const unquoted = await runScript(CLI, ['search', 'revenue', 'at', 'risk'], env(base));
    assert.match(unquoted.stdout, /cx-revenue-at-risk/);
  });
});

test('search requires every token, not just one', async () => {
  await withMockApi(planner(), async ({ base }) => {
    const both = await runScript(CLI, ['search', 'complaint', 'deadline'], env(base));
    assert.match(both.stdout, /cx-complaints-sla/);
    // "complaint" alone matches several; adding "deadline" must narrow it.
    const one = await runScript(CLI, ['search', 'complaint'], env(base));
    const countOf = (out) => Number((out.match(/(\d+) match/) || [0, 0])[1]);
    assert.ok(countOf(one.stdout) > countOf(both.stdout), 'a second token should narrow the result');
  });
});

test('info prints the frontmatter and the install line', async () => {
  await withMockApi(planner(), async ({ base }) => {
    const res = await runScript(CLI, ['info', 'cx-complaints-sla'], env(base));
    assert.match(res.stdout, /category {3}compliance/);
    assert.match(res.stdout, /includes scripts/);
    assert.match(res.stdout, /npx rulebase-skills install cx-complaints-sla/);
  });
});

test('an unknown slug suggests near matches', async () => {
  await withMockApi(planner(), async ({ base }) => {
    const res = await runScript(CLI, ['info', 'churn'], env(base));
    assert.equal(res.code, 1);
    assert.match(res.stderr, /did you mean: .*cx-churn-signal/);
  });
});

test('install writes every file the index lists, including references and scripts', async () => {
  const dir = tempOut('cli-install-');
  // A skill with all three kinds of file.
  const slug = 'cx-complaints-sla';
  const expected = index.skills.find((s) => s.slug === slug).files;
  assert.ok(expected.some((f) => f.startsWith('references/')), 'fixture should have references');
  assert.ok(expected.some((f) => f.startsWith('scripts/')), 'fixture should have scripts');

  await withMockApi(planner(), async ({ base }) => {
    const res = await runScript(CLI, ['install', slug, '--dir', dir], env(base));
    assert.equal(res.code, 0, res.stderr);

    for (const f of expected) {
      assert.ok(existsSync(join(dir, slug, f)), `missing installed file: ${f}`);
    }
    // Content, not just presence.
    const installed = readFileSync(join(dir, slug, 'SKILL.md'), 'utf8');
    assert.equal(installed, readFileSync(join(REPO_ROOT, 'skills/compliance', slug, 'SKILL.md'), 'utf8'));
  });
});

test('install marks scripts executable', async () => {
  const dir = tempOut('cli-chmod-');
  await withMockApi(planner(), async ({ base }) => {
    await runScript(CLI, ['install', 'cx-complaints-sla', '--dir', dir], env(base));
    const script = join(dir, 'cx-complaints-sla', 'scripts', 'complaint-clock.mjs');
    assert.ok(statSync(script).mode & 0o111, 'installed scripts should be executable');
  });
});

test('install --category installs the whole category', async () => {
  const dir = tempOut('cli-cat-');
  await withMockApi(planner(), async ({ base }) => {
    const res = await runScript(CLI, ['install', '--category', 'revops', '--dir', dir], env(base));
    assert.equal(res.code, 0, res.stderr);
    assert.equal(readdirSync(dir).length, 14);
    assert.match(res.stderr, /14 installed/);
  });
});

test('re-installing reports an overwrite rather than silently replacing', async () => {
  const dir = tempOut('cli-again-');
  await withMockApi(planner(), async ({ base }) => {
    await runScript(CLI, ['install', 'cx-churn-signal', '--dir', dir], env(base));
    const res = await runScript(CLI, ['install', 'cx-churn-signal', '--dir', dir], env(base));
    assert.match(res.stderr, /updated cx-churn-signal/);
    assert.match(res.stderr, /1 overwritten/);
  });
});

test('--project-dir keeps the install inside the project', async () => {
  const proj = tempOut('cli-proj-');
  await withMockApi(planner(), async ({ base }) => {
    const res = await runScript(CLI, ['install', 'cx-churn-signal', '--project-dir', proj], env(base));
    assert.equal(res.code, 0, res.stderr);
    assert.ok(existsSync(join(proj, '.claude', 'skills', 'cx-churn-signal', 'SKILL.md')));
    assert.match(res.stderr, /Claude Code \(project\)/);
  });
});

test('--codex and --cursor choose different roots', async () => {
  const proj = tempOut('cli-targets-');
  await withMockApi(planner(), async ({ base }) => {
    await runScript(CLI, ['install', 'cx-churn-signal', '--codex', '--project-dir', proj], env(base));
    assert.ok(existsSync(join(proj, '.codex', 'skills', 'cx-churn-signal', 'SKILL.md')));

    await runScript(CLI, ['install', 'cx-churn-signal', '--cursor', '--project-dir', proj], env(base));
    assert.ok(existsSync(join(proj, '.cursor', 'skills', 'cx-churn-signal', 'SKILL.md')));
  });
});

test('rejects more than one target flag', async () => {
  await withMockApi(planner(), async ({ base }) => {
    const res = await runScript(CLI, ['install', 'cx-churn-signal', '--claude', '--codex'], env(base));
    assert.equal(res.code, 1);
    assert.match(res.stderr, /pick one of --claude, --codex, --cursor/);
  });
});

test('install with no selection explains the options', async () => {
  await withMockApi(planner(), async ({ base }) => {
    const res = await runScript(CLI, ['install'], env(base));
    assert.equal(res.code, 1);
    assert.match(res.stderr, /--category <name> \| --all/);
  });
});

test('a private repository produces an actionable message, not a bare 404', async () => {
  await withMockApi(() => ({ status: 404, body: 'Not Found' }), async ({ base }) => {
    const res = await runScript(CLI, ['list'], env(base));
    assert.equal(res.code, 1);
    assert.match(res.stderr, /repository is private/);
    assert.match(res.stderr, /npx skills add/, 'should point at the CLI that can use a token');
  });
});

test('help and --version work without touching the network', async () => {
  const help = await runScript(CLI, ['help'], { RULEBASE_SKILLS_RAW_BASE: 'http://127.0.0.1:1' });
  assert.equal(help.code, 0);
  assert.match(help.stdout, /npx rulebase-skills install/);

  const version = await runScript(CLI, ['--version'], { RULEBASE_SKILLS_RAW_BASE: 'http://127.0.0.1:1' });
  assert.equal(version.code, 0);
  assert.equal(version.stdout.trim(), JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version);
});

test('an unknown command exits non-zero', async () => {
  const res = await runScript(CLI, ['frobnicate'], { RULEBASE_SKILLS_RAW_BASE: 'http://127.0.0.1:1' });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /unknown command/);
});

test('the CLI has no dependencies, so npx never needs an install step', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.ok(!pkg.dependencies, 'runtime dependencies would break the npx one-liner');
  assert.equal(pkg.bin['rulebase-skills'], './bin/rulebase-skills.js');
  // `files` must ship bin/, or the published package has no executable.
  assert.ok(pkg.files.includes('bin'));
});

// ------------------------------------------------------------------- the docs

test('CATALOG.md lists every skill, and nothing that does not exist', () => {
  // Hand-maintained prose drifts from the tree the moment someone adds a skill
  // and forgets. skills-index.json is generated, so it is the reference.
  const catalog = readFileSync(join(REPO_ROOT, 'CATALOG.md'), 'utf8');
  const rows = (text) => new Set([...text.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((m) => m[1]));

  const stillToBuild = rows(catalog.slice(catalog.indexOf('## Still to build')));
  const listed = new Set([...rows(catalog)].filter((s) => !stillToBuild.has(s)));
  const actual = new Set(index.skills.map((s) => s.slug));

  const missing = [...actual].filter((s) => !listed.has(s));
  const phantom = [...listed].filter((s) => !actual.has(s));
  assert.deepEqual(missing, [], 'skills in the repo but missing from CATALOG.md');
  assert.deepEqual(phantom, [], 'CATALOG.md lists skills that do not exist');

  // Anything in "Still to build" must genuinely not be built yet.
  const built = [...stillToBuild].filter((s) => actual.has(s));
  assert.deepEqual(built, [], 'CATALOG.md lists a shipped skill as still to build');
});

test('the README states the real skill count and per-category counts', () => {
  const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
  assert.ok(readme.includes(`${index.count} skills`), `README should say "${index.count} skills"`);
  for (const [category, n] of Object.entries(index.categories)) {
    const label = category.replace(/-/g, ' ');
    assert.ok(
      new RegExp(`${n} ${label}`, 'i').test(readme),
      `README should state "${n} ${label}"`,
    );
  }
});
