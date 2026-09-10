/**
 * markdown.js — turning a reply into styled terminal text.
 *
 * Each surface gets its own Marked instance. The shared singleton cannot be
 * used: two markedTerminal extensions stacked on the same instance render
 * everything twice, which shows up as stray asterisks around every bold word.
 */

import chalk from 'chalk';
import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import { blue, sky, dim } from './theme.js';

export function renderer(width = 80) {
  const md = new Marked();
  md.use(
    markedTerminal(
      {
        code: chalk.reset,          // cli-highlight colours the body itself
        blockquote: dim.italic,
        heading: blue.bold,
        firstHeading: blue.bold,
        strong: chalk.bold,
        em: chalk.italic,
        codespan: sky,
        del: chalk.strikethrough,
        link: blue.underline,
        href: blue.underline,
        hr: dim('─'.repeat(Math.max(10, Math.min(width, 100) - 2))),
        tab: 2,
        width: Math.max(20, Math.min(width - 2, 100)),
        reflowText: false,          // never rewrap code or tables
        emoji: false,
      },
      { ignoreIllegals: true }
    )
  );
  return md;
}

/**
 * Mop up what marked-terminal leaves behind.
 *
 * Inline markdown inside list items comes through untouched, so `code` and
 * **bold** survive as literal punctuation. Bullet asterisks become real
 * bullets at the same time.
 */
export function polish(s) {
  return String(s)
    // Leading whitespace can be interleaved with colour codes, so allow both.
    .replace(/^((?:\s|\x1b\[[0-9;]*m)*)[*-] /gm, (_, lead) => `${lead}${blue('•')} `)
    .replace(/\*\*([^*\n]+)\*\*/g, (_, t) => chalk.bold(t))
    .replace(/`([^`\n]+)`/g, (_, t) => sky(t));
}

/** Render markdown, and never let a formatting bug swallow the answer. */
export function render(md, text) {
  if (!text?.trim()) return '';
  try {
    return polish(String(md.parse(text))).replace(/\n{3,}/g, '\n\n').trimEnd();
  } catch {
    return polish(text).trimEnd();
  }
}
