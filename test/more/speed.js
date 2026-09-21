// Speed: the three things that decide how long a small app takes.
//
// Round trips are nearly all of it — ten to forty seconds each on a free
// endpoint — and everything here is about not spending one. One call instead
// of four for a one-page app, no install to wait through, and a request that
// is not carrying tools and instructions the job cannot use.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createApp } from '../../src/tools/scaffold.js';
import { hasCode } from '../../src/core/context.js';
import { skillMessage } from '../../src/core/skills.js';
import { tools, FILE_WRITES, describe } from '../../src/tools/index.js';

export default async function ({ test, section, ok, eq, sandbox }) {
  section('one call, not four');

  const read = (rel) => fs.readFile(path.join(sandbox, rel), 'utf8');

  await test('create_app writes the app in the same call it scaffolds it', async () => {
    const out = await createApp({
      folder: 'oneshot', name: 'Oneshot', description: 'a tasks app', install: false,
      files: [
        { path: 'oneshot/index.html', content: '<!doctype html><title>Oneshot</title><h1>Mine</h1>' },
        { path: 'oneshot/app.js', content: 'export const go = () => 1;\n' },
      ],
    });
    ok((await read('oneshot/index.html')).includes('Mine'), 'my file won over the starter\'s');
    ok((await read('oneshot/app.js')).includes('export const go'), 'and so did the module');
    ok(/2 written/.test(out.summary), out.summary);
    ok(out.diff?.length, 'the change still comes back as diff rows for the transcript');
  });

  await test('the starter hands back the files it wrote, so they are never read again', async () => {
    const out = await createApp({ folder: 'handback', name: 'Handback', install: false });
    for (const f of ['index.html', 'styles.css', 'app.js']) {
      ok(out.content.includes(`=== handback/${f} ===`), `${f} should come back in full`);
    }
    ok(out.content.includes('<title>Handback</title>'), 'and with the placeholders already filled in');
    ok(out.content.includes('do not read them back'), 'and say so');
  });

  await test('a file written in the call is not also handed back', async () => {
    const out = await createApp({
      folder: 'partial', name: 'Partial', install: false,
      files: [{ path: 'partial/app.js', content: 'const mine = 1;\n' }],
    });
    ok(!out.content.includes('=== partial/app.js ==='), 'no point returning what was just sent');
    ok(out.content.includes('=== partial/styles.css ==='), 'the other two still come back');
  });

  await test('those files count as changes, so the checks see them', () => {
    ok(FILE_WRITES.has('create_app'), 'create_app writes files now');
  });

  await test('files written the other ways a model writes them still land', async () => {
    const { runTool } = await import('../../src/tools/index.js');

    // As a JSON string, which is how a nested argument most often arrives.
    await runTool('create_app', {
      folder: 'shaped1', name: 'Shaped',
      files: JSON.stringify([{ path: 'shaped1/app.js', content: 'const a = 1;\n' }]),
    });
    ok((await read('shaped1/app.js')).includes('const a = 1'), 'a JSON string is read, not refused');

    // As a path -> contents map.
    await runTool('create_app', {
      folder: 'shaped2', name: 'Shaped',
      files: { 'shaped2/app.js': 'const b = 2;\n' },
    });
    ok((await read('shaped2/app.js')).includes('const b = 2'), 'a map is read too');

    // With the keys named something adjacent.
    await runTool('create_app', {
      folder: 'shaped3', name: 'Shaped',
      files: [{ file: 'shaped3/app.js', text: 'const c = 3;\n' }],
    });
    ok((await read('shaped3/app.js')).includes('const c = 3'), 'and so are the near-miss key names');
  });

  await test('a bad file entry is caught before the folder exists, so the retry works', async () => {
    const there = (rel) => fs.access(path.join(sandbox, rel)).then(() => true, () => false);
    let failed = null;
    try {
      await createApp({ folder: 'retry', name: 'Retry', install: false, files: [{ path: 'retry/app.js' }] });
    } catch (err) { failed = err; }
    ok(failed?.kind === 'bad_args', `expected bad_args, got ${failed?.kind}`);
    ok(!(await there('retry')), 'nothing was created, so create_app can simply be called again');
    await createApp({
      folder: 'retry', name: 'Retry', install: false,
      files: [{ path: 'retry/app.js', content: 'const ok = 1;\n' }],
    });
    ok(await there('retry/app.js'), 'and the corrected call goes through');
  });

  await test('the handed-back files stop being re-sent a few steps later', async () => {
    const { lean } = await import('../../src/core/loop.js');
    const call = (id) => ({ role: 'assistant', content: '', toolCalls: [{ id, name: 'run_command', args: {} }] });
    const messages = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'create_app', args: {} }] },
      { role: 'tool', toolCallId: 'a', name: 'create_app', content: 'x'.repeat(3000) },
      call('b'), { role: 'tool', toolCallId: 'b', name: 'run_command', content: 'ok' },
      call('c'), { role: 'tool', toolCallId: 'c', name: 'run_command', content: 'ok' },
      call('d'), { role: 'tool', toolCallId: 'd', name: 'run_command', content: 'ok' },
    ];
    const out = lean(messages);
    ok(out[1].content.length < 500, 'the starter files are not re-sent on every step forever');
    ok(out[1].content.includes('3000 characters'), out[1].content.slice(0, 80));
  });

  section('plain html unless a server is really needed');

  await test('the default starter installs nothing', async () => {
    await createApp({ folder: 'quick', name: 'Quick', install: false });
    const there = (rel) => fs.access(path.join(sandbox, rel)).then(() => true, () => false);
    ok(await there('quick/index.html'), 'a page');
    ok(!(await there('quick/package.json')), 'and nothing to install');
  });

  await test('the tool description leads with it', () => {
    const schema = tools.find((t) => t.name === 'create_app');
    ok(/"plain-html" \(the default\)/.test(schema.description), schema.description.slice(0, 120));
    ok(schema.parameters.properties.files?.type === 'array', 'and takes the app itself');
  });

  await test('the line on screen names the starter that is actually used', () => {
    eq(describe('create_app', { name: 'Tide' }), 'Creating Tide from the HTML starter');
    ok(describe('create_app', { name: 'Tide', template: 'next-shadcn' }).includes('Next.js'));
    ok(describe('create_app', { name: 'Tide', files: [1, 2, 3] }).includes('with 3 files'));
  });

  section('blocks, so the model types less');

  await test('a plain page gets the plain blocks, in its own blocks/ folder', async () => {
    const { runTool } = await import('../../src/tools/index.js');
    await createApp({ folder: 'blocky', name: 'Blocky', install: false });
    const out = await runTool('add_block', { name: 'item-list', folder: 'blocky' });
    ok(out.summary.includes('ItemList'), out.summary);
    const written = await read('blocky/blocks/item-list.js');
    ok(written.includes('export function ItemList'), 'the block is there to edit');
    ok(!/^import /m.test(written), 'a page with no build step cannot import from anywhere');
    ok(out.content.includes("from './blocks/item-list.js'"), 'and it is told how to use it');
  });

  await test('asking for a React block in a plain page says so, rather than half-working', async () => {
    const { runTool } = await import('../../src/tools/index.js');
    let failed = null;
    try { await runTool('add_block', { name: 'data-table', folder: 'blocky' }); } catch (err) { failed = err; }
    ok(failed?.kind === 'no_such_block', `expected no_such_block, got ${failed?.kind}`);
    ok(/React block/.test(failed.failed), failed.failed);
    ok(/item-list/.test(failed.fix), 'and points at the ones that do fit');
  });

  await test('the listing is the set for the app it was asked about', async () => {
    const { runTool } = await import('../../src/tools/index.js');
    const out = await runTool('add_block', { folder: 'blocky' });
    ok(out.content.includes('item-list') && out.content.includes('store'), out.content.slice(0, 120));
    ok(!out.content.includes('data-table'), 'no React blocks offered to a plain page');
  });

  await test('every listed plain block exists and parses', async () => {
    const { PLAIN_BLOCK_NAMES, PLAIN_CATALOGUE } = await import('../../src/tools/blocks.js');
    ok(PLAIN_BLOCK_NAMES.length >= 6, `${PLAIN_BLOCK_NAMES.length} blocks`);
    for (const name of PLAIN_BLOCK_NAMES) {
      const source = await fs.readFile(path.join('templates', 'blocks', 'plain', `${name}.js`), 'utf8');
      const first = PLAIN_CATALOGUE[name].exports.split(',')[0].trim();
      ok(source.includes(`export function ${first}`) || source.includes(`export const ${first}`),
        `${name} should export ${first}`);
      // Written for a browser with no build step: no bare imports, and every
      // colour taken from the starter's variables rather than hardcoded — so
      // re-tinting the palette re-tints the blocks too. theme-toggle is the
      // exception because it *is* a palette: the light one.
      ok(!/^import\s/m.test(source), `${name} must not import anything`);
      if (name === 'theme-toggle') continue;
      ok(!/#[0-9a-f]{6}(?![^(]*\))/i.test(source.replace(/var\([^)]*\)/g, '')), `${name} should use the CSS variables`);
    }
  });

  await test('a block added twice is left alone, so edits survive', async () => {
    const { runTool } = await import('../../src/tools/index.js');
    await runTool('add_block', { name: 'store', folder: 'blocky' });
    const again = await runTool('add_block', { name: 'store', folder: 'blocky' });
    eq(again.summary, 'already there');
  });

  section('progress while the reply is still arriving');

  await test('the file being written is named as its arguments stream', async () => {
    const { Writing } = await import('../../src/core/loop.js');
    const w = new Writing();
    const whole = JSON.stringify({
      folder: 'tide',
      files: [
        { path: 'tide/index.html', content: 'x'.repeat(900) },
        { path: 'tide/styles.css', content: 'y'.repeat(900) },
        { path: 'tide/app.js', content: 'z'.repeat(900) },
      ],
    });

    // Fed the way a provider feeds it: a growing string, forty characters at
    // a time, with a path landing across a chunk boundary now and then.
    const said = [];
    for (let n = 40; n <= whole.length; n += 40) {
      const line = w.seen(0, 'create_app', whole.slice(0, n));
      if (line) said.push(line);
    }
    ok(said.some((l) => l.includes('tide/index.html')), said.join(' | '));
    ok(said.some((l) => l.includes('tide/app.js')), said.join(' | '));
    ok(said.at(-1).includes('3 files so far'), said.at(-1));
  });

  await test('a read is not announced as a write', async () => {
    const { Writing } = await import('../../src/core/loop.js');
    const w = new Writing();
    eq(w.seen(0, 'read_files', '{"paths":["a.js"],"path":"a.js"}'), null);
  });

  section('a conversation that does not get slower and slower');

  await test('folding starts at a size, not just at a share of the window', async () => {
    const { foldAbove, FOLD_TOKENS, FOLD_AT } = await import('../../src/core/window.js');
    // A small window folds on the share, as it always did — that rule is
    // about the request being rejected, and it still has to hold.
    eq(foldAbove(64_000), 64_000 * FOLD_AT);
    // A huge one folds on the token count, because three quarters of a
    // million tokens is an hour of crawling before anything happens.
    eq(foldAbove(1_000_000), FOLD_TOKENS);
  });

  await test('what is kept after a fold leaves room to work', async () => {
    const { foldAbove } = await import('../../src/core/window.js');
    const { estimateConversation } = await import('../../src/core/provider.js');
    const { fold } = await import('../../src/core/window.js');

    const limit = 1_000_000;
    const messages = [];
    while (estimateConversation(messages) < foldAbove(limit) * 1.2) {
      messages.push({ role: 'user', content: 'x'.repeat(4000) });
      messages.push({ role: 'assistant', content: 'y'.repeat(4000) });
    }
    const out = await fold(messages, { limit, summarize: async () => 'the earlier part' });
    ok(out.folded, 'it folded');
    const after = estimateConversation(out.messages);
    ok(after <= foldAbove(limit) * 0.75,
      `${after} tokens left, which must be well under the ${foldAbove(limit)} that triggered it`);
  });

  section('a request that carries only what the job can use');

  await test('an empty folder has no code in it, and a project does', () => {
    ok(!hasCode('(the folder is empty — this is a new project)'));
    ok(!hasCode('./\n  README.md\n  notes.txt'));
    ok(!hasCode('./\n  index.html\n  styles.css'), 'markup and styles are nothing to look up');
    ok(hasCode('./\n  app.js · state, render'), 'a module is');
    ok(hasCode('src/\n  main.py · run'), 'and so is python');
    ok(!hasCode('./\n  package.json'), 'json is not code to rename');
  });

  await test('a new project goes out without the tools it has nothing to point at', async () => {
    const { Agent } = await import('../../src/core/loop.js');
    const agent = new Agent({ cwd: sandbox });
    agent.ui.mode = 'build';

    agent.fresh = true;
    agent.wantsWeb = false;
    const fresh = agent.toolsNow().map((t) => t.name);
    for (const gone of ['find_symbol', 'outline', 'rename_symbol', 'type_of', 'web_search']) {
      ok(!fresh.includes(gone), `${gone} has nothing to work on yet`);
    }
    for (const kept of ['create_app', 'batch_write', 'read_files', 'run_command', 'load_skill']) {
      ok(fresh.includes(kept), `${kept} is how the app gets built`);
    }

    agent.wantsWeb = true;
    ok(agent.toolsNow().some((t) => t.name === 'web_search'), 'a request that asks to search keeps it');

    agent.fresh = false;
    agent.wantsWeb = false;
    ok(agent.toolsNow().some((t) => t.name === 'find_symbol'), 'and code brings them all back');
  });

  await test('a tool that was not offered is refused, not quietly run', async () => {
    const { Agent } = await import('../../src/core/loop.js');
    const agent = new Agent({ cwd: sandbox });
    agent.ui.mode = 'build';
    agent.fresh = true;
    agent.wantsWeb = false;
    agent.offering = new Set(agent.toolsNow().map((t) => t.name));

    let failed = null;
    try {
      await agent.dispatch({ name: 'rename_symbol', args: { path: 'a.js', from: 'a', to: 'b' } });
    } catch (err) { failed = err; }
    ok(failed?.kind === 'no_such_tool', `expected no_such_tool, got ${failed?.kind}`);
    ok(/not available/.test(failed.failed), failed.failed);
  });

  await test('the ui-ux skill loads short, and says where the rest is', async () => {
    const full = await fs.readFile('skills/ui-ux/SKILL.md', 'utf8');
    const digest = await fs.readFile('skills/ui-ux/DIGEST.md', 'utf8');
    ok(digest.length < full.length / 2, `${digest.length} vs ${full.length}`);
    for (const rule of ['contrast', 'focus', 'empty', 'loading', 'error']) {
      ok(digest.toLowerCase().includes(rule), `the digest still says something about ${rule}`);
    }
    const skill = { name: 'ui-ux', body: full, digest };
    const short = skillMessage(skill, { automatic: true, short: true });
    ok(short.short, 'it went out as the short form');
    ok(short.content.includes('load_skill("ui-ux")'), 'and points at the whole thing');
    ok(!short.content.includes(full.slice(200, 400)), 'the long body did not go with it');
    ok(!skillMessage(skill).short, 'load_skill still delivers the full body');
    ok(!skillMessage({ name: 'x', body: 'b', digest: '' }, { short: true }).short, 'a skill with no digest is unaffected');
  });
}
