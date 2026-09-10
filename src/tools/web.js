/**
 * web.js — looking things up outside the project.
 *
 * Tavily, because it returns prose per result rather than search-engine
 * markup: the difference between something a model can use directly and
 * something it has to parse its way out of first.
 *
 * The key is separate from the model key. Without one the tool explains how to
 * turn it on and tells the model to answer from what it knows and say so —
 * which is a far better outcome than an opaque 401 mid-task.
 */

import { ToolFailure } from '../core/failure.js';
import { result } from './shared.js';

export async function webSearch({ query, max_results = 5 }) {
  if (typeof query !== 'string' || !query.trim()) {
    throw new ToolFailure({
      kind: 'bad_args',
      attempted: 'searching the web',
      failed: 'The "query" argument was missing or empty.',
      fix: 'Pass what you want to look up, as a string.',
    });
  }

  const search = query.trim();
  const key = (process.env.TAVILY_API_KEY ?? '').trim();

  if (!key) {
    throw new ToolFailure({
      kind: 'no_search_key',
      attempted: `searching the web for "${search}"`,
      failed: 'Web search is switched off — no TAVILY_API_KEY is set.',
      fix:
        'Answer from what you already know and say plainly that you could not check, ' +
        'so the user knows it may be out of date. Then tell them: a free key at ' +
        'https://tavily.com (1000 searches a month, no card) in ~/.ucode/.env as ' +
        'TAVILY_API_KEY=... turns this on.',
    });
  }

  const count = Math.min(Math.max(Number(max_results) || 5, 1), 10);
  let response;

  try {
    response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: key,
        query: search,
        max_results: count,
        search_depth: 'basic',
        include_answer: true,
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new ToolFailure({
      kind: err.name === 'TimeoutError' ? 'search_timeout' : 'network',
      attempted: `searching the web for "${search}"`,
      failed: err.name === 'TimeoutError'
        ? 'The search took more than 30 seconds.'
        : `Could not reach the search API: ${err.message}`,
      fix: 'Try once more. If it keeps failing, answer without it and say the search did not work.',
      cause: err,
    });
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new ToolFailure({
      kind: response.status === 401 ? 'bad_search_key' : 'search_failed',
      attempted: `searching the web for "${search}"`,
      failed: `The search API returned HTTP ${response.status}. ${body.slice(0, 200)}`,
      fix: response.status === 401
        ? 'TAVILY_API_KEY is wrong or expired — check it at https://tavily.com'
        : 'Retry once, then answer without it and say the search failed.',
    });
  }

  const data = await response.json().catch(() => ({}));
  const results = data.results ?? [];

  if (results.length === 0) return result(`Nothing came back for "${search}".`, 'no results');

  const body = results
    .map((r, i) =>
      `${i + 1}. ${r.title}\n   ${r.url}\n   ${(r.content ?? '').replace(/\s+/g, ' ').trim()}`)
    .join('\n\n');

  return result(
    (data.answer ? `In short: ${data.answer}\n\n` : '') + body,
    `${results.length} result${results.length === 1 ? '' : 's'}`
  );
}
