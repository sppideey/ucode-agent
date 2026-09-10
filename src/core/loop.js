/**
 * loop.js — the agent itself.
 *
 * One turn, end to end: take a line, fold the conversation if it has grown too
 * big, ask the model, and if it asked for tools, run them and ask again. Repeat
 * until it answers with prose instead of a tool call.
 *
 * Two histories are kept, deliberately:
 *   session.messages  the complete record, written to disk after every step
 *   working           what is actually sent, which may have its older turns
 *                     folded into a summary once the window gets tight
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

import {
  ask, model, setModel, modelName, modelList, contextLimit, rateLimits,
  MODELS, DEFAULT_MODEL, PROVIDER,
} from './provider.js';
import {
  tools, runTool, describe, setRoot, setConfirm, PARALLEL_SAFE, WRITES,
} from '../tools/index.js';
import {
  newSession, save, load, list, removeAll, titleFrom,
} from './history.js';
import { fold, usage, tooBig, SUMMARY_PROMPT, forSummary } from './window.js';
import { loadSkills, catalogue, findSkill, skillMessage, autoLoadFor } from './skills.js';
import { Screen, isLabel } from '../ui/screen.js';
import { Plain } from '../ui/plain.js';
import { theme, blue, sky, dim, formatTokens, relativeTime, shortenPath, clip } from '../ui/theme.js';
import { Failure, ToolFailure, Declined } from './failure.js';

/**
 * Tool calls allowed in one turn.
 *
 * Scaffolding an app is dozens of writes before anything can even be run, so a
 * small ceiling stops a real job halfway through — which from the outside is
 * indistinguishable from the agent giving up for no reason. The runaway-loop
 * protection this exists for still works at 250; a loop burns through that
 * just as visibly, only later.
 */
const MAX_STEPS = Number(process.env.UCODE_MAX_STEPS) || 250;
const MAX_ARG_RETRIES = 2;

/**
 * How many times a reply cut off at the output limit is asked to carry on.
 * Three covers any answer a terminal should be printing; past that the model
 * is rambling and stopping is the kinder outcome.
 */
const MAX_CONTINUATIONS = 3;

/** Read-only tools whose result line adds nothing — the user saw the output. */
const QUIET = new Set(['read_file', 'list_dir', 'glob', 'grep', 'web_search']);

/** Skills reach the model as one extra tool, so bodies load only when wanted. */
const loadSkillTool = {
  name: 'load_skill',
  description:
    'Load the full instructions for one of the skills listed in your system prompt. ' +
    'Call it the moment a task matches one — before planning, before writing anything ' +
    '— then follow what it says.',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: 'The skill name, exactly as listed.' } },
    required: ['name'],
  },
};

function systemPrompt({ cwd, skills, mode, check }) {
  const list = catalogue(skills);

  return [
    'You are ucode, a coding agent working directly in the user\'s terminal.',
    '',
    `Working directory: ${cwd}`,
    `Platform: ${process.platform}`,
    '',
    '## How to work',
    '',
    ...(mode === 'plan' ? [
      'You are in PLAN MODE. Reading, searching and research are available; every tool',
      'that writes a file or runs a command has been withheld. Investigate, then set out',
      'what you would change: which files, which functions, in what order. Never imply',
      'you have made a change you are not able to make.',
      '',
    ] : []),
    ...(check ? [
      `This project checks itself with: ${check}`,
      'After changing code, run that and report what actually happened. "It should work"',
      'is not a result.',
      '',
    ] : []),
    '- Read before you write. Never edit a file you have not read this session.',
    '- Prefer edit_file to write_file. Rewrite a whole file only when creating it, or',
    '  when the change genuinely touches most of it.',
    '- old_string must be copied out of what read_file showed you, character for',
    '  character, without the line-number gutter, and must appear exactly once. Add',
    '  surrounding lines until it does.',
    '- read_file returns up to 600 lines. Read the whole file before editing it rather',
    '  than editing from a fragment; pass offset to continue a long one.',
    '- Use batch_write to lay out several new files at once, and multi_edit for several',
    '  changes to one file. One call beats five round trips.',
    '- run_command runs without asking. That is trust rather than licence: never run',
    '  anything destructive the user did not ask for.',
    '- Paths are relative to the working directory. Anything outside it needs the user',
    '  to approve it first.',
    '- Verify. After changing code, run the tests or a quick check with run_command.',
    '',
    '## Saying what you are doing',
    '',
    '- Before every tool call, write ONE short line naming the file or command:',
    '  "Reading tui.js", "Fixing the spinner in loop.js", "Running npm test".',
    '- Present tense, under ten words, and no full stop at the end. It is a label on',
    '  work happening right now, not a sentence about work that is finished.',
    '- That line and nothing else in the message. No preamble, no plan, no bullets —',
    '  the user reads it live while the tool runs.',
    '- Say the next one when you take the next step, not all of them up front.',
    '',
    '## Answering',
    '',
    '- Be short. Two or three sentences is usually the entire answer. This is a',
    '  terminal, not a document.',
    '- No preamble, no restating the question, no "I will now...". Just answer.',
    '- Do not narrate what the tool output already showed. The user watched the diff',
    '  and the command output; cover only what is not obvious from them.',
    '- Skip closing summaries of work the user just watched you do — but never end',
    '  a turn silently. If there is genuinely nothing to add, one short line saying',
    '  what changed is the whole answer.',
    '- Markdown. Fenced blocks with a language tag get highlighted.',
    '- Point at code as path:line so the user can jump straight to it.',
    '- Report honestly. If a command failed or you skipped something, say so.',
    '- Length tracks the question: a one-line question gets a one-line answer.',
    '- Brevity is about your prose and never about your work. What you build is',
    '  finished: every control wired, every state handled, no TODO left behind.',
    ...(list ? [
      '',
      '## Skills',
      '',
      'These instruction packs are available. When a task matches one, load it with',
      'load_skill as your first step — before planning, before writing anything — and',
      'then follow it. A skill already in this conversation outranks your own defaults',
      'and is not advisory.',
      '',
      list,
    ] : []),
  ].join('\n');
}

