/**
 * skills.js — instruction packs, disclosed progressively.
 *
 * A skill is a folder holding a SKILL.md: YAML frontmatter, then the
 * instructions. Only names and one-line descriptions go into the system
 * prompt; a body is pulled into the conversation the moment it is wanted. The
 * base prompt therefore stays the same size whether there are three skills or
 * thirty.
 *
 * Two ways a body gets loaded:
 *
 *   the model asks for it, with the load_skill tool; or
 *   the frontmatter says `auto:` and one of those words is in the request,
 *   in which case it is already loaded before the model takes its first step.
 *
 * The second one exists because the first one is a judgement call, and a model
 * in a hurry to be helpful skips judgement calls. Design quality is not
 * something to find out was skipped after the app is built.
 *
 * A skill folder may also hold a DIGEST.md: the same rules, cut to the ones
 * that are never worth skipping. That is what an automatic load sends, and it
 * is a latency decision rather than a token one — the whole conversation is
 * re-read by the provider on every single step, so four thousand tokens
 * loaded on the word "app" is four thousand tokens re-read ten or twenty
 * times before the app is finished. The full body stays one load_skill away
 * for work that needs the depth.
 *
 * Skills are read from two places, the project first so a repo can override a
 * built-in of the same name:
 *   <cwd>/.ucode/skills/<name>/SKILL.md
 *   <install dir>/skills/<name>/SKILL.md
 * and beside either of them, an optional DIGEST.md.
 */

import { promises as fs } from 'node:fs';
import path, { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const BUILTIN_DIR = path.join(HERE, '..', '..', 'skills');

export function projectDir(cwd = process.cwd()) {
  return path.join(cwd, '.ucode', 'skills');
}

/** Enough YAML for `key: value`, quoted or bare. Skills are not config files. */
export function parseSkill(text, source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^﻿/, ''));
  if (!match) {
    return { error: `${source} has no frontmatter — it must start with a --- line.` };
  }

  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    let value = kv[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    meta[kv[1]] = value;
  }

  if (!meta.name) return { error: `${source} frontmatter has no "name".` };
  if (!meta.description) return { error: `${source} frontmatter has no "description".` };

  return {
    skill: {
      name: meta.name,
      description: meta.description,
      // Words that pull this skill in before the model has said anything.
      triggers: (meta.auto ?? '')
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
      body: match[2].trim(),
      source,
    },
  };
}

async function readDir(dir) {
  const skills = [];
  const problems = [];

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return { skills, problems }; // no skills directory is a normal state
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(dir, entry.name, 'SKILL.md');
    let text;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') problems.push(`${file} could not be read: ${err.message}`);
      continue;
    }
    const { skill, error } = parseSkill(text, file);
    if (error) { problems.push(error); continue; }
    // The short form, if the skill has one. No frontmatter: it is the same
    // skill, said in fewer words.
    skill.digest = (await fs.readFile(path.join(dir, entry.name, 'DIGEST.md'), 'utf8').catch(() => '')).trim();
    skills.push(skill);
  }

  return { skills, problems };
}

/**
 * Every available skill, project ones shadowing built-ins by name.
 * `problems` rides along non-enumerably for the UI to report.
 */
export async function loadSkills({ cwd = process.cwd() } = {}) {
  const builtin = await readDir(BUILTIN_DIR);
  const project = await readDir(projectDir(cwd));

  const byName = new Map();
  for (const s of builtin.skills) byName.set(s.name, s);
  for (const s of project.skills) byName.set(s.name, s);

  const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  Object.defineProperty(skills, 'problems', {
    value: [...builtin.problems, ...project.problems],
    enumerable: false,
  });
  return skills;
}

/** The system-prompt block: names and descriptions, never bodies. */
export function catalogue(skills) {
  if (!skills.length) return '';
  return skills.map((s) => `- ${s.name}: ${s.description}`).join('\n');
}

export function findSkill(skills, name) {
  const wanted = String(name ?? '').trim().toLowerCase();
  return skills.find((s) => s.name.toLowerCase() === wanted);
}

/**
 * Which skills this request should arrive with already loaded.
 *
 * A trigger matches on a word boundary, so "app" fires on "build me an app"
 * but not on "happy". Multi-word triggers are matched as phrases.
 */
export function autoLoadFor(skills, text) {
  const request = String(text ?? '').toLowerCase();
  if (!request.trim()) return [];

  return skills.filter((skill) =>
    skill.triggers.some((trigger) => {
      const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(request);
    })
  );
}

/**
 * How a body enters the conversation.
 *
 * `short` sends the digest instead of the whole skill, when the skill has
 * one. Everything in the digest is a rule; what is missing is the worked
 * examples and the long way round, and load_skill fetches those.
 */
export function skillMessage(skill, { automatic = false, short = false } = {}) {
  const digest = short && skill.digest ? skill.digest : null;
  const why = automatic
    ? `The "${skill.name}" skill was loaded automatically because this request is the kind it covers.`
    : `The "${skill.name}" skill was loaded for this task.`;
  return {
    role: 'system',
    content:
      `${why} Follow it — it outranks your defaults, and it is not optional.\n\n` +
      `--- BEGIN SKILL: ${skill.name} ---\n${digest ?? skill.body}\n--- END SKILL ---` +
      (digest
        ? `\n\nThat is the short form: every rule, none of the worked examples. For anything ` +
          `beyond a straightforward screen, call load_skill("${skill.name}") for the whole thing.`
        : ''),
    skill: skill.name,
    short: Boolean(digest),
  };
}
