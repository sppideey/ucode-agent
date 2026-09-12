/**
 * types.js — asking the app's own TypeScript what something actually is.
 *
 * The model guesses at APIs. It writes `user.fullName` because that is what
 * the property ought to be called, and finds out from a build forty seconds
 * later that it is `displayName`. Every editor solves this by asking a
 * language service, and the answer is already installed: the project's own
 * TypeScript, the same version and the same tsconfig that its build uses.
 *
 * So this loads the project's typescript — never one of ours, which would
 * answer for a different version of the language — and keeps a language
 * service open on it. Asking is then a few milliseconds, and the answer is
 * the one the build will give.
 *
 * A project without TypeScript installed gets a plain sentence saying so.
 * Nothing is installed to make this work.
 */

import { promises as fs } from 'node:fs';
import { statSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveIn, guard, result } from './shared.js';

/** The nearest folder above `from` holding both a tsconfig and a typescript. */
export function projectRootFor(from, root) {
  let dir = path.resolve(from);
  const stop = path.resolve(root);
  for (;;) {
    if (existsSync(path.join(dir, 'tsconfig.json'))) return dir;
    const up = path.dirname(dir);
    if (up === dir || !dir.startsWith(stop)) return null;
    dir = up;
  }
}

/** The project's own typescript, or null if it has none. */
async function loadTypeScript(projectDir) {
  let dir = projectDir;
  for (;;) {
    const entry = path.join(dir, 'node_modules', 'typescript', 'lib', 'typescript.js');
    if (existsSync(entry)) {
      const mod = await import(pathToFileURL(entry).href);
      return mod.default ?? mod;
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

const services = new Map(); // project dir -> { ts, service, versions }

/**
 * A language service for this project, made once and kept. Files are read
 * from disk and their version is their modified time, so an edit made by the
 * model is seen on the next question without rebuilding anything.
 */
async function serviceFor(projectDir) {
  const had = services.get(projectDir);
  if (had) return had;

  const ts = await loadTypeScript(projectDir);
  if (!ts) return null;

  const configPath = path.join(projectDir, 'tsconfig.json');
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, projectDir);

  const versions = new Map();
  const versionOf = (file) => {
    try { return String(statSync(file).mtimeMs); } catch { return '0'; }
  };

  const host = {
    getScriptFileNames: () => parsed.fileNames,
    getScriptVersion: (file) => {
      const now = versionOf(file);
      versions.set(file, now);
      return now;
    },
    getScriptSnapshot: (file) => {
      try { return ts.ScriptSnapshot.fromString(readFileSync(file, 'utf8')); } catch { return undefined; }
    },
    getCurrentDirectory: () => projectDir,
    getCompilationSettings: () => parsed.options,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };

  const made = { ts, service: ts.createLanguageService(host, ts.createDocumentRegistry()), versions };
  services.set(projectDir, made);
  return made;
}

/** Forget the open services, so the next question starts fresh. */
export function clearServices() { services.clear(); }

/** Character offset of `symbol` used as a name, preferring a given line. */
export function offsetOf(text, symbol, line) {
  const re = new RegExp(`(?<![\\w$])${symbol.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}(?![\\w$])`, 'g');
  const hits = [...text.matchAll(re)].map((m) => m.index);
  if (!hits.length) return -1;
  if (!line) return hits[0];
  const lineStart = text.split('\n').slice(0, line - 1).join('\n').length;
  // The occurrence nearest the line asked about.
  return hits.reduce((best, at) =>
    Math.abs(at - lineStart) < Math.abs(best - lineStart) ? at : best, hits[0]);
}

/**
 * What TypeScript says a name is: its exact type or signature, the docs
 * written on it, and where it is defined.
 */
export async function typeOf({ path: p, symbol, line }) {
  const wanted = String(symbol ?? '').trim();
  if (!wanted) return result('Pass the name of something in the file to ask about.', 'nothing to ask about');

  const target = resolveIn(p, 'type_of', 'path');
  await guard(target, `read ${target.abs}`);

  const text = await fs.readFile(target.abs, 'utf8').catch(() => null);
  if (text === null) return result(`Could not read ${target.show}.`, 'unreadable');

  const projectDir = projectRootFor(path.dirname(target.abs), path.parse(target.abs).root);
  if (!projectDir) {
    return result(
      `${target.show} is not inside a TypeScript project (no tsconfig.json above it), so there is ` +
      'no type information to give. Read the file, or the package it comes from.',
      'not a typescript project'
    );
  }

  const made = await serviceFor(projectDir);
  if (!made) {
    return result(
      `This project has no TypeScript installed, so nothing can answer what ${wanted} is. ` +
      'Once its packages are installed, ask again.',
      'typescript not installed'
    );
  }

  const { ts, service } = made;
  const at = offsetOf(text, wanted, line);
  if (at < 0) {
    return result(`"${wanted}" does not appear in ${target.show}.`, 'not in this file');
  }

  const info = service.getQuickInfoAtPosition(target.abs, at);
  if (!info) {
    return result(
      `TypeScript has nothing to say about ${wanted} in ${target.show} — usually that means the file ` +
      'has an error above this point, or the project has not been installed.',
      'no type information'
    );
  }

  const signature = ts.displayPartsToString(info.displayParts);
  const docs = ts.displayPartsToString(info.documentation ?? []);

  let where = '';
  const defs = service.getDefinitionAtPosition(target.abs, at) ?? [];
  if (defs.length) {
    const d = defs[0];
    const rel = path.relative(projectDir, d.fileName).replace(/\\/g, '/');
    const body = readFileSync(d.fileName, 'utf8').slice(0, d.textSpan.start);
    where = `\n\nDefined in ${rel}:${body.split('\n').length}`;
  }

  return result(
    `${signature}${docs ? `\n\n${docs}` : ''}${where}\n\n` +
    'This is from the project\'s own TypeScript, so it is what the build will say.',
    signature.split('\n')[0].slice(0, 80)
  );
}
