// SPDX-License-Identifier: AGPL-3.0-only - ucode, made and tested by om dixit. Additional terms: see NOTICE.
/**
 * mcpcli.js — `ucode mcp add | list | remove`, the way to connect a server
 * without editing JSON by hand. Servers go in ~/.ucode/mcp.json (every
 * project) unless --project puts them in this folder's .ucode/mcp.json.
 *
 *   ucode mcp add context7 npx -y @upstash/context7-mcp
 *   ucode mcp add github --url https://api.githubcopilot.com/mcp/ --header "Authorization=Bearer ${GITHUB_TOKEN}"
 */

import { USER_MCP, projectMcpFile, readServers, addServer, removeServer, McpHub } from './mcp.js';

export async function mcpCommand(argv, { cwd = process.cwd() } = {}) {
  const project = argv.includes('--project');
  const args = argv.filter((a) => a !== '--project');
  const file = project ? projectMcpFile(cwd) : USER_MCP;
  const [action, name, ...rest] = args;

  if (action === 'add') {
    if (!name || !rest.length) return 'usage: ucode mcp add <name> <command> [args...]   or   ucode mcp add <name> --url <url>';
    let spec;
    if (rest[0] === '--url') {
      const headers = {};
      for (let i = 2; i < rest.length; i++) {
        if (rest[i] === '--header' && rest[i + 1]?.includes('=')) {
          const [k, ...v] = rest[++i].split('=');
          headers[k] = v.join('=');
        }
      }
      spec = { url: rest[1], ...(Object.keys(headers).length ? { headers } : {}) };
    } else {
      spec = { command: rest[0], args: rest.slice(1) };
    }
    await addServer(file, name, spec);
    // Try it now, so a typo shows up here rather than mid-build.
    const hub = new McpHub();
    const [status] = await hub.start([{ name, ...spec }], { cwd });
    hub.close();
    return status.ok
      ? `added ${name} to ${file} — ${status.tools} tools, ready next time you start ucode`
      : `added ${name} to ${file}, but it did not start: ${status.error}`;
  }

  if (action === 'remove' || action === 'rm') {
    if (!name) return 'usage: ucode mcp remove <name>';
    return (await removeServer(file, name)) ? `removed ${name}` : `no server called ${name} in ${file}`;
  }

  const [mine, here] = await Promise.all([readServers(USER_MCP), readServers(projectMcpFile(cwd))]);
  const line = (s, where) => `  ${s.name.padEnd(16)} ${where.padEnd(8)} ${s.url ?? [s.command, ...(s.args ?? [])].join(' ')}`;
  const rows = [...mine.map((s) => line(s, 'yours')), ...here.map((s) => line(s, 'project'))];
  return rows.length ? rows.join('\n') : 'no MCP servers yet — ucode mcp add <name> <command> [args...]';
}
