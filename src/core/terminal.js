// SPDX-License-Identifier: AGPL-3.0-only - ucode, made and tested by om dixit. Additional terms: see NOTICE.
/**
 * terminal.js — changing the terminal ucode runs in, when the user asks:
 * "make my terminal dark green", "bigger font", "a bit see-through".
 *
 * Each terminal keeps its look somewhere different, so each gets its own way:
 *
 *   Windows Terminal  its settings.json, which it reloads the moment it is saved.
 *                     Kept: every new tab looks the same. The file as it was is
 *                     backed up first, and `reset` puts it back.
 *   Terminal.app      AppleScript on the window ucode is in: colours, cursor,
 *                     font and size. That window only; the old values are kept
 *                     so `reset` can restore them.
 *   iTerm2            its escape sequence for colours, this session only.
 *   anything else     the standard xterm escapes for colours, this session only.
 *
 * Nothing here runs unless the user asked, and the loop asks before it does.
 */

import { execFile } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jsonrepair } from 'jsonrepair';
import { normaliseColour, hexRGB } from '../ui/theme.js';

export const BACKUP_DIR = path.join(os.homedir(), '.ucode', 'terminal-backup');
const backups = () => process.env.UCODE_TERMINAL_BACKUP || BACKUP_DIR;

/** Which terminal this is, from what it puts in the environment. */
export function detectTerminal(env = process.env, platform = process.platform) {
  if (env.WT_SESSION) return 'windows-terminal';
  if (env.TERM_PROGRAM === 'Apple_Terminal') return 'apple-terminal';
  if (env.TERM_PROGRAM === 'iTerm.app' || env.LC_TERMINAL === 'iTerm2') return 'iterm';
  if (env.TERM_PROGRAM === 'vscode') return 'vscode';
  if (platform === 'win32') return 'windows-console';
  return 'other';
}

export const TERMINAL_NAMES = {
  'windows-terminal': 'Windows Terminal',
  'apple-terminal': 'Terminal',
  iterm: 'iTerm2',
  vscode: 'the VS Code terminal',
  'windows-console': 'the Windows console',
  other: 'this terminal',
};

