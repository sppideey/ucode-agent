/**
 * openable.js — a page that works when you double-click it.
 *
 * ucode hands a plain app over as a file:// link, and the plain starter loads
 * its code with <script type="module">. Browsers refuse module scripts from
 * file:// (CORS, origin 'null'), so the page drew its markup and ran none of
 * its JavaScript: every button dead, nothing in the console the user would
 * ever open. The check never saw it, because it serves the folder over http.
 *
 * So before the check, each local module script is rewritten into one
 * ordinary deferred script: the files it imports are inlined into it, and the
 * whole program is wrapped in a function, which keeps a module's private
 * scope and strict mode. Anything this cannot do faithfully — an import from
 * a URL or a package, a cycle, `export ... from`, import.meta — is left as it
 * was.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import { writeTracked } from '../tools/shared.js';

const SCRIPT = /<script\b([^>]*)>\s*<\/script>/gi;
const attr = (attrs, name) => new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs);
const valueOf = (m) => m && (m[1] ?? m[2] ?? m[3]);
const LOCAL_SRC = (src) => src && !/^(?:[a-z]+:|\/\/)/i.test(src);

class Skip extends Error {}

/** Rewrite every local module script in dir/<file>. Returns the scripts changed. */
export async function makeOpenable(dir, file = 'index.html') {
  const html = path.join(dir, file);
  const page = await fs.readFile(html, 'utf8').catch(() => null);
  if (page === null) return [];

  const changed = [];
  const tags = [];
  for (const m of page.matchAll(SCRIPT)) {
    const src = valueOf(attr(m[1], 'src'));
    if (valueOf(attr(m[1], 'type'))?.toLowerCase() === 'module' && LOCAL_SRC(src)) tags.push({ tag: m[0], attrs: m[1], src });
  }
  let next = page;
  const done = new Set(); // the same script twice on a page is rewritten once
  for (const { tag, attrs, src } of tags) {
    const entry = path.resolve(dir, src.split(/[?#]/)[0]);
    if (!done.has(entry)) {
      let code;
      try {
        code = await bundle(entry);
      } catch (err) {
        if (err instanceof Skip || err?.code === 'ENOENT' || err instanceof SyntaxError) continue;
        throw err;
      }
      await writeTracked(entry, code);
      done.add(entry);
    }
    let classic = attrs.replace(/\s*\btype\s*=\s*(?:"module"|'module'|module)/i, '');
    if (!/\bdefer\b/i.test(classic)) classic += ' defer';
    next = next.replace(tag, () => `<script${classic}></script>`);
    changed.push(src);
  }
  if (next !== page) await writeTracked(html, next);
  return changed;
}

/** The entry and everything it imports, as one classic script. */
async function bundle(entry) {
  const order = [];
  const seen = new Map(); // file -> 'visiting' | module
  const visit = async (file) => {
    if (seen.get(file) === 'visiting') throw new Skip('import cycle');
    if (seen.has(file)) return seen.get(file);
    seen.set(file, 'visiting');
    const mod = await transform(file, file !== entry, visit);
    seen.set(file, mod);
    order.push(mod);
    return mod;
  };
  const main = await visit(entry);
  const deps = order.filter((m) => m !== main);

  const body = [
    ...deps.map((m) => `// ${path.relative(path.dirname(entry), m.file).split(path.sep).join('/')}\nconst ${m.name} = (() => {\n${m.code}\n})();\n`),
    main.code,
  ].join('\n');
  return '// Rewritten by ucode as one ordinary script, so the page runs when opened\n' +
    '// straight from disk (browsers block module scripts on file://).\n' +
    `(${main.tla ? 'async ' : ''}() => {\n'use strict';\n${body}\n})();\n`;
}

let ids = 0;

/** One module: imports become reads of earlier modules, exports are stripped (and returned, for a dependency). */
async function transform(file, isDep, visit) {
  const src = await fs.readFile(file, 'utf8');
  const ast = parse(src, { sourceType: 'module', allowAwaitOutsideFunction: true });
  const edits = [];
  const exported = []; // [exportedName, localName]
  const names = (id) => {
    if (id.type !== 'Identifier') throw new Skip('destructured export');
    return id.name;
  };

  for (const node of ast.program.body) {
    if (node.type === 'ImportDeclaration') {
      const spec = node.source.value;
      if (!/^\.{1,2}\//.test(spec)) throw new Skip(`import from ${spec}`);
      const dep = await visit(path.resolve(path.dirname(file), spec.split(/[?#]/)[0]));
      const parts = [];
      const named = [];
      for (const s of node.specifiers) {
        if (s.type === 'ImportDefaultSpecifier') parts.push(`const ${s.local.name} = ${dep.name}.default;`);
        else if (s.type === 'ImportNamespaceSpecifier') parts.push(`const ${s.local.name} = ${dep.name};`);
        else {
          const imported = s.imported.name ?? s.imported.value;
          named.push(imported === s.local.name ? imported : `${JSON.stringify(imported)}: ${s.local.name}`);
        }
      }
      if (named.length) parts.unshift(`const { ${named.join(', ')} } = ${dep.name};`);
      edits.push([node.start, node.end, parts.join(' ')]);
    } else if (node.type === 'ExportNamedDeclaration') {
      if (node.source) throw new Skip('export from');
      if (node.declaration) {
        const d = node.declaration;
        if (d.type === 'VariableDeclaration') for (const v of d.declarations) exported.push([names(v.id), names(v.id)]);
        else exported.push([d.id.name, d.id.name]);
        edits.push([node.start, d.start, '']);
      } else {
        for (const s of node.specifiers) exported.push([s.exported.name ?? s.exported.value, s.local.name]);
        edits.push([node.start, node.end, '']);
      }
    } else if (node.type === 'ExportDefaultDeclaration') {
      const d = node.declaration;
      if ((d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id) {
        exported.push(['default', d.id.name]);
        edits.push([node.start, d.start, '']);
      } else {
        exported.push(['default', '__default']);
        edits.push([node.start, d.start, 'const __default = ']);
      }
    } else if (node.type === 'ExportAllDeclaration') {
      throw new Skip('export *');
    }
  }
  const moduleOnly = (n) => n.type === 'Import' || n.type === 'ImportExpression' || (n.type === 'MetaProperty' && n.meta.name === 'import');
  if (some(ast.program, moduleOnly, false)) throw new Skip('import.meta or import()');

  let code = src;
  for (const [start, end, text] of edits.sort((a, b) => b[0] - a[0])) code = code.slice(0, start) + text + code.slice(end);
  if (isDep) {
    code += `\nreturn { ${exported.map(([name, local]) => `${JSON.stringify(name)}: ${local}`).join(', ')} };`;
  }
  const tla = some(ast.program, (n) => n.type === 'AwaitExpression' || (n.type === 'ForOfStatement' && n.await), true);
  if (isDep && tla) throw new Skip('top-level await in a dependency');
  return { file, code, tla, name: `__ucode_${path.basename(file).replace(/\W/g, '_')}_${++ids}` };
}

/** Whether any node matches; with outsideFunctions, only nodes not inside a function. */
function some(root, match, outsideFunctions) {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node.type !== 'string') continue;
    if (match(node)) return true;
    if (outsideFunctions && /Function|ClassMethod|ObjectMethod/.test(node.type)) continue;
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end') continue;
      const v = node[key];
      if (Array.isArray(v)) stack.push(...v);
      else if (v && typeof v === 'object') stack.push(v);
    }
  }
  return false;
}
