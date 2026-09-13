/**
 * window.js — keeping a long conversation inside the model's context.
 *
 * Two rules, both of which exist because the obvious alternative is worse:
 *
 *   Summarize the oldest turns rather than dropping them. Dropping means the
 *   agent forgets a decision it made an hour ago and quietly contradicts it.
 *
 *   Never cut between a tool call and its result. A result with no call above
 *   it is unreadable to the model and to anyone debugging the transcript.
 *
 * Only what gets sent is affected. history.js keeps the full record on disk
 * whatever happens here.
 */

import { estimateConversation } from './provider.js';

/** Start folding once the conversation passes this share of the window. */
export const FOLD_AT = 0.75;

/**
 * ...or once it passes this many tokens, whichever comes first.
 *
 * A share of the window is a correctness threshold: it stops the request
 * being rejected. It is the wrong measure for speed. These endpoints re-read
 * the whole conversation on every step and none of them cache it, so a
 * hundred thousand tokens is a hundred thousand tokens re-read ten times
 * before the app is finished — and on a million-token model, three quarters
 * of the window is a build that has been crawling for an hour by the time
 * anything is folded.
 *
 * Folding costs one model call. Past this size, that call has already paid
 * for itself in the steps that follow it.
 */
export const FOLD_TOKENS = Number(process.env.UCODE_FOLD_TOKENS) || 80_000;

/** After folding, the verbatim tail may occupy this share of the window. */
export const KEEP = 0.4;

export function usage(messages, limit) {
  const used = estimateConversation(messages);
  return {
    used,
    limit,
    percent: limit > 0 ? Math.min(100, (used / limit) * 100) : 0,
    left: Math.max(0, limit - used),
  };
}

export function tooBig(messages, limit) {
  return usage(messages, limit).used > foldAbove(limit);
}

/** The size at which folding starts: whichever of the two rules bites first. */
export function foldAbove(limit) {
  return Math.min(limit * FOLD_AT, FOLD_TOKENS);
}

/**
 * Where to cut so the kept tail stands on its own.
 *
 * Walks backwards accumulating messages until the budget runs out, then nudges
 * the boundary forward past any tool result whose call would have been folded
 * away.
 */
function cutPoint(messages, budget) {
  let cut = messages.length;
  let left = budget;

  for (let i = messages.length - 1; i >= 0; i--) {
    const cost = estimateConversation([messages[i]]);
    if (left - cost < 0 && cut < messages.length) break;
    left -= cost;
    cut = i;
  }

  while (cut < messages.length && messages[cut].role === 'tool') cut++;

  // Whatever else happens, the most recent exchange survives intact.
  if (cut >= messages.length) cut = Math.max(0, messages.length - 1);
  return cut;
}

/**
 * Fold the older half of a conversation into a summary, if it needs it.
 *
 * @param {Array} messages
 * @param {object} o
 * @param {number} o.limit          token budget
 * @param {Function} o.summarize    async (older) => string
 */
export async function fold(messages, { limit, summarize }) {
  if (!tooBig(messages, limit)) return { messages, folded: false };

  // Half the size that triggered the fold, so there is room to work before
  // the next one. Sized off the same absolute rule, or a fold on a
  // million-token model would keep a tail that is instantly too big again and
  // summarize on every single step.
  const cut = cutPoint(messages, Math.min(limit * KEEP, foldAbove(limit) / 2));
  const older = messages.slice(0, cut);
  const recent = messages.slice(cut);

  // Nothing old enough to fold — the tail on its own is already oversized.
  if (older.length === 0) return { messages, folded: false };

  const summary = await summarize(older);

  return {
    folded: true,
    summary,
    droppedCount: older.length,
    messages: [
      {
        role: 'system',
        content:
          `Summary of the earlier part of this conversation. ${older.length} messages ` +
          `were folded away to stay inside the context window.\n\n${summary}\n\n` +
          'Treat all of that as settled context. Everything after this point is verbatim.',
        folded: true,
      },
      ...recent,
    ],
  };
}

/** What the summarizer is asked to do. */
export const SUMMARY_PROMPT =
  'Summarize this conversation so another engineer could pick it up mid-task with ' +
  'nothing else to go on. Keep, in this order: (1) what the user is trying to achieve, ' +
  '(2) which files were read or changed and what is in them, (3) decisions taken and the ' +
  'reasoning, (4) commands run and what they printed, (5) what is still unfinished. ' +
  'Name exact paths, functions and error messages. No preamble, no commentary.';

/**
 * Flatten the messages being folded into plain text for the summarizer.
 * Tool traffic is included but trimmed — that a tool ran and roughly what it
 * returned matters; its exact bytes almost never do.
 */
export function forSummary(messages) {
  return messages
    .map((m) => {
      if (m.role === 'tool') return `[${m.name} returned]\n${(m.content || '').slice(0, 300)}`;
      if (m.role === 'assistant') {
        const calls = (m.toolCalls || [])
          .map((c) => `[called ${c.name}(${JSON.stringify(c.args).slice(0, 200)})]`)
          .join('\n');
        return `assistant: ${m.content || ''}\n${calls}`.trim();
      }
      return `${m.role}: ${m.content || ''}`;
    })
    .join('\n\n');
}