export class Agent {
  constructor({ cwd, debug = false }) {
    this.cwd = cwd;
    this.debug = debug;
    // A full-screen layout only makes sense on a real terminal. Piped input,
    // CI and `echo ... | ucode` get the line-based interface instead.
    this.full = Boolean(process.stdout.isTTY && process.stdin.isTTY);
    this.ui = this.full ? new Screen({ cwd }) : new Plain({ cwd });
    this.skills = [];
    this.session = newSession(cwd, model());
    this.working = [];
    this.loaded = new Set();
    this.abort = null;
    this.busy = false;
    this.check = null;
  }

  // -- history -------------------------------------------------------------

  push(message) {
    this.session.messages.push(message);
    this.working.push(message);
  }

  async persist() {
    try {
      this.session.model = model();
      await save(this.session);
    } catch (err) {
      // Losing the save must not lose the turn.
      this.ui.error(err, { debug: this.debug });
    }
  }

  // -- startup -------------------------------------------------------------

  /**
   * Everything a turn needs, minus the terminal.
   *
   * Split out of start() so another front end could prepare an agent and drive
   * turn() itself.
   */
  async bootstrap() {
    setRoot(this.cwd);
    setConfirm((request) => this.ui.confirm(request));
    this.skills = await loadSkills({ cwd: this.cwd });
    await this.detectCheck();
  }

  async start() {
    await this.bootstrap();

    if (this.full) {
      await this.ui.start();
      this.ui.onInterrupt = () => {
        if (this.busy && this.abort) {
          this.abort.abort();
          this.ui.stopSpinner();
          this.ui.note('interrupted');
        }
      };
      this.ui.onModeChange = () => this.showHeader({ clear: false });
    }

    for (const problem of this.skills.problems ?? []) {
      this.ui.write(theme.warn(`  skill not loaded: ${problem}`));
    }

    this.showHeader();
    this.installSignals();
    await this.repl();
  }

  showHeader({ clear = true } = {}) {
    if (clear && this.full) this.ui.clearScreen();
    const stats = usage(this.working, contextLimit());
    this.ui.header({
      cwd: this.cwd,
      model: modelName(),
      used: stats.used,
      limit: stats.limit,
      title: this.session.title === 'Untitled' ? 'new session' : this.session.title,
    });
  }

  installSignals() {
    const flush = async () => {
      await save(this.session).catch(() => {});
      process.exit(0);
    };
    process.on('SIGTERM', flush);

    // The full-screen UI reads keys itself, so it owns ctrl+c and esc.
    if (this.full) return;

    this.ui.rl.on('SIGINT', () => {
      if (this.busy && this.abort) {
        this.abort.abort();
        this.ui.stopSpinner();
        this.ui.write(dim('  interrupted'));
        return;
      }
      this.ui.write(dim('  (ctrl+d or /exit to quit)'));
      this.ui.rl.prompt();
    });
  }

