/**
 * deploy.js — put the app online on Vercel.
 *
 * The user says "deploy it" (or types /deploy) and gets a live link. ucode
 * picks a short project name that fits the app and is actually free, creates
 * or reuses the Vercel project, copies the app's .env keys to it as encrypted
 * variables, refuses to upload code with a secret written into it, and hands
 * the upload and build to the Vercel CLI — which knows every framework's
 * build settings better than anything written here would.
 *
 * The token comes from VERCEL_TOKEN (~/.ucode/.env). It is never printed:
 * anything the CLI says is scrubbed of it before it reaches the screen.
 */

import { spawn } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { ToolFailure } from '../core/failure.js';
import { ENV_FILE } from '../core/provider.js';
import { resolveIn, result } from './shared.js';
import { childEnv } from './shell.js';

const API = 'https://api.vercel.com';
const DEPLOY_TIMEOUT = 12 * 60_000;
let fetchImpl = (...a) => fetch(...a);

/** Tests hand in a fake fetch. */
export function setFetch(f) { fetchImpl = f ?? ((...a) => fetch(...a)); }

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** "Food IQ" → "food-iq": lowercase, a-z 0-9 and dashes, short, cut at a word. */
export function slugify(text, max = 20) {
  let s = String(text ?? '').toLowerCase().replace(/^@[^/]+\//, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length > max) {
    const cut = s.slice(0, max);
    s = cut.includes('-') ? cut.slice(0, cut.lastIndexOf('-')) : cut;
  }
  return s || 'app';
}

/** Candidates in order of preference: the plain name first, then tidy variants. */
export function nameCandidates(base) {
  const b = slugify(base);
  const words = ['app', 'web', 'live', 'hq', 'hub'];
  const rand = () => Math.random().toString(36).slice(2, 6);
  return [b, ...words.map((w) => `${b}-${w}`), b.replace(/-/g, ''), `${b}-${rand()}`, `${b}-${rand()}`]
    .filter((v, i, a) => v && a.indexOf(v) === i);
}

/**
 * Is <name>.vercel.app free? Not a project of this account, and no one
 * else's deployment answers at that address.
 */
async function available(name, ctx) {
  const mine = await ctx.api(`/v9/projects/${name}`);
  if (mine.status === 200) return false;
  try {
    const r = await fetchImpl(`https://${name}.vercel.app`, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(8000) });
    return r.status === 404 && /DEPLOYMENT_NOT_FOUND|NOT_FOUND/i.test(r.headers.get('x-vercel-error') ?? 'NOT_FOUND');
  } catch {
    return true; // nothing answered at all — the name is unclaimed
  }
}

export async function pickName(base, ctx) {
  for (const candidate of nameCandidates(base)) {
    if (await available(candidate, ctx)) return candidate;
  }
  throw new ToolFailure({
    kind: 'no_name', attempted: 'choosing a project name',
    failed: `Every name tried for "${base}" is taken.`,
    fix: 'Call deploy again with a different name.',
  });
}

// ---------------------------------------------------------------------------
// Secrets and env
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  [/sk-or-v1-[0-9a-f]{20,}/, 'an API key (sk-or-v1-…)'],
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}/, 'an API key (sk-…)'],
  [/\bvcp_[A-Za-z0-9]{20,}/, 'a Vercel token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'a GitHub token'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'a Google API key'],
];
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', '.vercel', 'dist', 'build', 'out', '.ucode', '.turbo']);
const SCAN_EXT = /\.(?:[cm]?[jt]sx?|html?|vue|svelte|astro|json)$/i;

/** Files with a secret written into them. `.env*` files are the right place, so they are skipped. */
export async function scanSecrets(dir) {
  const found = [];
  async function walk(d) {
    for (const entry of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) await walk(path.join(d, entry.name)); continue; }
      if (entry.name.startsWith('.env') || entry.name === 'package-lock.json' || !SCAN_EXT.test(entry.name)) continue;
      const file = path.join(d, entry.name);
      const text = await fs.readFile(file, 'utf8').catch(() => '');
      if (text.length > 1_000_000) continue;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const hit = SECRET_PATTERNS.find(([re]) => re.test(lines[i]));
        if (hit) found.push({ file: path.relative(dir, file).split(path.sep).join('/'), line: i + 1, what: hit[1] });
      }
    }
  }
  await walk(dir);
  return found;
}

