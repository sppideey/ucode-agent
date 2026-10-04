// Changing how ucode looks, and the terminal it runs in.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as themeModule from '../../src/ui/theme.js';
import {
  detectTerminal, cleanRequest, applyToWindowsTerminal, colourEscapes, customizeTerminal, resetTerminal,
} from '../../src/core/terminal.js';

import { Screen } from '../../src/ui/screen.js';

const { normaliseColour, saveLook, applyLook, readLook, SPINNERS, CREDIT } = themeModule;

export default async function ({ test, section, ok, eq, throws, tmp }) {
  section('your look');

  await test('the credit under the logo stays, whatever a look asks for', async () => {
    // What a red theme once left behind: the model wrote over the credit.
    const file = path.join(tmp, 'theme-credit.json');
    await fs.writeFile(file, JSON.stringify({ accent: '#ff2222', byline: 'bright red theme' }));
    try {
      const look = saveLook({ spinner: 'arc', byline: 'mine' }, { file });
      eq(readLook(file), { accent: '#ff2222', spinner: 'arc' }, 'an old byline in the file is dropped, a new one never saved');
      eq(look.byline, undefined);
      for (const cols of [120, 60]) {
        const output = { columns: cols, rows: 30, isTTY: true, write() {}, on() {}, off() {} };
        const input = { setRawMode() {}, resume() {}, pause() {}, setEncoding() {}, on() {} };
        const screen = new Screen({ cwd: tmp, input, output });
        screen.cols = cols;
        const header = themeModule.bare(screen.headerLines().join('\n'));
        ok(header.includes(CREDIT) && !header.includes('bright red theme'), `the credit is in the ${cols}-column header`);
      }
      eq(CREDIT, 'made and tested by om dixit');
    } finally {
      applyLook({});
    }
  });

  await test('colours are read from names, short and long hex, and rgb()', () => {
    eq(normaliseColour('Orange'), '#f97316');
    eq(normaliseColour('#ABC'), '#aabbcc');
    eq(normaliseColour('ff8c2b'), '#ff8c2b');
    eq(normaliseColour('rgb(255, 140, 43)'), '#ff8c2b');
    eq(normaliseColour('not a colour'), null);
  });

  await test('a saved look is applied at once to everything that imported the colours', () => {
    const file = path.join(tmp, 'theme.json');
    const before = themeModule.blue('x');
    try {
      const look = saveLook({ accent: 'orange', spinner: 'arc' }, { file });
      eq(look.accent, '#f97316');
      eq(look.spinner, 'arc');
      eq(themeModule.SPINNER, SPINNERS.arc, 'the spinner changed for every importer');
      eq(readLook(file), { accent: 'orange', spinner: 'arc' }, 'only what was asked is saved');
      ok(look.light !== '#8fbcff', 'the lighter step follows the accent');
      saveLook({ spinner: null }, { file });
      eq(readLook(file).spinner, undefined, 'null puts one value back');
      eq(saveLook({}, { reset: true, file }).accent, '#4d8dff');
    } finally {
      applyLook({});
    }
    eq(themeModule.blue('x'), before);
  });

  await test('a broken look file is ignored, never fatal', () => {
    eq(applyLook({ accent: 'nonsense', spinner: 'nope' }).accent, '#4d8dff');
    applyLook({});
  });

  section('your terminal');

  await test('the terminal is recognised from its environment', () => {
    eq(detectTerminal({ WT_SESSION: 'x' }, 'win32'), 'windows-terminal');
    eq(detectTerminal({ TERM_PROGRAM: 'Apple_Terminal' }, 'darwin'), 'apple-terminal');
    eq(detectTerminal({ TERM_PROGRAM: 'iTerm.app' }, 'darwin'), 'iterm');
    eq(detectTerminal({}, 'win32'), 'windows-console');
    eq(detectTerminal({}, 'linux'), 'other');
  });

  await test('requests are cleaned, and nonsense is refused', () => {
    eq(cleanRequest({ background: 'navy', font_size: '14.4', opacity: 85 }), { background: '#1e3a8a', font_size: 14, opacity: 85 });
    throws(() => cleanRequest({ background: 'blurple-ish' }));
    throws(() => cleanRequest({ font_size: 200 }));
  });

  await test('Windows Terminal: defaults and overriding profiles both change', () => {
    const next = applyToWindowsTerminal(
      { profiles: { defaults: {}, list: [{ name: 'PS', background: '#000000' }, { name: 'cmd' }] } },
      { background: '#1e3a8a', font_size: 14, opacity: 80 },
    );
    eq(next.profiles.defaults.background, '#1e3a8a');
    eq(next.profiles.defaults.font, { size: 14 });
    eq(next.profiles.defaults.useAcrylic, true);
    eq(next.profiles.list[0].background, '#1e3a8a', 'a profile with its own background follows');
    eq(next.profiles.list[1].background, undefined, 'one without is left to the defaults');
    const pictured = applyToWindowsTerminal(
      { profiles: { defaults: { backgroundImage: 'aurora.png', backgroundImageOpacity: 1 }, list: [{ backgroundImage: 'x.png' }] } },
      { background: '#000000' },
    );
    eq(pictured.profiles.defaults.backgroundImage, undefined, 'a picture over the colour is taken off');
    eq(pictured.profiles.defaults.backgroundImageOpacity, undefined);
    eq(pictured.profiles.list[0].backgroundImage, undefined, 'in a profile too');
  });

  await test('Windows Terminal settings change, with comments, and reset restores the file exactly', async () => {
    const local = path.join(tmp, 'local');
    const dir = path.join(local, 'Microsoft', 'Windows Terminal');
    await fs.mkdir(dir, { recursive: true });
    const original = '// my settings\n{ "profiles": { "defaults": {}, "list": [] }, }\n';
    await fs.writeFile(path.join(dir, 'settings.json'), original);
    const was = process.env.UCODE_TERMINAL_BACKUP;
    process.env.UCODE_TERMINAL_BACKUP = path.join(tmp, 'term-backup');
    try {
      const env = { WT_SESSION: '1', LOCALAPPDATA: local };
      const done = await customizeTerminal({ background: 'navy' }, { env, platform: 'win32' });
      ok(done.ok, done.message);
      const saved = JSON.parse(await fs.readFile(path.join(dir, 'settings.json'), 'utf8'));
      eq(saved.profiles.defaults.background, '#1e3a8a');
      ok((await resetTerminal({ env, platform: 'win32' })).ok);
      eq(await fs.readFile(path.join(dir, 'settings.json'), 'utf8'), original);
    } finally {
      if (was === undefined) delete process.env.UCODE_TERMINAL_BACKUP; else process.env.UCODE_TERMINAL_BACKUP = was;
    }
  });

  await test('other terminals get colour escapes for this session', async () => {
    eq(colourEscapes('other', { background: '#112233' }), '\x1b]11;#112233\x07');
    eq(colourEscapes('iterm', { foreground: '#ffffff' }), '\x1b]1337;SetColors=fg=ffffff\x07');
    let wrote = '';
    const done = await customizeTerminal({ background: '#112233', font_size: 14 }, { env: {}, platform: 'linux', write: (s) => { wrote += s; } });
    ok(done.ok && /font/.test(done.message), done.message);
    eq(wrote, '\x1b]11;#112233\x07');
    const old = await customizeTerminal({ background: 'navy' }, { env: {}, platform: 'win32', write: () => {} });
    ok(!old.ok, 'the old Windows console says it cannot');
  });
}