  /**
   * How this project verifies itself, worked out once at startup. Null when
   * there is genuinely nothing to run — verification is only insisted on where
   * there is something to insist on.
   */
  async detectCheck() {
    const has = (f) => readFile(path.join(this.cwd, f)).then(() => true, () => false);

    if (await has('package.json')) {
      try {
        const pkg = JSON.parse(await readFile(path.join(this.cwd, 'package.json'), 'utf8'));
        if (pkg.scripts?.test && !/no test specified/i.test(pkg.scripts.test)) {
          this.check = 'npm test';
          return;
        }
      } catch { /* an unreadable package.json is not worth failing over */ }
    }
    if (await has('Cargo.toml')) { this.check = 'cargo test'; return; }
    if (await has('go.mod')) { this.check = 'go test ./...'; return; }
    if (await has('pyproject.toml') || await has('pytest.ini')) { this.check = 'pytest'; return; }
    if (await has('Makefile')) { this.check = 'make test'; return; }
    this.check = null;
  }

  // -- REPL ----------------------------------------------------------------

  async repl() {
    let sawInput = false;

    for (;;) {
      const line = await this.ui.ask();
      if (line === null) {
        // End of input before anything was typed. On Windows this is almost
        // always npm's PowerShell shim, which runs the CLI as `$input | node`.
        // The pipe makes stdin a non-TTY, readline hits EOF at once, and the
        // banner flashes up and vanishes — which looks like a crash rather
        // than like a program that was never given a keyboard. So say which.
        if (!sawInput && !process.stdin.isTTY) this.explainNoKeyboard();
        break;
      }

      const input = line.trim();
      if (input) sawInput = true;
      if (!input) continue;

      if (input.startsWith('/')) {
        if (await this.command(input) === 'exit') break;
        continue;
      }

      try {
        await this.turn(input);
      } catch (err) {
        this.ui.error(err, { debug: this.debug });
      }
    }

    await this.shutdown();
  }

  explainNoKeyboard() {
    this.ui.blank();
    this.ui.write(theme.warn('  ucode could not reach the keyboard, so it stopped.'));
    this.ui.blank();
    this.ui.write('  That happens when input is piped rather than typed. On Windows it is');
    this.ui.write("  usually npm's PowerShell wrapper, which pipes stdin.");
    this.ui.blank();
    this.ui.write(`  ${blue('Any of these work:')}`);
    this.ui.write(`    ${sky('ucode.cmd')}          the cmd shim, which keeps the keyboard`);
    this.ui.write(`    ${sky('npx ucode-agent')}    runs it directly`);
    this.ui.write('    or start it from Command Prompt or Windows Terminal');
    this.ui.blank();
  }

  async shutdown() {
    this.ui.stopSpinner();
    if (this.session.messages.length) {
      await this.persist();
      this.ui.write(dim(`\n  saved · ${this.session.title}`));
    }
    this.ui.close();
  }

  // -- one turn ------------------------------------------------------------

