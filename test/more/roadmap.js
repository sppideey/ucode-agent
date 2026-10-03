// The 1.64 upgrades: thinking, design checks, lessons, undo, settings, MCP, commands.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { hueOf, purpleGradient, genericLook } from '../../src/core/genericcheck.js';
import { kindsIn, noteMistakes, lessonsText } from '../../src/core/lessons.js';
import { withScope, SCOPE_NOTE, EDIT_NOTE, DIRECTIONS, directionNote } from '../../src/core/scope.js';
import { withoutStock, trimAnswer } from '../../src/ui/theme.js';
import { commandKey, isAllowed, loadSettings, runHook } from '../../src/core/settings.js';
import { paceDelay, rpmFor } from '../../src/core/provider.js';
import { cleanSchema, toolName, McpHub, resultText } from '../../src/core/mcp.js';
import { loadCommands, expandCommand } from '../../src/core/commands.js';
import { relatedCommand } from '../../src/core/tests.js';
import { Snapshots } from '../../src/core/snapshot.js';

export default async function ({ test, section, ok, eq, tmp }) {
  section('roadmap: design checks');

  await test('colours resolve to hues, greys to none', () => {
    eq(hueOf('#ff0000'), 0);
    eq(hueOf('purple'), 300);
    eq(hueOf('#888888'), null);
    eq(hueOf('hsl(270 80% 60%)'), 270);
  });

  await test('the purple-to-blue gradient is caught, a warm one is not', () => {
    ok(purpleGradient('background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);'));
    ok(!purpleGradient('background: linear-gradient(90deg, #f97316, #facc15);'));
    ok(!purpleGradient('background: linear-gradient(#000, #fff);'), 'greys are not a hue');
  });

  await test('a starter-coloured, Inter, gradient-text app is flagged; a designed one is not', async () => {
    const dir = path.join(tmp, 'generic-app');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'styles.css'), ':root { --accent: #2dd4bf; }\nbody { font-family: Inter, sans-serif; }\nh1 { background-clip: text; }');
    await fs.writeFile(path.join(dir, 'index.html'), '<link rel="stylesheet" href="styles.css"><button>🗑️</button><button>✏️</button><h2>🔥 Hot</h2>');
    const found = await genericLook(dir, 'plain-html');
    eq(found.length, 4, found.join(' | '));
    await fs.writeFile(path.join(dir, 'styles.css'), ':root { --accent: #c2410c; }\nbody { font-family: "DM Sans", sans-serif; }');
    await fs.writeFile(path.join(dir, 'index.html'), '<link rel="stylesheet" href="styles.css"><button>Delete</button>');
    eq((await genericLook(dir, 'plain-html')).length, 0);
  });

  section('roadmap: lessons');

  await test('fix rounds are counted and repeated ones become lessons', async () => {
    const file = path.join(tmp, 'lessons.json');
    const was = process.env.UCODE_LESSONS;
    delete process.env.UCODE_LESSONS;
    try {
      eq(kindsIn('the script in this page does not parse\nNOTHING HAPPENS'), ['js-parse', 'dead-button']);
      await noteMistakes('NOTHING HAPPENS', file);
      eq(await lessonsText(file), '', 'once is not a pattern');
      await noteMistakes('NOTHING HAPPENS', file);
      ok((await lessonsText(file)).includes('Wire every control'));
    } finally {
      process.env.UCODE_LESSONS = was;
    }
  });

  section('roadmap: requests');

  await test('a build gets a direction and the scope note; a change gets the edit note', () => {
    const built = withScope('make a quiz app', { pick: () => 0 });
    ok(built.includes(`tone ${DIRECTIONS[0].tone}`) && built.endsWith(SCOPE_NOTE));
    eq(withScope('fix the login bug', { hasCode: true }), `fix the login bug\n\n${EDIT_NOTE}`);
    eq(withScope('fix the login bug'), 'fix the login bug', 'not in an empty folder');
    eq(withScope('why is it slow?', { hasCode: true }), 'why is it slow?');
    ok(directionNote(() => 0.99).includes(DIRECTIONS.at(-1).accent));
  });

  await test('stock sentences leave the closing message; how to try it stays', () => {
    const out = withoutStock('Tide is built. It has a sleek, modern feel. Open tide/index.html for a seamless start.');
    eq(out, 'Tide is built. Open tide/index.html for a seamless start.');
    eq(withoutStock('A seamless app.'), 'A seamless app.', 'never empty');
    ok(!trimAnswer('Done. Enjoy this stunning app!').includes('stunning'));
  });

  section('roadmap: permissions and hooks');

  await test('always-allow keys and matching', () => {
    eq(commandKey('npm test -- --watch'), 'npm test');
    eq(commandKey('ls -la'), 'ls -la');
    eq(commandKey('node -e "x()"'), 'node -e "x()"', 'never shortened past a flag');
    ok(isAllowed(['npm test'], 'npm test -- --watch'));
    ok(!isAllowed(['npm test'], 'npm testify'));
    ok(!isAllowed(['npm test'], 'npm test && rm -rf /'), 'a chain is never covered');
    ok(isAllowed(['mcp:github__x'], 'mcp:github__x'));
  });

  await test('settings merge, and a hook runs with the files', async () => {
    const dir = path.join(tmp, 'settings-proj');
    await fs.mkdir(path.join(dir, '.ucode'), { recursive: true });
    await fs.writeFile(path.join(dir, '.ucode', 'settings.json'), JSON.stringify({ commands: 'ask', allow: ['npm test'], hooks: { afterEdit: 'echo hi' } }));
    const s = await loadSettings(dir, { userFile: path.join(tmp, 'none.json') });
    eq(s.commands, 'ask');
    eq(s.allow, ['npm test']);
    eq(s.projectHooks.afterEdit, ['echo hi']);
    const run = await runHook('node -e "console.log(process.env.UCODE_FILES)"', { cwd: dir, files: ['a.js'] });
    eq(run.code, 0);
    eq(run.output, 'a.js');
  });

  await test('trust covers the scripts a hook runs, not just its text', async () => {
    const { isTrusted, trust } = await import('../../src/core/settings.js');
    const dir = path.join(tmp, 'trust-proj');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'guard.js'), 'safe');
    const file = path.join(tmp, 'trusted.json');
    const hooks = { beforeCommand: ['node guard.js'] };
    await trust(dir, 'project', hooks, file);
    ok(await isTrusted(dir, 'project', hooks, file));
    await fs.writeFile(path.join(dir, 'guard.js'), 'swapped');
    ok(!(await isTrusted(dir, 'project', hooks, file)), 'a swapped script asks again');
  });

  section('roadmap: pacing');

  await test('requests are spaced only past the per-minute limit', () => {
    eq(paceDelay([1000, 2000], 3000, 3), 0);
    eq(paceDelay([1000, 2000, 2500], 3000, 3), 58_000);
    eq(paceDelay([1000, 2000, 2500], 3000, 0), 0, 'off');
    const was = process.env.UCODE_RPM;
    delete process.env.UCODE_RPM;
    const url = process.env.UCODE_BASE_URL;
    delete process.env.UCODE_BASE_URL;
    eq(rpmFor('gemini-3.5-flash-lite'), 14);
    eq(rpmFor('gemini-3.5-flash'), 9);
    process.env.UCODE_BASE_URL = 'http://localhost:11434/v1';
    eq(rpmFor('llama3'), 0, 'a local server is not paced');
    if (url === undefined) delete process.env.UCODE_BASE_URL; else process.env.UCODE_BASE_URL = url;
    process.env.UCODE_RPM = was;
  });

  section('roadmap: MCP');

  await test('schemas are cut to what Gemini accepts', () => {
    const clean = cleanSchema({
      $schema: 'x', type: 'object', additionalProperties: false, required: ['q', 'gone'],
      properties: { q: { type: ['string', 'null'], format: 'uri' }, n: { type: 'integer', default: 3 } },
    });
    eq(clean, { type: 'object', required: ['q'], properties: { q: { type: 'string', nullable: true }, n: { type: 'integer' } } });
    eq(toolName('my server', 'get.thing'), 'my_server__get_thing');
    eq(resultText({ content: [{ type: 'text', text: 'hi' }] }), 'hi');
  });

  await test('a stdio server is started, listed and called', async () => {
    const server = path.join(tmp, 'fake-mcp.mjs');
    await fs.writeFile(server, `
      import readline from 'node:readline';
      const rl = readline.createInterface({ input: process.stdin });
      const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
      rl.on('line', (line) => {
        const m = JSON.parse(line);
        if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake' } } });
        if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } });
        if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'echo: ' + m.params.arguments.text }] } });
      });`);
    const hub = new McpHub();
    const [status] = await hub.start([{ name: 'fake', command: process.execPath, args: [server] }]);
    try {
      ok(status.ok, status.error);
      eq(hub.tools().map((t) => t.name), ['fake__echo']);
      eq((await hub.call('fake__echo', { text: 'hi' })).text, 'echo: hi');
    } finally {
      hub.close();
    }
  });

  await test('a server that cannot start is reported, not fatal', async () => {
    const hub = new McpHub();
    const [status] = await hub.start([{ name: 'nope', command: 'ucode-no-such-command-xyz' }]);
    hub.close();
    ok(!status.ok && status.error);
  });

  section('roadmap: commands and tests');

  await test('custom slash commands load and expand', async () => {
    const dir = path.join(tmp, 'cmd-proj');
    await fs.mkdir(path.join(dir, '.ucode', 'commands'), { recursive: true });
    await fs.writeFile(path.join(dir, '.ucode', 'commands', 'Explain.md'), '# Explain code\nExplain $ARGUMENTS simply.');
    const cmds = await loadCommands(dir, { userDir: path.join(tmp, 'no-user-cmds') });
    eq(cmds.get('explain').description, 'Explain code');
    ok(expandCommand(cmds.get('explain').body, 'loop.js').includes('Explain loop.js simply.'));
    eq(expandCommand('Review this.', 'carefully'), 'Review this.\n\ncarefully');
  });

  await test('go and cargo projects get their own test commands', () => {
    eq(relatedCommand('go', ['pkg/a.go', 'main.go']), 'go test ./pkg/... ./...');
    eq(relatedCommand('cargo', ['src/lib.rs']), 'cargo test --quiet');
    eq(relatedCommand('cargo', ['README.md']), null);
  });

  section('roadmap: snapshots');

  await test('undo puts back edits, deletions and new files, commands included', async () => {
    const dir = path.join(tmp, 'snap-proj');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'a.txt'), 'one');
    await fs.writeFile(path.join(dir, 'b.txt'), 'keep me');
    const was = process.env.UCODE_SNAPSHOTS;
    delete process.env.UCODE_SNAPSHOTS;
    try {
      const snaps = new Snapshots(dir, { home: path.join(tmp, 'snap-home') });
      const id = await snaps.take('before');
      ok(id, 'a snapshot was taken (needs git)');
      await fs.writeFile(path.join(dir, 'a.txt'), 'two');
      await fs.rm(path.join(dir, 'b.txt'));
      await fs.writeFile(path.join(dir, 'new.txt'), 'made by a command');
      const out = await snaps.restore(id);
      eq(out.failed, []);
      eq(await fs.readFile(path.join(dir, 'a.txt'), 'utf8'), 'one');
      eq(await fs.readFile(path.join(dir, 'b.txt'), 'utf8'), 'keep me');
      ok(!(await fs.access(path.join(dir, 'new.txt')).then(() => true, () => false)), 'new file removed');
    } finally {
      process.env.UCODE_SNAPSHOTS = was;
    }
  });
}
