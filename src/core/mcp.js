// SPDX-License-Identifier: AGPL-3.0-only - ucode, made and tested by om dixit. Additional terms: see NOTICE.
/**
 * mcp.js — tools from MCP servers: GitHub, docs, databases, whatever the user connects.
 *
 *   ~/.ucode/mcp.json          servers for every project
 *   <project>/.ucode/mcp.json  servers for this one (asked about once, see settings.js)
 *
 *   { "servers": {
 *       "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] },
 *       "github":   { "url": "https://api.githubcopilot.com/mcp/",
 *                     "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" } } } }
 *
 * "mcpServers" is read too, so a block copied from another tool's docs works.
 * ${NAME} in args, env and headers is taken from the environment, so a token
 * never has to sit in the file.
 *
 * The protocol is JSON-RPC over a child's stdin and stdout, or over HTTP. The
 * official SDK pulls in a web server framework to speak it, which every
 * install of ucode would then download; the client half is this file.
 */

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { readJson, writeJson } from './settings.js';
import { VERSION } from './version.js';

export const USER_MCP = path.join(os.homedir(), '.ucode', 'mcp.json');
export const projectMcpFile = (cwd) => path.join(cwd, '.ucode', 'mcp.json');

const PROTOCOL = '2025-06-18';
const START_MS = 30_000;
const CALL_MS = 120_000;
const MAX_RESULT = 12_000;

const expand = (value) => String(value ?? '').replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? '');
const expandAll = (obj = {}) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, expand(v)]));

/** The servers a file lists, each { name, command?, args?, env?, url?, headers? }. */
export async function readServers(file) {
  const data = await readJson(file);
  const servers = data.servers ?? data.mcpServers ?? {};
  return Object.entries(servers)
    .filter(([, s]) => s && typeof s === 'object' && (s.command || s.url) && s.disabled !== true)
    .map(([name, s]) => ({ name, ...s }));
}

/** Add or replace one server in a config file. */
export async function addServer(file, name, spec) {
  const data = await readJson(file);
  const key = data.mcpServers && !data.servers ? 'mcpServers' : 'servers';
  await writeJson(file, { ...data, [key]: { ...(data[key] ?? {}), [name]: spec } });
}

/** Take a server out of a config file. Resolves to whether it was there. */
export async function removeServer(file, name) {
  const data = await readJson(file);
  const key = data.servers?.[name] ? 'servers' : data.mcpServers?.[name] ? 'mcpServers' : null;
  if (!key) return false;
  const { [name]: _gone, ...rest } = data[key];
  await writeJson(file, { ...data, [key]: rest });
  return true;
}

