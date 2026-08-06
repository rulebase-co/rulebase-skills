#!/usr/bin/env node
/**
 * rulebase-skills — install CX ops skills into Claude Code, Codex, Cursor, or
 * any directory.
 *
 *   npx rulebase-skills list
 *   npx rulebase-skills search churn
 *   npx rulebase-skills info cx-churn-signal
 *   npx rulebase-skills install cx-churn-signal
 *   npx rulebase-skills install --category compliance
 *
 * Zero dependencies on purpose: this runs via npx in someone else's project, so
 * an install step is a reason for it not to run. Node 20+ gives us global fetch.
 *
 * Everything is read from raw.githubusercontent.com against a committed
 * skills-index.json, because raw has no directory listing and the GitHub API is
 * rate limited for anonymous callers — which would break `list` exactly when a
 * lot of people try it at once.
 */

import { mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

const REPO = process.env.RULEBASE_SKILLS_REPO || 'rulebase-co/rulebase-skills';
const BRANCH = process.env.RULEBASE_SKILLS_BRANCH || 'main';
const RAW_BASE = (process.env.RULEBASE_SKILLS_RAW_BASE || `https://raw.githubusercontent.com/${REPO}/${BRANCH}`).replace(/\/$/, '');

const argv = process.argv.slice(2);
const command = argv[0];

// ---------------------------------------------------------------------- utils

const out = (s = '') => process.stdout.write(`${s}\n`);
const err = (s = '') => process.stderr.write(`${s}\n`);

function die(msg, code = 1) {
  err(`error: ${msg}`);
  process.exit(code);
}

/** Flags that consume the next argument. Needed so a flag's value is never
 *  mistaken for a positional — `install foo --dir /tmp` must not read /tmp as a
 *  second skill name. */
const VALUE_FLAGS = new Set(['dir', 'project-dir', 'category']);

function flag(name) {
  return argv.includes(`--${name}`);
}
function value(name) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return null;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) die(`--${name} requires a value`);
  return v;
}

/** Positional arguments after the command, with flags and their values removed. */
function positionals() {
  const out = [];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      if (VALUE_FLAGS.has(arg.slice(2))) i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

async function get(path) {
  const url = `${RAW_BASE}/${path}`;
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'rulebase-skills-cli' } });
  } catch (e) {
    die(`could not reach ${url} — ${e?.message || e}`);
  }
  if (res.status === 404) {
    die(
      `not found: ${url}\n` +
        'If the repository is private, raw access needs a token and this CLI cannot use one.\n' +
        'Use `npx skills add rulebase-co/rulebase-skills` instead, which picks up your `gh auth token`.',
    );
  }
  if (!res.ok) die(`HTTP ${res.status} for ${url}`);
  return res;
}

let cachedIndex = null;
async function loadIndex() {
  if (cachedIndex) return cachedIndex;
  const res = await get('skills-index.json');
  const text = await res.text();
  try {
    cachedIndex = JSON.parse(text);
  } catch {
    die('skills-index.json is not valid JSON — the repository may be mid-release');
  }
  if (!Array.isArray(cachedIndex.skills)) die('skills-index.json has no skills array');
  return cachedIndex;
}

// -------------------------------------------------------------------- targets

/**
 * Where a skill goes. `--dir` is the escape hatch: agent tools move their skill
 * directories between versions, so rather than guess, every target can be
 * overridden explicitly.
 */
function resolveTarget() {
  const explicit = value('dir');
  if (explicit) return { label: `--dir ${explicit}`, root: resolve(explicit) };

  const project = value('project-dir');
  const chosen = ['claude', 'codex', 'cursor'].filter((t) => flag(t));
  if (chosen.length > 1) die('pick one of --claude, --codex, --cursor');
  const target = chosen[0] ?? 'claude';

  if (target === 'claude') {
    return project
      ? { label: 'Claude Code (project)', root: join(resolve(project), '.claude', 'skills') }
      : { label: 'Claude Code (global)', root: join(homedir(), '.claude', 'skills') };
  }
  if (target === 'codex') {
    return project
      ? { label: 'Codex (project)', root: join(resolve(project), '.codex', 'skills') }
      : { label: 'Codex (global)', root: join(homedir(), '.codex', 'skills') };
  }
  // Cursor is project-scoped in every version we know of.
  const base = project ? resolve(project) : process.cwd();
  return { label: 'Cursor (project)', root: join(base, '.cursor', 'skills') };
}

// ------------------------------------------------------------------- commands

function matchSkill(index, slug) {
  const hit = index.skills.find((s) => s.slug === slug);
  if (hit) return hit;
  const near = index.skills
    .filter((s) => s.slug.includes(slug) || slug.includes(s.slug))
    .slice(0, 5)
    .map((s) => s.slug);
  die(`unknown skill "${slug}"${near.length ? `\ndid you mean: ${near.join(', ')}` : '\nrun `npx rulebase-skills list`'}`);
}

async function cmdList() {
  const index = await loadIndex();
  const category = value('category');
  const skills = category ? index.skills.filter((s) => s.category === category) : index.skills;
  if (category && skills.length === 0) {
    die(`no skills in category "${category}". Available: ${Object.keys(index.categories ?? {}).join(', ')}`);
  }

  const byCat = {};
  for (const s of skills) (byCat[s.category ?? 'uncategorised'] ??= []).push(s);

  for (const [cat, list] of Object.entries(byCat).sort()) {
    out('');
    out(`${cat}  (${list.length})`);
    for (const s of list.sort((a, b) => a.slug.localeCompare(b.slug))) {
      // First clause of the description is the "what it does" half.
      const summary = (s.description || '').split(/(?<=\.)\s|\. Trigger/)[0].replace(/^Use (to|when) /, '');
      out(`  ${s.slug.padEnd(38)} ${summary.slice(0, 88)}`);
    }
  }
  out('');
  out(`${skills.length} of ${index.count} skills. \`npx rulebase-skills info <slug>\` for detail.`);
}

