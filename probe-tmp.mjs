import 'dotenv/config'; import { readFileSync } from 'node:fs';
const body = JSON.parse(readFileSync(process.env.BODY, 'utf8').split('\n')[0]);
const mode = process.argv[2];
if (mode === 'stream') Object.assign(body, { stream: true });
if (mode === 'notools') { delete body.tools; delete body.tool_choice; body.stream = true; }
if (mode === 'low') { body.reasoning = { effort: 'low' }; body.stream = true; }
if (mode === 'off') { body.reasoning = { enabled: false }; body.stream = true; }
if (mode === 'noreason') { delete body.include_reasoning; body.stream = true; }
const t0 = Date.now(); setInterval(() => console.log(mode, Math.round((Date.now()-t0)/1000)+"s", "r", r, "c", c, "t", t, "bytes", bytes), 15000).unref();
let bytes = 0, r = 0, c = 0, t = 0, args = '', txt = '';
setTimeout(() => { console.log('TEXT', txt); console.log('ARGS', args); process.exit(0); }, 20000);
const res = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${process.env.UCODE_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const dec = new TextDecoder(); let first = 0, buf = '';
for await (const ch of res.body) { bytes += ch.length; buf += dec.decode(ch, { stream: true }); const ls = buf.split('\n'); buf = ls.pop();
  for (const l of ls) { if (!l.startsWith('data: {')) { if (mode === 'plain' && l.trim()) { const j = JSON.parse(l); console.log('plain', JSON.stringify(j.choices?.[0]?.message).slice(0, 200)); } continue; }
    const J = JSON.parse(l.slice(6)); if (J.choices?.[0]?.finish_reason) console.log('finish', J.choices[0].finish_reason, Date.now()-t0); if (J.usage) console.log('usage', Date.now()-t0);
    const d = J.choices?.[0]?.delta ?? {}; if (!first && (d.content || d.reasoning || d.tool_calls)) first = Date.now() - t0;
    if (d.tool_calls) for (const x of d.tool_calls) args += (x.function?.name ? '[' + x.function.name + ']' : '') + (x.function?.arguments ?? ''); if (d.content) txt += d.content; if (d.reasoning) r++; if (d.content) c++; if (d.tool_calls) t++; } }
if (mode === 'plain' && buf.trim()) console.log('plain', buf.slice(0, 300));
console.log(mode, 'status', res.status, 'first', first, 'total', Date.now() - t0, 'ms  reasoning/content/tool chunks', r, c, t);
