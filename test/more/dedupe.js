// Sending each file once, rather than every copy ever read.
import { dedupe } from '../../src/core/loop.js';

export default async function ({ test, section, ok, eq }) {
  section('sending each file once');

  const big = (tag) => `${tag} `.repeat(200); // comfortably over the threshold
  const read = (id, p) => ({ role: 'assistant', toolCalls: [{ id, name: 'read_file', args: { path: p } }] });
  const got = (id, text) => ({ role: 'tool', toolCallId: id, name: 'read_file', content: text });

  await test('the newest copy of a file is kept whole', () => {
    const out = dedupe([
      read('1', 'src/a.ts'), got('1', big('old')),
      read('2', 'src/a.ts'), got('2', big('new')),
    ]);
    eq(out[3].content, big('new'));
  });

  await test('an older copy becomes a line pointing at the newer one', () => {
    const out = dedupe([
      read('1', 'src/a.ts'), got('1', big('old')),
      read('2', 'src/a.ts'), got('2', big('new')),
    ]);
    ok(out[1].content.includes('src/a.ts'), out[1].content);
    ok(out[1].content.includes('further down'), 'it must say where the real one is');
    ok(out[1].content.length < 200, `still ${out[1].content.length} characters`);
  });

  await test('a file read once is untouched', () => {
    const msgs = [read('1', 'src/a.ts'), got('1', big('only'))];
    eq(dedupe(msgs)[1].content, big('only'));
  });

  await test('two different files do not collapse into each other', () => {
    const out = dedupe([
      read('1', 'src/a.ts'), got('1', big('a')),
      read('2', 'src/b.ts'), got('2', big('b')),
    ]);
    eq(out[1].content, big('a'));
    eq(out[3].content, big('b'));
  });

  await test('a short result is left alone: the note would be no smaller', () => {
    const out = dedupe([
      read('1', 'src/a.ts'), got('1', 'tiny'),
      read('2', 'src/a.ts'), got('2', 'tiny again'),
    ]);
    eq(out[1].content, 'tiny');
  });

  await test('three reads leave one copy, not three', () => {
    const msgs = [];
    for (const id of ['1', '2', '3']) { msgs.push(read(id, 'src/a.ts'), got(id, big(id))); }
    const out = dedupe(msgs);
    const results = out.filter((m) => m.role === 'tool');
    const whole = results.filter((m) => !m.content.startsWith('['));
    eq(whole.length, 1, 'exactly one full copy survives');
    eq(whole[0].content, big('3'), 'and it is the newest');
  });

  await test('a grep is only the same grep when the pattern matches too', () => {
    const grep = (id, pattern) => ({
      role: 'assistant', toolCalls: [{ id, name: 'grep', args: { path: '.', pattern } }],
    });
    const result = (id, text) => ({ role: 'tool', toolCallId: id, name: 'grep', content: text });
    const same = dedupe([grep('1', 'foo'), result('1', big('x')), grep('2', 'foo'), result('2', big('y'))]);
    ok(same[1].content.length < 200, 'the same search twice keeps the newer answer');
    const other = dedupe([grep('1', 'foo'), result('1', big('x')), grep('2', 'bar'), result('2', big('y'))]);
    eq(other[1].content, big('x'), 'a different search is a different answer');
  });

  await test('a write is never collapsed, only a read', () => {
    const msgs = [
      { role: 'assistant', toolCalls: [{ id: '1', name: 'write_file', args: { path: 'src/a.ts' } }] },
      { role: 'tool', toolCallId: '1', name: 'write_file', content: big('wrote') },
      { role: 'assistant', toolCalls: [{ id: '2', name: 'write_file', args: { path: 'src/a.ts' } }] },
      { role: 'tool', toolCallId: '2', name: 'write_file', content: big('wrote again') },
    ];
    eq(dedupe(msgs)[1].content, big('wrote'), 'what happened stays in the record');
  });

  await test('a conversation with no tool calls comes back as it was', () => {
    const msgs = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }];
    eq(dedupe(msgs), msgs);
  });

  await test('a result whose call is missing is left alone rather than guessed at', () => {
    const msgs = [{ role: 'tool', toolCallId: 'orphan', name: 'read_file', content: big('x') }];
    eq(dedupe(msgs)[0].content, big('x'));
  });
}