/** A name a function call can carry: letters, digits, _ and -, at most 64. */
export const toolName = (server, tool) =>
  `${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^[^A-Za-z_]/, '_$&').slice(0, 64);

const KEEP = new Set(['type', 'description', 'properties', 'required', 'items', 'enum', 'anyOf', 'nullable',
  'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'title']);

/**
 * An MCP input schema in the subset Gemini accepts. Anything else in a schema
 * ($schema, additionalProperties, $ref, formats other than date-time) gets the
 * whole request refused, and one server's odd schema would take every other
 * tool down with it.
 */
export function cleanSchema(schema, root = true) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return root ? { type: 'object', properties: {} } : { type: 'string' };
  }
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!KEEP.has(key)) continue;
    if (key === 'type' && Array.isArray(value)) {
      const real = value.filter((t) => t !== 'null');
      out.type = real[0] ?? 'string';
      if (real.length < value.length) out.nullable = true;
    } else if (key === 'properties' && value && typeof value === 'object') {
      out.properties = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cleanSchema(v, false)]));
    } else if (key === 'items') {
      out.items = cleanSchema(Array.isArray(value) ? value[0] : value, false);
    } else if (key === 'anyOf' && Array.isArray(value)) {
      out.anyOf = value.map((v) => cleanSchema(v, false));
    } else if (key === 'enum' && Array.isArray(value)) {
      out.enum = value.filter((v) => typeof v === 'string');
    } else {
      out[key] = value;
    }
  }
  if (schema.oneOf && !out.anyOf) out.anyOf = schema.oneOf.map((v) => cleanSchema(v, false));
  if (schema.format === 'date-time') out.format = 'date-time';
  if (out.enum && !out.enum.length) delete out.enum;
  if (root || out.type === 'object' || out.properties) {
    out.type = 'object';
    out.properties ??= {};
    if (Array.isArray(out.required)) out.required = out.required.filter((k) => k in out.properties);
  } else if (!out.type && !out.anyOf) {
    out.type = 'string';
  }
  return out;
}

/** One server's reply to a tools/call, as text for the model. */
export function resultText(result) {
  const parts = (result?.content ?? []).map((c) => {
    if (c.type === 'text') return c.text;
    if (c.type === 'resource') return c.resource?.text ?? `[resource ${c.resource?.uri ?? ''}]`;
    if (c.type === 'resource_link') return `[${c.name ?? 'link'}: ${c.uri}]`;
    return `[${c.type} not shown]`;
  });
  if (!parts.length && result?.structuredContent) parts.push(JSON.stringify(result.structuredContent, null, 2));
  const text = parts.join('\n').trim() || '(the tool returned nothing)';
  return text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)}\n[cut at ${MAX_RESULT} characters]` : text;
}

/**
 * Quote one argument for cmd.exe. Inside double quotes cmd treats & | < > ^
 * as text; a quote is doubled, and % is broken up so no variable expands.
 */
const winQuote = (a) => (/^[\w./:=@\\-]+$/.test(a)
  ? a
  : `"${String(a).replace(/"/g, '""').replace(/%/g, '"%"')}"`);

/** A server spoken to over its stdin and stdout, one JSON message per line. */
class StdioLink {
  constructor(spec, cwd) {
    this.pending = new Map();
    this.next = 1;
    const args = (spec.args ?? []).map(expand);
    const env = { ...process.env, ...expandAll(spec.env) };
    // npx and friends are .cmd files on Windows, which only a shell can start.
    this.child = process.platform === 'win32'
      ? spawn([spec.command, ...args].map(winQuote).join(' '), { cwd, env, shell: true, windowsHide: true })
      : spawn(spec.command, args, { cwd, env, windowsHide: true });
    this.errors = '';
    let rest = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop();
      for (const line of lines) if (line.trim()) this.receive(line);
    });
    this.child.stderr.on('data', (d) => { this.errors = (this.errors + d).slice(-2000); });
    const fail = (why) => {
      for (const { reject } of this.pending.values()) reject(new Error(why));
      this.pending.clear();
      this.closed = why;
    };
    this.child.on('error', (err) => fail(err.message));
    this.child.on('close', (code) => fail(`the server stopped (exit ${code})${this.errors ? `: ${this.errors.trim().split('\n').pop()}` : ''}`));
  }

  receive(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    // A request from the server: answer ping, decline the rest.
    if (msg.method && msg.id !== undefined) {
      this.send(msg.method === 'ping'
        ? { jsonrpc: '2.0', id: msg.id, result: {} }
        : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'ucode does not support that' } });
      return;
    }
    const waiting = this.pending.get(msg.id);
    if (!waiting) return;
    this.pending.delete(msg.id);
    if (msg.error) waiting.reject(new Error(msg.error.message ?? 'the server returned an error'));
    else waiting.resolve(msg.result);
  }

  send(msg) {
    if (!this.closed) this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  request(method, params, ms) {
    if (this.closed) return Promise.reject(new Error(this.closed));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`no answer after ${ms / 1000}s`)); }, ms);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
  }

  close() {
    try { this.child.stdin.end(); this.child.kill(); } catch { /* already gone */ }
  }
}