async function cmdSearch() {
  const query = positionals()[0];
  if (!query) die('usage: npx rulebase-skills search <query>');
  const index = await loadIndex();
  const q = query.toLowerCase();
  const hits = index.skills.filter(
    (s) => s.slug.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q),
  );
  if (hits.length === 0) {
    out(`no match for "${query}". \`npx rulebase-skills list\` shows all ${index.count}.`);
    return;
  }
  out('');
  for (const s of hits) out(`  ${s.slug.padEnd(38)} ${s.category}`);
  out('');
  out(`${hits.length} match${hits.length === 1 ? '' : 'es'}.`);
}

async function cmdInfo() {
  const slug = positionals()[0];
  if (!slug) die('usage: npx rulebase-skills info <slug>');
  const index = await loadIndex();
  const s = matchSkill(index, slug);

  out('');
  out(s.slug);
  out('-'.repeat(s.slug.length));
  out(`category   ${s.category}`);
  out(`archetype  ${s.archetype ?? '(none)'}`);
  out(`version    ${s.version ?? '(none)'}`);
  out(`path       ${s.path}`);
  out(`files      ${s.files.length}${s.hasScripts ? ' (includes scripts)' : ''}${s.hasReferences ? ' (includes references)' : ''}`);
  out('');
  out(s.description);
  out('');
  out(`install:  npx rulebase-skills install ${s.slug}`);
}

async function installOne(skill, root) {
  const dest = join(root, skill.slug);
  mkdirSync(dest, { recursive: true });

  for (const file of skill.files) {
    const res = await get(`${skill.path}/${file}`);
    const body = Buffer.from(await res.arrayBuffer());
    const target = join(dest, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
    // Scripts are documented as executable; npx-installed files are not by default.
    if (file.startsWith('scripts/')) {
      try {
        chmodSync(target, 0o755);
      } catch {
        /* best effort — a read-only FS should not fail the install */
      }
    }
  }
  return dest;
}

async function cmdInstall() {
  const index = await loadIndex();
  const target = resolveTarget();
  const category = value('category');

  let selected;
  const named = positionals();
  if (flag('all')) {
    selected = index.skills;
  } else if (category) {
    selected = index.skills.filter((s) => s.category === category);
    if (selected.length === 0) {
      die(`no skills in category "${category}". Available: ${Object.keys(index.categories ?? {}).join(', ')}`);
    }
  } else if (named.length) {
    selected = named.map((slug) => matchSkill(index, slug));
  } else {
    die('usage: npx rulebase-skills install <slug...> | --category <name> | --all');
  }

  err(`installing ${selected.length} skill(s) into ${target.label}`);
  err(`  ${target.root}`);
  err('');

  const installed = [];
  const overwritten = [];
  for (const s of selected) {
    const existed = existsSync(join(target.root, s.slug));
    const dest = await installOne(s, target.root);
    installed.push(s.slug);
    if (existed) overwritten.push(s.slug);
    err(`  ${existed ? 'updated' : 'added  '} ${s.slug}`);
  }

  err('');
  err(`${installed.length} installed${overwritten.length ? `, ${overwritten.length} overwritten` : ''}.`);
  if (target.label.startsWith('Claude Code (global)')) {
    err('Restart Claude Code, or start a new session, to pick them up.');
  }
}

function cmdHelp() {
  out(`rulebase-skills — CX ops skills for Claude Code, Codex and Cursor

Usage
  npx rulebase-skills list [--category <name>]
  npx rulebase-skills search <query>
  npx rulebase-skills info <slug>
  npx rulebase-skills install <slug...> [target]
  npx rulebase-skills install --category <name> [target]
  npx rulebase-skills install --all [target]

Targets
  --claude              ~/.claude/skills           (default)
  --codex               ~/.codex/skills
  --cursor              <project>/.cursor/skills
  --project-dir <path>  install into that project rather than the home directory
  --dir <path>          install straight into a directory, whatever the tool

Examples
  npx rulebase-skills install cx-churn-signal
  npx rulebase-skills install --category quality-assurance --project-dir .
  npx rulebase-skills install cx-complaints-sla --codex

Repository: https://github.com/${REPO}`);
}

// ------------------------------------------------------------------------ run

const commands = {
  list: cmdList,
  ls: cmdList,
  search: cmdSearch,
  find: cmdSearch,
  info: cmdInfo,
  show: cmdInfo,
  install: cmdInstall,
  add: cmdInstall,
  help: cmdHelp,
};

if (!command || command === '--help' || command === '-h') {
  cmdHelp();
} else if (command === '--version' || command === '-v') {
  // Read from the installed package rather than hard-coding a second copy.
  const { readFileSync } = await import('node:fs');
  const pkgUrl = new URL('../package.json', import.meta.url);
  out(JSON.parse(readFileSync(pkgUrl, 'utf8')).version);
} else if (commands[command]) {
  await commands[command]();
} else {
  die(`unknown command "${command}". Run \`npx rulebase-skills help\`.`);
}
