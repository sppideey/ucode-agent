// What Google actually sends back, and what ucode makes of it.
import http from 'node:http';
import OpenAI from 'openai';
import { explain, thoughtFilter, backupFor, rpmFor, dailyReset, modelList, DEFAULT_MODEL } from '../../src/core/provider.js';

// Google's OpenAI-compatible endpoint wraps every error in a list: [{ "error": { ... } }].
const quota = (quotaId, value, retry, model) => ({
  error: {
    code: 429,
    message: `You exceeded your current quota, please check your plan and billing details.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: ${value}, model: ${model}\nPlease retry in ${retry}.`,
    status: 'RESOURCE_EXHAUSTED',
    details: [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId, quotaValue: String(value) }] },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: retry },
    ],
  },
});

async function googleSays(status, body, model = 'gemini-3.8-flash') {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify([body])); });
  }).listen(0);
  const client = new OpenAI({ apiKey: 'x', baseURL: `http://127.0.0.1:${server.address().port}`, maxRetries: 0 });
  try {
    await client.chat.completions.create({ model, messages: [{ role: 'user', content: 'hi' }] });
    throw new Error('expected an error');
  } catch (err) {
    return explain(err, model);
  } finally {
    server.close();
  }
}

export default async function ({ test, section, ok, eq }) {
  section('google errors');

  await test('a model\'s used-up daily allowance is said as that, with when it comes back, and never waited on', async () => {
    const f = await googleSays(429, quota('GenerateRequestsPerDayPerProjectPerModel-FreeTier', 20, '39s', 'gemini-3.8-flash'));
    eq(f.kind, 'rate_limit');
    ok(f.detail.daily && f.detail.perModel, 'daily, and per model');
    ok(/free requests for today \(20\) are used up/.test(f.failed), f.failed);
    ok(f.fix.includes(DEFAULT_MODEL === 'gemini-3.5-flash-lite' ? 'Flash-Lite has about 500 a day' : '500'), f.fix);
    ok(!/switching will not help/.test(f.fix + f.failed), 'switching does help on Google');
    ok(modelList().find((m) => m.id === 'gemini-3.8-flash').spentUntil > Date.now(), '/model shows it used up');
    ok(!modelList().find((m) => m.id === DEFAULT_MODEL).spentUntil, 'and only that one');
  });

  await test('a per-minute limit is waited exactly as long as Google says, and learned for the next requests', async () => {
    const f = await googleSays(429, quota('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', 5, '12s', 'gemini-3.7-flash'), 'gemini-3.7-flash');
    eq(f.detail.daily, false);
    eq(f.detail.retryAfter, 12);
    const was = process.env.UCODE_RPM;
    delete process.env.UCODE_RPM;   // the suite turns pacing off; this checks what pacing would use
    try {
      eq(rpmFor('gemini-3.7-flash'), 4, 'one under what Google allows');
    } finally {
      if (was !== undefined) process.env.UCODE_RPM = was;
    }
  });

  await test('a model with no free allowance on this key is said as that, not retried', async () => {
    const f = await googleSays(429, quota('GenerateRequestsPerDayPerProjectPerModel-FreeTier', 0, '20s', 'gemini-3.1-pro-preview'), 'gemini-3.1-pro-preview');
    eq(f.kind, 'not_free');
    ok(/billing/.test(f.fix));
  });

  await test('a bad key is a bad key, not a malformed request that folds the conversation', async () => {
    const f = await googleSays(400, { error: { code: 400, message: 'Please pass a valid API key', status: 'INVALID_ARGUMENT' } });
    eq(f.kind, 'invalid_api_key');
    ok(/ucode login/.test(f.fix) && /GEMINI_API_KEY/.test(f.fix));
  });

  await test('a retired model is final, in Google\'s own words', async () => {
    const f = await googleSays(404, { error: { code: 404, message: 'This model models/gemini-2.5-flash is no longer available to new users. Please update your code.', status: 'NOT_FOUND' } });
    eq(f.kind, 'bad_model');
    ok(/no longer available to new users\.$/.test(f.failed), f.failed);
  });

  await test('Google busy is a server problem, and the busy Flash models carry on, for now, on the default', async () => {
    const f = await googleSays(503, { error: { code: 503, message: 'This model is currently experiencing high demand.', status: 'UNAVAILABLE' } });
    eq(f.kind, 'server');
    eq(backupFor('gemini-3.8-flash'), DEFAULT_MODEL);
    eq(backupFor('gemma-4-31b-it'), DEFAULT_MODEL);
    eq(backupFor('gemini-3.5-flash-lite'), 'gemini-3.5-flash', 'the default still has its own backup');
    eq(backupFor('gemini-3.5-flash'), null, 'and that one never hands back: no ping-pong');
  });

  await test('the daily allowance comes back at midnight in California', () => {
    eq(dailyReset(new Date('2026-10-06T10:00:00Z')).toISOString().slice(0, 16), '2026-10-07T07:00', 'summer time');
    eq(dailyReset(new Date('2026-12-06T10:00:00Z')).toISOString().slice(0, 16), '2026-12-07T08:00', 'winter time');
    eq(dailyReset(new Date('2026-03-08T09:30:00Z')).toISOString().slice(0, 16), '2026-03-09T07:00', 'the night the clocks go forward');
    eq(dailyReset(new Date('2026-11-01T08:30:00Z')).toISOString().slice(0, 16), '2026-11-02T08:00', 'the night they go back');
  });

  section('thinking in the reply');

  await test('Gemma\'s <thought> text goes to reasoning, even when a tag arrives in pieces', () => {
    const split = thoughtFilter();
    const parts = ['<tho', 'ught>The user wants', ' a file.</th', 'ought>Reading ', 'it now.'].map(split);
    parts.push(split.flush());
    eq(parts.map((p) => p.text).join(''), 'Reading it now.');
    eq(parts.map((p) => p.thought).join(''), 'The user wants a file.');
    const plain = thoughtFilter();
    eq(plain('a < b, and <th'), { text: 'a < b, and ', thought: '' });
    eq(plain.flush(), { text: '<th', thought: '' }, 'held text that never became a tag is given back');
  });
}