/** A server spoken to over HTTP: each message a POST, the answer JSON or an event stream. */
class HttpLink {
  constructor(spec) {
    this.url = expand(spec.url);
    this.headers = expandAll(spec.headers);
    this.next = 1;
  }

  async post(body, ms) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL,
        ...(this.session ? { 'mcp-session-id': this.session } : {}),
        ...this.headers,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ms),
    });
    this.session = res.headers.get('mcp-session-id') ?? this.session;
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res;
  }

  async request(method, params, ms) {
    const id = this.next++;
    const res = await this.post({ jsonrpc: '2.0', id, method, params }, ms);
    const type = res.headers.get('content-type') ?? '';
    let msg;
    if (type.includes('text/event-stream')) {
      const text = await res.text();
      for (const event of text.split(/\r?\n\r?\n/)) {
        const data = event.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
        if (!data) continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.id === id) { msg = parsed; break; }
        } catch { /* not a message */ }
      }
    } else {
      msg = await res.json();
    }
    if (!msg) throw new Error('the server sent no answer');
    if (msg.error) throw new Error(msg.error.message ?? 'the server returned an error');
    return msg.result;
  }

  notify(method, params) {
    this.post({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }, 10_000).catch(() => {});
  }

  close() {}
}

/** Every connected server, and the tools they offer. */
export class McpHub {
  constructor() {
    this.servers = new Map(); // name -> { ok, error, tools: [{ name, remote, description, schema }], link }
    this.byTool = new Map();  // exposed tool name -> { server, remote }
  }

  /** Connect to each server at once. A server that fails is noted, never fatal. */
  async start(specs, { cwd = process.cwd() } = {}) {
    await Promise.all(specs.map((spec) => this.connect(spec, cwd)));
    return this.status();
  }

  async connect(spec, cwd) {
    let link;
    try {
      link = spec.url ? new HttpLink(spec) : new StdioLink(spec, cwd);
      await link.request('initialize', {
        protocolVersion: PROTOCOL,
        capabilities: {},
        clientInfo: { name: 'ucode', version: VERSION },
      }, START_MS);
      link.notify('notifications/initialized');
      const tools = [];
      let cursor;
      do {
        const page = await link.request('tools/list', cursor ? { cursor } : {}, START_MS);
        tools.push(...(page?.tools ?? []));
        cursor = page?.nextCursor;
      } while (cursor);
      const exposed = tools.map((t) => ({
        name: toolName(spec.name, t.name),
        remote: t.name,
        description: String(t.description ?? `${t.name} from ${spec.name}`).slice(0, 1000),
        schema: cleanSchema(t.inputSchema),
      }));
      for (const t of exposed) this.byTool.set(t.name, { server: spec.name, remote: t.remote });
      this.servers.set(spec.name, { ok: true, tools: exposed, link, spec });
    } catch (err) {
      link?.close();
      this.servers.set(spec.name, { ok: false, error: err.message, tools: [], spec });
    }
  }

  /** Tool definitions in ucode's neutral format. */
  tools() {
    return [...this.servers.values()].flatMap((s) => s.tools.map((t) => ({
      name: t.name,
      description: `[${s.spec.name}] ${t.description}`,
      parameters: t.schema,
    })));
  }

  has(name) {
    return this.byTool.has(name);
  }

  serverOf(name) {
    return this.byTool.get(name)?.server;
  }

  async call(name, args) {
    const { server, remote } = this.byTool.get(name);
    const s = this.servers.get(server);
    const result = await s.link.request('tools/call', { name: remote, arguments: args ?? {} }, CALL_MS);
    return { text: resultText(result), isError: Boolean(result?.isError) };
  }

  status() {
    return [...this.servers.entries()].map(([name, s]) => ({ name, ok: s.ok, tools: s.tools.length, error: s.error }));
  }

  close() {
    for (const s of this.servers.values()) s.link?.close();
  }
}