/** KEY=value pairs from .env, .env.local, .env.production — later files win. */
export async function readEnv(dir) {
  const vars = {};
  for (const name of ['.env', '.env.local', '.env.production']) {
    const text = await fs.readFile(path.join(dir, name), 'utf8').catch(() => '');
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      vars[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return vars;
}

function frameworkOf(pkg, dir) {
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  if (deps.next) return 'nextjs';
  if (deps.vite) return 'vite';
  if (deps['react-scripts']) return 'create-react-app';
  if (!pkg && existsSync(path.join(dir, 'index.html'))) return null;
  return null;
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

export async function deploy({ folder = '.', name } = {}, { onOutput } = {}) {
  const token = process.env.VERCEL_TOKEN;
  if (!token) {
    throw new ToolFailure({
      kind: 'no_token', attempted: 'deploying to Vercel',
      failed: 'There is no Vercel token yet.',
      fix: `Tell the user: make one at vercel.com/account/tokens (Create Token), then add a line VERCEL_TOKEN=... to ${ENV_FILE} and restart ucode.`,
    });
  }
  const say = (line) => onOutput?.([line]);
  const where = resolveIn(folder, 'deploy', 'folder');
  const dir = where.abs;
  const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8').catch(() => 'null'));
  if (!pkg && !existsSync(path.join(dir, 'index.html'))) {
    throw new ToolFailure({
      kind: 'not_an_app', attempted: `deploying ${where.show}`,
      failed: `${where.show} has no package.json or index.html, so there is nothing to deploy.`,
      fix: 'Pass the folder of the app itself, e.g. deploy({ folder: "food-iq" }).',
    });
  }

  const scrub = (s) => String(s).split(token).join('***');
  const api = async (pathname, { method = 'GET', body } = {}) => {
    const url = new URL(API + pathname);
    if (ctx.teamId) url.searchParams.set('teamId', ctx.teamId);
    const r = await fetchImpl(url, {
      method, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    return { status: r.status, ok: r.ok, json: await r.json().catch(() => ({})) };
  };
  const ctx = { api, teamId: null };

  say('Checking for secrets');
  const leaks = await scanSecrets(dir);
  if (leaks.length) {
    const list = leaks.slice(0, 5).map((l) => `${l.file}:${l.line} (${l.what})`).join(', ');
    throw new ToolFailure({
      kind: 'secret_in_code', attempted: `deploying ${where.show}`,
      failed: `The code has a secret written into it: ${list}. Once online, anyone could read it.`,
      fix: 'Move the value to .env.local (e.g. OPENROUTER_API_KEY=...), read it with process.env in a ' +
        'server route (Next.js: app/api/.../route.ts), call that route from the page, then deploy again. ' +
        'ucode copies .env.local to Vercel for you.',
    });
  }

  const me = await api('/v2/user');
  if (!me.ok) {
    throw new ToolFailure({
      kind: 'bad_token', attempted: 'deploying to Vercel', failed: 'Vercel did not accept the token.',
      fix: 'Tell the user to make a new token at vercel.com/account/tokens and put it in ~/.ucode/.env as VERCEL_TOKEN.',
    });
  }
  ctx.teamId = me.json.user?.defaultTeamId ?? null;
  const orgId = ctx.teamId ?? me.json.user?.id;

  // Reuse the project this app was deployed to before, so the link stays the same.
  const linkFile = path.join(dir, '.vercel', 'project.json');
  let link = JSON.parse(await fs.readFile(linkFile, 'utf8').catch(() => 'null'));
  if (link?.projectId) {
    const still = await api(`/v9/projects/${link.projectId}`);
    if (!still.ok) link = null;
    else link.projectName = still.json.name;
  }
  if (!link?.projectId) {
    say('Choosing a name');
    const projectName = name ? slugify(name) : await pickName(pkg?.name || path.basename(dir), ctx);
    const made = await api('/v11/projects', { method: 'POST', body: { name: projectName, framework: frameworkOf(pkg, dir) } });
    if (!made.ok) {
      throw new ToolFailure({
        kind: 'vercel_error', attempted: `creating the Vercel project ${projectName}`,
        failed: scrub(made.json?.error?.message ?? `HTTP ${made.status}`),
        fix: 'Try again with a different name.',
      });
    }
    link = { projectId: made.json.id, orgId, projectName };
    await fs.mkdir(path.dirname(linkFile), { recursive: true });
    await fs.writeFile(linkFile, JSON.stringify({ projectId: link.projectId, orgId }, null, 2));
    const gi = path.join(dir, '.gitignore');
    const ignore = await fs.readFile(gi, 'utf8').catch(() => '');
    if (!/^\.vercel\/?$/m.test(ignore)) await fs.writeFile(gi, `${ignore.replace(/\n?$/, '\n')}.vercel\n`).catch(() => {});
  }

  const vars = await readEnv(dir);
  const keys = Object.keys(vars);
  if (keys.length) {
    say(`Copying ${keys.length} key${keys.length === 1 ? '' : 's'} to Vercel`);
    await api(`/v10/projects/${link.projectId}/env?upsert=true`, {
      method: 'POST',
      body: keys.map((key) => ({ key, value: vars[key], type: 'encrypted', target: ['production', 'preview'] })),
    });
  }

  say('Uploading and building on Vercel');
  const started = Date.now();
  const { code, output } = await new Promise((resolve) => {
    const args = ['--yes', 'vercel@latest', 'deploy', '--prod', '--yes', '--token', token];
    const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, {
      cwd: dir, shell: process.platform === 'win32', windowsHide: true,
      env: { ...childEnv(), VERCEL_ORG_ID: orgId, VERCEL_PROJECT_ID: link.projectId, VERCEL_TELEMETRY_DISABLED: '1' },
    });
    let output = '';
    const take = (chunk) => {
      const text = scrub(chunk).replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '');
      output += text;
      // Only lines that read as progress: no markup, no lone braces, no redraw leftovers.
      const last = text.split(/\r?\n/).map((l) => l.replace(/\[[0-9;]*[A-Za-z]/g, '').trim())
        .filter((l) => /[A-Za-z]{3}/.test(l) && !/^[<{}[\]]/.test(l)).at(-1);
      if (last) say(last.replace(/^[▲✓>\s]+/, '').replace(/\s*\[\d+s\]$/, '').slice(0, 80));
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => child.kill(), DEPLOY_TIMEOUT);
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, output: `${output}\n${err.message}` }); });
    child.on('close', (c) => { clearTimeout(timer); resolve({ code: c, output }); });
  });
  const secs = Math.round((Date.now() - started) / 1000);

  if (code !== 0) {
    const tail = output.split(/\r?\n/).filter((l) => l.trim()).slice(-25).join('\n');
    throw new ToolFailure({
      kind: 'deploy_failed', attempted: `deploying ${where.show} to Vercel`,
      failed: `The deploy failed after ${secs}s:\n${tail}`,
      fix: 'The lines above name the problem — usually the same error `npm run build` shows locally. ' +
        'Fix it, check the build passes, then deploy again.',
    });
  }

  const live = `https://${link.projectName}.vercel.app`;
  const ok = await fetchImpl(live, { signal: AbortSignal.timeout(15_000) }).then((r) => r.status < 400).catch(() => false);
  const url = ok ? live : (output.match(/https:\/\/[a-z0-9.-]+\.vercel\.app/g) ?? [live]).at(-1);
  return result(
    [
      `Live at ${url}`,
      `Deployed in ${secs}s as the Vercel project "${link.projectName}".`,
      keys.length ? `Copied to Vercel as encrypted variables: ${keys.join(', ')}` : '',
      'Deploying again updates the same link.',
    ].filter(Boolean).join('\n'),
    `live · ${url} · ${secs}s`
  );
}
