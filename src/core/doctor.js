/**
 * doctor.js — `ucode doctor` and /doctor: is everything ucode needs working?
 *
 * Every check runs at once and each has a short deadline, so the whole report
 * takes a few seconds. A problem comes with the one thing that fixes it.
 * Secret values are never printed — only whether they are there and accepted.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { theme, dim, blue } from '../ui/theme.js';
import { VERSION } from './version.js';
import { DEFAULT_MODEL, ENV_FILE, BASE_URL, nvidiaKey } from './provider.js';
import { newer } from './updater.js';

const DEADLINE = 6000;
const timed = (ms = DEADLINE) => AbortSignal.timeout(ms);

function version(cmd) {
  const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32', timeout: 5000 });
  return r.status === 0 ? String(r.stdout).trim().split('\n')[0] : null;
}

async function checkKey() {
  const key = nvidiaKey();
  if (!key) return { ok: false, name: 'API key', detail: 'not set', fix: `Add NVIDIA_API_KEY=nvapi-... to ${ENV_FILE} (free at build.nvidia.com)` };
  try {
    const r = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: DEFAULT_MODEL, messages: [{ role: 'user', content: 'ok' }], max_tokens: 1 }),
      signal: timed(),
    });
    if (r.status === 401 || r.status === 403) return { ok: false, name: 'API key', detail: 'rejected', fix: 'Check the key for typos, or make a new one' };
    const body = await r.json().catch(() => ({}));
    const meta = body?.error?.metadata?.headers ?? {};
    const left = r.headers.get('x-ratelimit-remaining') ?? meta['X-RateLimit-Remaining'];
    const reset = Number(r.headers.get('x-ratelimit-reset') ?? meta['X-RateLimit-Reset']);
    if (r.status === 429 && /per[- ]day|daily/i.test(`${body?.error?.message} ${body?.error?.metadata?.limit_source}`)) {
      const at = Number.isFinite(reset) ? new Date(reset).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'tomorrow';
      return { ok: false, name: 'Requests today', detail: 'daily free limit used up', fix: `It resets at ${at}; adding credit raises the limit` };
    }
    return { ok: true, name: 'API key', detail: left != null ? `works · ${left} free requests left today` : 'works' };
  } catch (err) {
    return { ok: false, name: 'API key', detail: `could not check (${err.name === 'TimeoutError' ? 'no answer' : err.message})`, fix: 'Check your internet connection' };
  }
}

async function checkVercel() {
  const token = process.env.VERCEL_TOKEN;
  if (!token) return { ok: null, name: 'Vercel', detail: 'no token — /deploy needs one', fix: `vercel.com/account/tokens → Create Token, then add VERCEL_TOKEN=... to ${ENV_FILE}` };
  try {
    const r = await fetch('https://api.vercel.com/v2/user', { headers: { Authorization: `Bearer ${token}` }, signal: timed() });
    if (!r.ok) return { ok: false, name: 'Vercel', detail: 'token rejected', fix: 'Make a new token at vercel.com/account/tokens' };
    const j = await r.json();
    return { ok: true, name: 'Vercel', detail: `ready to deploy as ${j.user?.username ?? 'you'}` };
  } catch {
    return { ok: false, name: 'Vercel', detail: 'could not reach Vercel', fix: 'Check your internet connection' };
  }
}

async function checkBrowser() {
  try {
    const { chromium } = await import('playwright-core');
    for (const channel of ['msedge', 'chrome']) {
      try {
        const b = await chromium.launch({ channel, headless: true, timeout: 8000 });
        await b.close();
        return { ok: true, name: 'Browser', detail: `${channel === 'msedge' ? 'Edge' : 'Chrome'} — look_at_app can see your apps` };
      } catch { /* try the next one */ }
    }
  } catch { /* playwright-core missing */ }
  return { ok: false, name: 'Browser', detail: 'no Edge or Chrome found', fix: 'Install Google Chrome or Microsoft Edge' };
}

async function checkVersion() {
  try {
    const r = await fetch('https://registry.npmjs.org/ucode-agent/latest', { signal: timed() });
    const latest = (await r.json()).version;
    return newer(latest, VERSION)
      ? { ok: null, name: 'ucode', detail: `${VERSION} · ${latest} is out`, fix: 'It updates itself on the next start, or: npm install -g ucode-agent' }
      : { ok: true, name: 'ucode', detail: `${VERSION} · up to date` };
  } catch {
    return { ok: true, name: 'ucode', detail: VERSION };
  }
}

function checkTools() {
  const [major] = process.versions.node.split('.').map(Number);
  const out = [
    major >= 22
      ? { ok: true, name: 'Node', detail: process.versions.node }
      : { ok: false, name: 'Node', detail: process.versions.node, fix: 'Install Node 22 or newer from nodejs.org' },
  ];
  const npm = version('npm');
  out.push(npm ? { ok: true, name: 'npm', detail: npm } : { ok: false, name: 'npm', detail: 'not found', fix: 'Reinstall Node, which includes npm' });
  const git = version('git');
  out.push(git ? { ok: true, name: 'git', detail: git.replace(/^git version /, '') } : { ok: null, name: 'git', detail: 'not found', fix: 'Optional — install git to keep history of your apps' });
  const cache = path.join(os.homedir(), '.ucode', 'cache');
  if (existsSync(cache)) out.push({ ok: true, name: 'Starter cache', detail: `${readdirSync(cache).length} ready` });
  return out;
}

/** Run every check; returns the lines to print. */
export async function runDoctor() {
  const results = [
    ...checkTools(),
    ...(await Promise.all([checkKey(), checkVercel(), checkBrowser(), checkVersion()])),
  ];
  const width = Math.max(...results.map((r) => r.name.length));
  const lines = ['', `  ${blue('ucode doctor')}`];
  for (const r of results) {
    const mark = r.ok === true ? theme.ok('✓') : r.ok === false ? theme.error('✗') : theme.warn('!');
    lines.push(`  ${mark} ${r.name.padEnd(width)}  ${r.detail}`);
    if (r.fix && r.ok !== true) lines.push(`    ${' '.repeat(width)}  ${dim(`→ ${r.fix}`)}`);
  }
  const bad = results.filter((r) => r.ok === false).length;
  lines.push('', bad ? `  ${bad} thing${bad === 1 ? '' : 's'} to fix` : `  ${theme.ok('All good')}`, '');
  return lines;
}