  /**
   * Pull image paths out of the message and load them, so "what is wrong in
   * screenshot.png" works without a separate command for it.
   */
  async attachImages(input) {
    const mentioned = input.match(/[^\s"']+\.(?:png|jpe?g|gif|webp)\b/gi) ?? [];
    const images = [];

    for (const name of mentioned) {
      const file = path.resolve(this.cwd, name);
      try {
        const buf = await readFile(file);
        if (buf.length > 4 * 1024 * 1024) {
          this.ui.note(`${name} is ${(buf.length / 1024 / 1024).toFixed(1)}MB — too big to send, skipped`);
          continue;
        }
        const ext = path.extname(file).toLowerCase().slice(1);
        images.push(`data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${buf.toString('base64')}`);
        this.ui.note(`attached ${name}`);
      } catch {
        // Just a filename mentioned in passing, not a file on disk.
      }
    }

    return images;
  }

  /**
   * Skills that this request should arrive with, already loaded.
   *
   * The load_skill tool asks the model to notice that a task needs a skill,
   * and a model in a hurry to be helpful does not always notice. For work
   * where the skill *is* the quality bar — anything with a user interface in
   * it — that is not a discovery to make after the app has been built. So the
   * request is matched against each skill's trigger words and the body goes in
   * before the model takes its first step.
   */
  autoLoad(input) {
    for (const skill of autoLoadFor(this.skills, input)) {
      if (this.loaded.has(skill.name)) continue;
      this.loaded.add(skill.name);
      this.push(skillMessage(skill, { automatic: true }));
      this.ui.note(`${skill.name} skill loaded for this`);
    }
  }

  async turn(input) {
    const images = await this.attachImages(input);
    this.push(images.length
      ? { role: 'user', content: input, images }
      : { role: 'user', content: input });

    if (!this.session.title || this.session.title === 'Untitled') {
      this.session.title = titleFrom(input);
    }

    this.autoLoad(input);
    await this.persist();

    this.busy = true;
    this.abort = new AbortController();

    try {
      await this.run();
    } catch (err) {
      if (err?.kind === 'aborted' || this.abort.signal.aborted) this.ui.write(dim('  turn cancelled'));
      else throw err;
    } finally {
      this.busy = false;
      this.abort = null;
      this.ui.stopSpinner();
      await this.persist();
      if (this.full) this.showHeader({ clear: false });
    }
  }

  /** The tools the model may see, given the mode. */
  toolsNow() {
    const all = [...tools, loadSkillTool];
    if (this.ui.mode !== 'plan') return all;
    return all.filter((t) => !WRITES.has(t.name));
  }

  /** Model, tools, model, until it answers with prose. */
  async run() {
    const available = this.toolsNow();
    let argRetries = 0;
    let continuations = 0;
    let askedToVerify = false;
    let askedToSpeak = false;

    this.touched = new Set();
    this.ranSomething = false;

    for (let step = 0; step < MAX_STEPS; step++) {
      await this.maybeFold();
      this.ui.startSpinner(step === 0 ? 'thinking' : 'working');

      let reply;
      let streaming = false;

      try {
        const opts = {
          signal: this.abort.signal,
          onWait: (text) => this.ui.updateSpinner(text),
        };
        // Only a real terminal has somewhere to stream into.
        if (this.full) {
          opts.onThinking = () => this.ui.thinkingDelta();
          opts.onText = (delta) => {
            if (!streaming) {
              streaming = true;
              this.ui.thinkingEnd();
              this.ui.streamBegin();
            }
            this.ui.streamDelta(delta);
          };
        }

        reply = await ask(
          [
            {
              role: 'system',
              content: systemPrompt({
                cwd: this.cwd,
                skills: this.skills,
                mode: this.ui.mode,
                check: this.check,
              }),
            },
            ...this.working,
          ],
          available,
          opts
        );
      } catch (err) {
        this.ui.thinkingEnd();
        if (streaming) this.ui.streamEnd();

        // The model invented a tool and the provider rejected the request
        // outright. Tell it what it did and let it try again.
        if (err.kind === 'bad_tool_call' && argRetries < MAX_ARG_RETRIES) {
          argRetries++;
          this.ui.stopSpinner();
          this.ui.toolFailed(
            `${err.detail?.attemptedName ?? 'invalid tool call'} — retrying (${argRetries}/${MAX_ARG_RETRIES})`
          );
          this.push({
            role: 'user',
            content:
              `Your last tool call was rejected. ${err.failed} The only tools that exist ` +
              `are: ${available.map((t) => t.name).join(', ')}. Try again with one of them.`,
          });
          continue;
        }
        throw err;
      }

      // A reply that is nothing but tool calls never starts a text stream, so
      // the thinking timer has to be closed out here as well.
      this.ui.thinkingEnd();
      this.ui.stopSpinner();
      this.record(reply.usage);

      // Streamed text is already on screen; turn it into rendered markdown.
      // Text that turns out to be narration ahead of a tool call folds into a
      // status line instead — that is where the live commentary comes from.
      const narrating = reply.toolCalls.length > 0;
      if (streaming) this.ui.streamEnd({ asNarration: narrating });
      else if (reply.text && narrating && isLabel(reply.text)) this.ui.narrate(reply.text);
      else if (reply.text) this.ui.assistant(reply.text);

      if (reply.toolCalls.length === 0) {
        // The answer stopped at the provider's output cap rather than at the
        // end of a thought, so it is cut mid-word. Ask for the rest instead of
        // handing over half an answer with no sign there was more.
        if (reply.finishReason === 'length' && reply.text && continuations < MAX_CONTINUATIONS) {
          continuations++;
          this.push({ role: 'assistant', content: reply.text });
          this.push({
            role: 'user',
            content:
              'Your reply stopped at the output limit, mid-sentence. Carry on from exactly ' +
              'where it broke off. Do not repeat any of it, do not start again, and do not ' +
              'introduce it — just continue.',
          });
          this.ui.note('hit the output limit — asking for the rest');
          continue;
        }

        // It changed code and never ran anything. Send it back once.
        if (this.touched.size && !this.ranSomething && this.check && !askedToVerify) {
          askedToVerify = true;
          if (reply.text) this.push({ role: 'assistant', content: reply.text });
          this.push({
            role: 'user',
            content:
              `You changed ${[...this.touched].join(', ')} and did not check it. Run ` +
              `\`${this.check}\` with run_command now, then say what actually happened — ` +
              'if it failed, show the output rather than claiming it worked. If that is ' +
              'the wrong way to check this project, run the right one and say which.',
          });
          this.ui.note('verifying the change');
          continue;
        }

        /**
         * It did the work and then said nothing at all.
         *
         * Reasoning models do this, and the instruction to skip closing
         * summaries makes it more likely. Silence is fine as a style; it is
         * not fine as an answer, because the user cannot tell it apart from a
         * crash — and if they asked what happened, they asked. One nudge,
         * once per turn, and only when there was actually work to report.
         */
        if (!reply.text?.trim() && this.touched.size + (this.ranSomething ? 1 : 0) > 0 && !askedToSpeak) {
          askedToSpeak = true;
          this.push({
            role: 'user',
            content:
              'You finished without saying anything. In one or two sentences: what did ' +
              'you change, and does it work? No preamble, no repeating the diffs.',
          });
          continue;
        }

        this.push({ role: 'assistant', content: reply.text });
        if (!reply.text?.trim()) this.ui.note('the model ended the turn without a reply');
        return;
      }

      this.push({ role: 'assistant', content: reply.text || '', toolCalls: reply.toolCalls });
      await this.persist();

      const badArgs = await this.runCalls(reply.toolCalls);
      if (this.abort.signal.aborted) return;

      // Malformed arguments go back to the model, but only so many times.
      if (badArgs) {
        argRetries++;
        if (argRetries > MAX_ARG_RETRIES) {
          throw new Failure({
            kind: 'bad_tool_args',
            attempted: 'running the tools the model asked for',
            failed:
              `${modelName()} produced invalid tool arguments ${argRetries} times running ` +
              'and could not correct itself.',
            fix:
              'Say what you want more concretely, or /model to another one — North Mini ' +
              'Code and Nemotron 3.5 Lightning are both steadier with tool arguments.',
          });
        }
      } else {
        argRetries = 0;
      }

      await this.persist();
    }

    throw new Failure({
      kind: 'step_limit',
      attempted: 'finishing your request',
      failed: `The model was still calling tools after ${MAX_STEPS} steps.`,
      fix:
        'Nothing is lost — everything so far is on disk. Say "carry on where you left ' +
        'off" to continue. If it was repeating one step, it is looping: break the task ' +
        'up, or /new to reset.',
    });
  }

  /**
   * Run one round of tool calls.
   *
   * Consecutive read-only calls go out together — four files read at once
   * rather than four round trips — while anything that writes or executes runs
   * on its own, in order. Returns whether any call had unusable arguments.
   */
  async runCalls(calls) {
    const groups = [];
    let batch = [];

    for (const call of calls) {
      if (PARALLEL_SAFE.has(call.name)) {
        batch.push(call);
      } else {
        if (batch.length) { groups.push(batch); batch = []; }
        groups.push([call]);
      }
    }
    if (batch.length) groups.push(batch);

    let badArgs = false;

    for (const group of groups) {
      if (this.abort.signal.aborted) return badArgs;

      const noted = (call) => {
        if (call.name === 'write_file' || call.name === 'edit_file' || call.name === 'multi_edit') {
          this.touched.add(call.args?.path ?? 'a file');
        }
        if (call.name === 'batch_write') {
          for (const f of call.args?.files ?? []) this.touched.add(f?.path ?? 'a file');
        }
        if (call.name === 'run_command' || call.name === 'run_commands') this.ranSomething = true;
      };

      if (group.length > 1) {
        for (const call of group) {
          this.ui.toolCall(describe(call.name, call.args));
          noted(call);
        }
        this.ui.startSpinner(`${group.length} lookups at once`);

        const settled = await Promise.all(
          group.map((call) => this.dispatch(call).then(
            (out) => ({ call, out }),
            (err) => ({ call, err })
          ))
        );

        this.ui.stopSpinner();
        for (const { call, out, err } of settled) {
          if (err) badArgs = this.reportFailure(call, err) || badArgs;
          else this.reportResult(call, out);
        }
        continue;
      }

      for (const call of group) {
        if (this.abort.signal.aborted) return badArgs;

        const label = describe(call.name, call.args);
        this.ui.toolCall(label);
        this.ui.startSpinner(label);
        noted(call);

        try {
          const out = await this.dispatch(call);
          this.ui.stopSpinner();
          this.reportResult(call, out);
        } catch (err) {
          this.ui.stopSpinner();
          badArgs = this.reportFailure(call, err) || badArgs;
        }
      }
    }

    return badArgs;
  }

  reportResult(call, out) {
    if (!QUIET.has(call.name)) this.ui.toolResult(out.summary);
    if (out.diff?.length) this.ui.diff(out.diff);
    if (out.output?.length) this.ui.commandOutput(out.output);
    this.push({ role: 'tool', toolCallId: call.id, name: call.name, content: out.content });
  }

  /** Show a tool failure, hand it to the model, and say if it was bad arguments. */
  reportFailure(call, err) {
    if (!(err instanceof ToolFailure)) throw err;

    this.ui.toolFailed(
      err instanceof Declined ? 'declined' : `${err.kind}: ${err.failed}`
    );
    this.push({
      role: 'tool',
      toolCallId: call.id,
      name: call.name,
      content: err.forModel(),
    });
    return err.kind === 'bad_args';
  }

  async dispatch(call) {
    // The model emitted arguments that were not valid JSON. Hand the parser's
    // own complaint straight back so it can correct itself next step.
    if (call.parseError) {
      throw new ToolFailure({
        kind: 'bad_args',
        attempted: `calling ${call.name}`,
        failed: `The arguments were not valid JSON: ${call.parseError}`,
        fix: `Call ${call.name} again with the arguments as one well-formed JSON object.`,
      });
    }

    if (call.name === 'load_skill') return this.loadSkill(call.args?.name);

    // Output reaches the screen as the command produces it, so a slow build is
    // something you watch rather than something you sit out in silence.
    return runTool(call.name, call.args ?? {}, {
      onOutput: (lines) => this.ui.progress(lines),
    });
  }

  loadSkill(name) {
    const skill = findSkill(this.skills, name);
    if (!skill) {
      // The available names go in `failed` rather than only in `fix`: the
      // transcript shows the failure line, and a bare "no such skill" leaves
      // the user guessing at what this session actually has.
      const available = this.skills.map((s) => s.name).join(', ') || '(none)';
      throw new ToolFailure({
        kind: 'no_such_skill',
        attempted: `loading the "${name}" skill`,
        failed: `There is no skill called "${name}". This session has: ${available}.`,
        fix: 'Use one of those names, or carry on without one.',
      });
    }

    if (this.loaded.has(skill.name)) {
      return { content: `The "${skill.name}" skill is already loaded above. Follow it.`, summary: 'already loaded' };
    }

    this.loaded.add(skill.name);
    this.push(skillMessage(skill));
    return {
      content: `Loaded "${skill.name}". Its instructions are in your context now — follow them.`,
      summary: `${skill.name} · ${skill.body.split('\n').length} lines`,
    };
  }

  record(u) {
    const total = this.session.usage;
    total.promptTokens += u.promptTokens || 0;
    total.outputTokens += u.outputTokens || 0;
    total.totalTokens += u.totalTokens || 0;
    total.turns += 1;
  }

  /** Fold older turns into a summary when the window gets tight. */
  async maybeFold() {
    const limit = contextLimit();
    if (!tooBig(this.working, limit)) return;

    this.ui.startSpinner('context is filling up — summarizing earlier turns');
    try {
      const result = await fold(this.working, {
        limit,
        summarize: async (older) => {
          const reply = await ask(
            [
              { role: 'system', content: SUMMARY_PROMPT },
              { role: 'user', content: forSummary(older) },
            ],
            [],
            { signal: this.abort?.signal, temperature: 0 }
          );
          return reply.text;
        },
      });

      this.ui.stopSpinner();
      if (result.folded) {
        this.working = result.messages;
        this.ui.note(
          `folded ${result.droppedCount} earlier messages into a summary ` +
          '(the full history is still saved in this session)'
        );
      }
    } catch (err) {
      // If summarizing fails, carry on with the full history and let the API
      // complain — better than silently throwing away the conversation.
      this.ui.stopSpinner();
      this.ui.note(`could not summarize older turns (${err.kind ?? 'error'}); carrying on uncompacted`);
    }
  }

  // -- slash commands ------------------------------------------------------

  async command(input) {
    const [name, ...rest] = input.split(/\s+/);
    const arg = rest.join(' ').trim();

    switch (name) {
      case '/help':
        return this.cmdHelp();

      // One thing, one command, however you happen to spell it.
      case '/model':
      case '/models':
        return this.cmdModel(arg);

      case '/session':
      case '/sessions':
      case '/resume':
        return this.cmdSessions(arg);

      case '/new':      return this.cmdNew();
      case '/skills':   return this.cmdSkills();
      case '/clear':    this.showHeader(); return;
      case '/search':   return this.cmdSearch(arg);
      case '/copy':     return this.cmdCopy();
      case '/exit':
      case '/quit':     return 'exit';

      default:
        this.ui.write(theme.warn(`  no such command: ${name}`));
        this.ui.note('/help lists them.');
    }
  }

  cmdHelp() {
    const rows = [
      ['/help', 'this list'],
      ['/model', 'show the models and switch between them'],
      ['/resume', 'pick up an earlier conversation'],
      ['/new', 'save this one and start fresh'],
      ['/skills', 'what ucode knows how to do'],
      ['/search <query>', 'look something up on the web'],
      ['/copy', 'copy the last reply to the clipboard'],
      ['/clear', 'clear the screen, keep the conversation'],
      ['/exit', 'save and quit'],
    ];

    this.ui.blank();
    for (const [command, what] of rows) {
      this.ui.write(`  ${blue(command.padEnd(18))} ${dim(what)}`);
    }
    this.ui.blank();
    this.ui.write(dim('  /models, /session and /sessions do the same as /model and /resume.'));
    this.ui.write(dim('  ctrl+b swaps plan and build · esc stops a running turn · ctrl+d quits'));
    this.ui.blank();
  }

  /** The five models, and this session's spend. */
  async cmdModel(arg) {
    if (arg) {
      try {
        setModel(arg);
      } catch (err) {
        this.ui.error(err, { debug: this.debug });
        return;
      }
      this.session.model = model();
      this.ui.note(`now using ${modelName()}`);
      this.showHeader({ clear: false });
      return;
    }

    const all = modelList();
    const width = Math.max(...all.map((m) => m.name.length));

    if (this.ui.pick) {
      const items = all.map((m) => ({
        label:
          `${m.active ? blue('●') : dim('○')} ${m.star ? blue('★') : ' '} ` +
          `${m.name.padEnd(width)}  ${dim(`${formatTokens(m.context)} · ${m.note}`)}`,
      }));

      const chosen = await this.ui.pick(items, {
        active: Math.max(0, all.findIndex((m) => m.active)),
        hint: '↑↓ move · enter to switch · esc to cancel',
      });
      if (chosen === null) return;

      setModel(all[chosen].id);
      this.session.model = model();
      this.ui.note(`now using ${modelName()}`);
      this.showHeader({ clear: false });
      return;
    }

    this.ui.blank();
    for (const m of all) {
      this.ui.write(
        `  ${m.active ? blue('●') : dim('○')} ${m.star ? blue('★') : ' '} ` +
        `${(m.active ? blue : dim)(m.name.padEnd(width))}  ${dim(`${formatTokens(m.context)} · ${m.note}`)}`
      );
      this.ui.write(`      ${dim(m.id)}`);
    }

    const u = this.session.usage;
    const live = rateLimits();
    this.ui.blank();
    this.ui.write(
      `  ${dim('this session')}  ${u.turns} turns · ${formatTokens(u.totalTokens)} tokens ` +
      `(${formatTokens(u.promptTokens)} in, ${formatTokens(u.outputTokens)} out)`
    );
    if (live?.requestsRemaining != null && live?.requestsLimit) {
      this.ui.write(`  ${dim('requests')}      ${live.requestsRemaining} of ${live.requestsLimit} left`);
    }
    this.ui.blank();
    this.ui.write(dim('  /model <id> switches without the picker.'));
    this.ui.blank();
  }

  /**
   * One row per saved conversation.
   *
   * A list of titles and timestamps is not enough to recognise your own work
   * by — half of them start "Fix the". So each row carries what it was about
   * and how far it got, and the ones from this folder are marked, because that
   * is nearly always the one being looked for.
   */
  describeSession(s, width) {
    const room = Math.max(24, Math.min(46, width - 34));
    const mark = s.mine ? blue('●') : dim('○');
    const when = relativeTime(s.updatedAt).padEnd(9);
    const turns = `${s.turns} turn${s.turns === 1 ? '' : 's'}`.padEnd(9);
    const where = s.mine ? 'here' : shortenPath(s.cwd, 26);

    return {
      label: `${mark} ${clip(s.title, room).padEnd(room)}  ${dim(when)}${dim(turns)}${dim(where)}`,
      sub: s.preview ? dim(`     ${clip(s.preview, width - 10)}`) : '',
    };
  }

  async cmdSessions(arg) {
    if (arg === '--clear' || arg === 'clear') {
      const yes = await this.ui.confirm({
        action: 'delete every saved conversation',
        detail: 'This cannot be undone.',
        risk: 'write',
      });
      if (!yes) {
        this.ui.note('cancelled');
        return;
      }
      await removeAll();
      this.ui.note('all sessions deleted');
      return;
    }

    const sessions = await list({ cwd: this.cwd });
    if (!sessions.length) {
      this.ui.note('no saved conversations yet');
      return;
    }

    for (const bad of sessions.unreadable ?? []) {
      this.ui.write(theme.warn(`  could not read session file: ${bad}`));
    }

    const shown = sessions.slice(0, 25);
    const width = this.ui.width ? this.ui.width() : 80;
    let index;

    if (arg) {
      const n = Number(arg);
      if (!Number.isInteger(n) || n < 1 || n > shown.length) {
        this.ui.write(theme.warn(`  "${arg}" is not one of 1-${shown.length}`));
        return;
      }
      index = n - 1;
    } else if (this.ui.pick) {
      const here = shown.filter((s) => s.mine).length;
      index = await this.ui.pick(
        shown.map((s) => this.describeSession(s, width)),
        {
          hint:
            `↑↓ move · enter to continue · esc to cancel` +
            (here ? ` — ${here} from this folder` : '') +
            (sessions.length > shown.length ? ` · ${sessions.length - shown.length} older not shown` : ''),
        }
      );
      if (index === null) return;
    } else {
      this.ui.blank();
      index = await this.ui.choose(
        'continue which?',
        shown.map((s) => this.describeSession(s, width).label)
      );
      if (index === null) return;
    }

    if (this.session.messages.length) await this.persist();
    if (await this.resume(shown[index].id)) {
      this.showHeader();
      this.replayTail();
    }
  }

  async resume(id) {
    try {
      const loaded = await load(id);
      this.session = loaded;
      this.working = [...loaded.messages];
      this.loaded = new Set(loaded.messages.filter((m) => m.skill).map((m) => m.skill));
      if (loaded.model && MODELS[loaded.model]) setModel(loaded.model);
      return true;
    } catch (err) {
      this.ui.error(err, { debug: this.debug });
      this.ui.note('Starting a fresh one instead.');
      return false;
    }
  }

  /** The last few exchanges, so a resumed conversation has visible context. */
  replayTail(count = 4) {
    const tail = this.session.messages
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content)
      .slice(-count);

    for (const m of tail) {
      if (m.role === 'user') this.ui.write(`${blue('›')} ${dim(m.content.split('\n')[0])}`);
      else this.ui.assistant(m.content);
    }
    if (tail.length) this.ui.write(dim('  ── picking up here ──\n'));
  }

  async cmdNew() {
    if (this.session.messages.length) {
      await this.persist();
      this.ui.note(`saved · ${this.session.title}`);
    }
    this.session = newSession(this.cwd, model());
    this.working = [];
    this.loaded = new Set();
    this.showHeader();
  }

  async cmdSkills() {
    // Re-read from disk. Skills load once at startup, so one written during
    // this session would otherwise stay invisible — and load_skill would fail
    // on a name the user can see in the folder.
    this.skills = await loadSkills({ cwd: this.cwd });
    for (const problem of this.skills.problems ?? []) {
      this.ui.write(theme.warn(`  skill not loaded: ${problem}`));
    }

    if (!this.skills.length) {
      this.ui.note('no skills found — add a folder with a SKILL.md under .ucode/skills');
      return;
    }

    this.ui.blank();
    for (const s of this.skills) {
      const live = this.loaded.has(s.name);
      const auto = s.triggers.length ? dim('  · loads itself') : '';
      this.ui.write(`  ${live ? blue('●') : dim('○')} ${blue(s.name)}${auto}`);
      this.ui.write(`    ${dim(s.description)}`);
    }
    this.ui.blank();
    this.ui.write(dim('  ● already loaded here · ucode pulls one in when the task matches'));
    this.ui.blank();
  }

  async cmdSearch(query) {
    if (!query) {
      this.ui.note('usage: /search <what you want to look up>');
      return;
    }
    await this.turn(
      `Search the web for: ${query}\n\nUse web_search, then summarise what you found and cite the URLs.`
    );
  }

  /** Copy the last reply. Every platform ships a clipboard pipe. */
  async cmdCopy() {
    const last = [...this.session.messages]
      .reverse()
      .find((m) => m.role === 'assistant' && m.content?.trim());

    if (!last) {
      this.ui.note('nothing to copy yet');
      return;
    }

    const tool = process.platform === 'win32' ? 'clip'
      : process.platform === 'darwin' ? 'pbcopy'
      : 'xclip -selection clipboard';

    try {
      await new Promise((resolve, reject) => {
        const child = spawn(tool, { shell: true, windowsHide: true });
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
        child.stdin.end(last.content);
      });
      const lines = last.content.split('\n').length;
      this.ui.note(`copied ${lines} line${lines === 1 ? '' : 's'}`);
    } catch (err) {
      this.ui.error(new Failure({
        kind: 'clipboard_failed',
        attempted: 'copying the last reply',
        failed: `${tool} could not run: ${err.message}`,
        fix: process.platform === 'linux'
          ? 'Install xclip (apt install xclip), or select the text with the mouse.'
          : 'Select the text with the mouse instead.',
      }), { debug: this.debug });
    }
  }
}

export { DEFAULT_MODEL, PROVIDER };