/** Where Windows Terminal keeps its settings: the Store build, Preview, or unpackaged. */
export function windowsTerminalSettings(env = process.env) {
  const local = env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  const candidates = [
    path.join(local, 'Packages', 'Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'LocalState', 'settings.json'),
    path.join(local, 'Packages', 'Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe', 'LocalState', 'settings.json'),
    path.join(local, 'Microsoft', 'Windows Terminal', 'settings.json'),
  ];
  return candidates.find((f) => existsSync(f)) ?? null;
}

/** What was asked for, cleaned: colours as #rrggbb, a sane size and opacity. */
export function cleanRequest(req = {}) {
  const out = {};
  for (const key of ['background', 'foreground', 'cursor']) {
    if (req[key] === undefined || req[key] === null || req[key] === '') continue;
    const colour = normaliseColour(req[key]);
    if (!colour) throw new Error(`"${req[key]}" is not a colour ucode can read — use a name like "navy" or a hex like #1e1e2e`);
    out[key] = colour;
  }
  if (req.font_size !== undefined && req.font_size !== null && req.font_size !== '') {
    const size = Number(req.font_size);
    if (!Number.isFinite(size) || size < 6 || size > 48) throw new Error('font_size should be a number from 6 to 48');
    out.font_size = Math.round(size);
  }
  if (req.font) out.font = String(req.font).replace(/["\\\r\n]/g, '').slice(0, 60);
  if (req.opacity !== undefined && req.opacity !== null && req.opacity !== '') {
    const opacity = Number(req.opacity);
    if (!Number.isFinite(opacity) || opacity < 20 || opacity > 100) throw new Error('opacity should be a number from 20 to 100');
    out.opacity = Math.round(opacity);
  }
  return out;
}

const IMAGE_KEYS = ['backgroundImage', 'backgroundImageOpacity', 'backgroundImageStretchMode', 'backgroundImageAlignment'];

/** Whether any profile draws a picture behind the text. */
export const hasBackgroundImage = (settings) => {
  const profiles = Array.isArray(settings?.profiles) ? settings.profiles : [settings?.profiles?.defaults, ...(settings?.profiles?.list ?? [])];
  return profiles.some((p) => p?.backgroundImage);
};

/** Windows Terminal: set the look on the defaults, and on any profile that overrides it. */
export function applyToWindowsTerminal(settings, want) {
  const next = structuredClone(settings);
  if (Array.isArray(next.profiles)) next.profiles = { defaults: {}, list: next.profiles };
  next.profiles ??= {};
  next.profiles.defaults ??= {};
  const set = (profile) => {
    if (want.background) {
      profile.background = want.background;
      // A background picture is drawn over the colour, so a colour set under
      // one never shows: asked for black, the window stayed the picture's
      // purple while ucode said it had changed. The picture goes, and the
      // backup keeps it for /theme terminal reset.
      for (const key of IMAGE_KEYS) delete profile[key];
    }
    if (want.foreground) profile.foreground = want.foreground;
    if (want.cursor) profile.cursorColor = want.cursor;
    if (want.font || want.font_size) {
      profile.font = { ...(profile.font ?? {}), ...(want.font ? { face: want.font } : {}), ...(want.font_size ? { size: want.font_size } : {}) };
    }
    if (want.opacity !== undefined) {
      profile.opacity = want.opacity;
      profile.useAcrylic = want.opacity < 100;
    }
  };
  set(next.profiles.defaults);
  // A profile with its own value would hide the default, so it changes too.
  const keys = ['background', 'foreground', 'cursorColor', 'font', 'opacity', 'backgroundImage'];
  for (const profile of next.profiles.list ?? []) {
    if (keys.some((k) => profile[k] !== undefined)) set(profile);
  }
  return next;
}

const run = (file, args) => new Promise((resolve) => {
  execFile(file, args, { windowsHide: true, timeout: 15_000 }, (err, stdout, stderr) =>
    resolve({ ok: !err, out: String(stdout ?? '').trim(), err: String(stderr || err?.message || '').trim() }));
});

/** AppleScript's colours run 0-65535. */
const appleColour = (hex) => `{${hexRGB(hex).map((v) => v * 257).join(', ')}}`;
const TAB = 'selected tab of front window';

async function appleTerminal(want) {
  const backup = path.join(backups(), 'apple-terminal.json');
  if (!existsSync(backup)) {
    const get = await run('osascript', ['-e', `tell application "Terminal" to get {background color, normal text color, cursor color, font name, font size} of ${TAB}`]);
    if (get.ok) {
      await fs.mkdir(backups(), { recursive: true });
      await fs.writeFile(backup, JSON.stringify({ raw: get.out }));
    }
  }
  const lines = [];
  if (want.background) lines.push(`set background color of ${TAB} to ${appleColour(want.background)}`);
  if (want.foreground) lines.push(`set normal text color of ${TAB} to ${appleColour(want.foreground)}`);
  if (want.cursor) lines.push(`set cursor color of ${TAB} to ${appleColour(want.cursor)}`);
  if (want.font) lines.push(`set font name of ${TAB} to "${want.font}"`);
  if (want.font_size) lines.push(`set font size of ${TAB} to ${want.font_size}`);
  if (!lines.length) return { ok: false, message: 'Terminal can change colours, the cursor, the font and its size here — not the opacity.' };
  const script = ['tell application "Terminal"', ...lines.map((l) => `  ${l}`), 'end tell'].join('\n');
  const done = await run('osascript', ['-e', script]);
  return done.ok
    ? { ok: true, message: `Changed this Terminal window${want.opacity !== undefined ? ' (opacity is not something Terminal lets ucode set)' : ''}.` }
    : { ok: false, message: `Terminal refused: ${done.err}. macOS may need ucode's terminal allowed under Privacy & Security > Automation.` };
}

/** The escape sequences for colours: iTerm2's own, or the xterm ones nearly everything reads. */
export function colourEscapes(kind, want) {
  const hex = (h) => h.slice(1);
  if (kind === 'iterm') {
    return [
      want.background && `\x1b]1337;SetColors=bg=${hex(want.background)}\x07`,
      want.foreground && `\x1b]1337;SetColors=fg=${hex(want.foreground)}\x07`,
      want.cursor && `\x1b]1337;SetColors=curbg=${hex(want.cursor)}\x07`,
    ].filter(Boolean).join('');
  }
  return [
    want.foreground && `\x1b]10;${want.foreground}\x07`,
    want.background && `\x1b]11;${want.background}\x07`,
    want.cursor && `\x1b]12;${want.cursor}\x07`,
  ].filter(Boolean).join('');
}

/**
 * Change the terminal. Resolves to { ok, message } and never throws on a
 * terminal that cannot do it; throws only on a request that makes no sense.
 */
export async function customizeTerminal(request, { env = process.env, platform = process.platform, write = (s) => process.stdout.write(s) } = {}) {
  const want = cleanRequest(request);
  if (!Object.keys(want).length) throw new Error('Say what to change: background, foreground, cursor, font, font_size or opacity.');
  const kind = detectTerminal(env, platform);

  if (kind === 'windows-terminal') {
    const file = windowsTerminalSettings(env);
    if (!file) return { ok: false, message: 'Could not find Windows Terminal\'s settings.json.' };
    const text = await fs.readFile(file, 'utf8');
    if (!text.trim()) return { ok: false, message: 'Windows Terminal\'s settings.json is empty, so it was left alone.' };
    let settings;
    try {
      settings = JSON.parse(jsonrepair(text.replace(/^﻿/, '')));
    } catch {
      return { ok: false, message: 'Windows Terminal\'s settings.json could not be read, so it was left alone.' };
    }
    await fs.mkdir(backups(), { recursive: true });
    const backup = path.join(backups(), 'windows-terminal.json');
    if (!existsSync(backup)) await fs.writeFile(backup, JSON.stringify({ file, text }));
    const next = applyToWindowsTerminal(settings, want);
    await fs.writeFile(file, `${JSON.stringify(next, null, 4)}\n`);
    // Read back what Windows Terminal will read, rather than trusting the write.
    const check = JSON.parse(await fs.readFile(file, 'utf8'));
    if (want.background && check.profiles?.defaults?.background !== want.background) {
      return { ok: false, message: 'Windows Terminal\'s settings did not take the change.' };
    }
    const picture = want.background && hasBackgroundImage(settings)
      ? ' Its background picture was taken off so the colour shows (it comes back with /theme terminal reset).'
      : '';
    return { ok: true, message: `Changed Windows Terminal — every tab, and it stays.${picture} "/theme terminal reset" puts it back.` };
  }

  if (kind === 'apple-terminal') return appleTerminal(want);

  if (kind === 'windows-console') {
    return { ok: false, message: 'The old Windows console cannot be changed from here. Windows Terminal (free in the Microsoft Store) can.' };
  }

  const escapes = colourEscapes(kind, want);
  if (!escapes) return { ok: false, message: `${TERMINAL_NAMES[kind]} only lets ucode change its colours, not the font or opacity.` };
  write(escapes);
  const skipped = want.font || want.font_size || want.opacity !== undefined ? ' The font and opacity are not something it lets ucode set.' : '';
  return { ok: true, message: `Changed ${TERMINAL_NAMES[kind]}'s colours for this session.${skipped}` };
}

/** Put the terminal back as it was before ucode changed it. */
export async function resetTerminal({ env = process.env, platform = process.platform, write = (s) => process.stdout.write(s) } = {}) {
  const kind = detectTerminal(env, platform);
  if (kind === 'windows-terminal') {
    const backup = path.join(backups(), 'windows-terminal.json');
    if (!existsSync(backup)) return { ok: false, message: 'ucode has not changed Windows Terminal, so there is nothing to put back.' };
    const { file, text } = JSON.parse(await fs.readFile(backup, 'utf8'));
    await fs.writeFile(file, text);
    await fs.rm(backup, { force: true });
    return { ok: true, message: 'Windows Terminal is back the way it was.' };
  }
  if (kind === 'apple-terminal') {
    const backup = path.join(backups(), 'apple-terminal.json');
    if (!existsSync(backup)) return { ok: false, message: 'ucode has not changed this Terminal window.' };
    const { raw } = JSON.parse(await fs.readFile(backup, 'utf8'));
    const n = raw.split(/,\s*/);
    // {r,g,b} three times, then the font name and size.
    if (n.length >= 11) {
      const colour = (i) => `{${n.slice(i, i + 3).join(', ')}}`;
      await run('osascript', ['-e', [
        'tell application "Terminal"',
        `  set background color of ${TAB} to ${colour(0)}`,
        `  set normal text color of ${TAB} to ${colour(3)}`,
        `  set cursor color of ${TAB} to ${colour(6)}`,
        `  set font name of ${TAB} to "${n[9].replace(/"/g, '')}"`,
        `  set font size of ${TAB} to ${Number(n[10]) || 12}`,
        'end tell',
      ].join('\n')]);
    }
    await fs.rm(backup, { force: true });
    return { ok: true, message: 'This Terminal window is back the way it was.' };
  }
  write(kind === 'iterm' ? '\x1b]1337;SetColors=preset=Default\x07' : '\x1b]110\x07\x1b]111\x07\x1b]112\x07');
  return { ok: true, message: 'The terminal\'s own colours are back.' };
}
