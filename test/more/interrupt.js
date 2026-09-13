// Stopping a turn must actually stop it.
export default async function ({ test, section, ok, eq }) {
  const { Agent } = await import('../../src/core/loop.js').then(
    (m) => ({ Agent: m.Agent ?? m.Loop ?? m.default })
  ).catch(() => ({ Agent: null }));

  section('stopping a turn');

  // closeInterrupted only touches the message list, so it is exercised against
  // a stand-in with the same two fields rather than a whole live agent.
  const { Agent: Real } = await import('../../src/core/loop.js');
  const make = (messages) => {
    const fake = {
      working: messages,
      session: { messages: [...messages] },
      push(m) { this.session.messages.push(m); this.working.push(m); },
    };
    fake.closeInterrupted = Real.prototype.closeInterrupted.bind(fake);
    return fake;
  };

  await test('a tool call the turn never reached is answered, not left hanging', () => {
    const a = make([
      { role: 'user', content: 'build it' },
      { role: 'assistant', toolCalls: [{ id: 'c1', name: 'run_command' }, { id: 'c2', name: 'write_file' }] },
      { role: 'tool', toolCallId: 'c1', name: 'run_command', content: 'done' },
    ]);
    eq(a.closeInterrupted(), 1, 'one call was still open');
    const answer = a.working.find((m) => m.role === 'tool' && m.toolCallId === 'c2');
    ok(answer, 'c2 now has a result');
    ok(/did not happen/.test(answer.content), answer.content);
  });

  await test('and the user is on the record telling it to drop the task', () => {
    const a = make([
      { role: 'assistant', toolCalls: [{ id: 'c1', name: 'run_command' }] },
    ]);
    a.closeInterrupted();
    const last = a.working[a.working.length - 1];
    eq(last.role, 'user');
    ok(/do not pick it back up/i.test(last.content), last.content);
  });

  await test('an empty assistant turn never enters the conversation', async () => {
    // A message with no content and no tool calls is a hole, and a provider
    // rejects the whole conversation as malformed once one is in it: HTTP 400
    // on every request after the model went quiet, with the window at 0% full.
    const fsp = await import('node:fs/promises');
    const src = await fsp.readFile('src/core/loop.js', 'utf8');
    const rows = src.split("\n");
    const guards = ['reply.text &&', 'if (reply.text)', 'reply.text?.trim()'];
    const unguarded = rows.filter((l, i) => {
      if (!l.includes('content: reply.text }')) return false;
      const near = rows.slice(Math.max(0, i - 2), i + 1).join(' ');
      return !guards.some((g) => near.includes(g));
    });
    ok(unguarded.length === 0, 'pushed without checking there is text: ' + unguarded.join(' | '));
  });

  await test('the error hint does not blame a size that was not the problem', async () => {
    const src = await (await import('node:fs/promises')).readFile('src/core/provider.js', 'utf8');
    ok(!/Usually an oversized conversation/.test(src), 'the run that hit this was at 0% full');
  });

  await test('a turn that finished cleanly is left exactly as it is', () => {
    const msgs = [
      { role: 'assistant', toolCalls: [{ id: 'c1', name: 'run_command' }] },
      { role: 'tool', toolCallId: 'c1', name: 'run_command', content: 'done' },
      { role: 'assistant', content: 'All set.' },
    ];
    const a = make(msgs);
    eq(a.closeInterrupted(), 0, 'nothing was open');
    eq(a.working.length, 3, 'and nothing was added');
  });

  await test('several open calls are all closed, so nothing is left to resume', () => {
    const a = make([
      { role: 'assistant', toolCalls: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
    ]);
    eq(a.closeInterrupted(), 3);
    eq(a.working.filter((m) => m.role === 'tool').length, 3);
  });

  await test('the saved session gets the same closing, so a resume is not left mid-task', () => {
    const a = make([{ role: 'assistant', toolCalls: [{ id: 'x', name: 'run_command' }] }]);
    a.closeInterrupted();
    ok(a.session.messages.some((m) => m.role === 'tool' && m.toolCallId === 'x'),
      'the on-disk copy is closed out too');
  });
}
