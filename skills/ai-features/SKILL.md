---
name: ai-features
description: Build features on top of language and vision models that behave like product, not demos — prompts with explicit rules, structured output validated in code, images, streaming, timeouts, retries, cost and failure handling.
auto: ai, llm, llms, gpt, chatgpt, claude, gemini, nemotron, chatbot, chat bot, embeddings, rag, vision model, image recognition, ocr, structured output, ai feature, ai-powered, ai powered, prompt engineering, analyze image, analyse image, reads the image, read the label
---

# AI features

A model call that works once in a demo is easy. A feature that gives a
consistent, correct, well-formatted answer every time, fails gracefully, and
does not leak a key is the actual job. Treat the model as an unreliable
upstream service with a very good API.

## 1. Architecture

- **Server only.** The call and the key live in a server route or server action.
  The browser sends the input to your route; your route calls the model.
- **One module per model integration** (`lib/server/analyze.ts`): builds the
  prompt, calls the API, parses and validates the reply, returns a typed result
  or a typed error. Routes and UI never touch raw model output.
- **Types first.** Define the result with zod before writing the prompt. The
  schema is the contract the prompt has to satisfy.

```ts
const Finding = z.object({
  nutrient: z.string(),
  amount: z.string(),               // "820 mg", as printed
  severity: z.enum(['high', 'low']),
  why: z.string().max(160),
});
export const Analysis = z.object({
  isNutritionLabel: z.boolean(),
  score: z.number().min(1).max(10),
  summary: z.string().max(400),
  findings: z.array(Finding).max(8),
});
```

## 2. Prompts that produce the same answer twice

- **Role and task in the first line**, then the rules, then the output format.
- **Make every judgement explicit.** "Flag sodium if it is over 20% of daily
  value per serving (≈460 mg)" is reproducible; "flag unhealthy things" is not.
  Write the thresholds, the scale anchors ("10 = whole food with no concerns,
  5 = fine occasionally, 1 = mostly sugar or salt"), and what to leave out
  ("if no nutrient crosses a threshold, return an empty findings array — never
  pad it").
- **Handle the wrong input inside the prompt too**: "If the image is not a
  nutrition facts label, set isNutritionLabel to false and leave the rest empty."
- **Specify the JSON exactly** — field names, types, units, lengths — and say
  "Reply with the JSON object only. No prose, no code fences."
- **Put the unchanging instructions in the system message** and the per-request
  input in the user message.
- Temperature 0–0.3 for extraction and scoring; higher only for creative text.

## 3. Calling the API

OpenAI-compatible chat completions (most providers, including model routers):

```ts
const res = await fetch(`${BASE_URL}/chat/completions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: MODEL_ID,
    temperature: 0.2,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: [
        { type: 'text', text: 'Analyse this label.' },
        { type: 'image_url', image_url: { url: dataUrl } },
      ] },
    ],
  }),
  signal: AbortSignal.timeout(90_000),
});
if (!res.ok) throw new ModelError(res.status, await res.text());
const text = (await res.json()).choices?.[0]?.message?.content ?? '';
```

- **Timeout on every call.** Reasoning models can think for 30–60s; set the route's
  own limit (`export const maxDuration = 90` in Next.js) above the call's.
- **Retry only what is safe to retry**: 429 (after `retry-after`), 5xx, network
  errors, timeouts — at most 2 retries with backoff. Never retry a 400 or 401.
- **Map errors to user language** at the boundary: rate limited → "busy, try
  again in a moment"; timeout → "took too long"; invalid output → "could not
  read the result"; not a label → "that does not look like a nutrition label".

## 4. Parsing model output defensively

Models add prose, wrap JSON in fences, use trailing commas, or return numbers
as strings. Never `JSON.parse` the raw text directly.

```ts
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const raw = fenced ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(raw);
}
const parsed = Analysis.safeParse(extractJson(text));
if (!parsed.success) throw new ModelError(422, 'unreadable model output');
```

Then **enforce the rules in code as well**: clamp the score, drop findings that
do not meet the threshold, cap list lengths. The prompt asks; the code
guarantees.

## 5. Images

- Accept jpeg, png, webp. Check type and size on the client before upload.
- Downscale in a canvas to ~1600px on the long edge and re-encode as JPEG at
  0.85 — faster upload, fewer tokens, same accuracy for text in the image.
- Send as a `data:image/jpeg;base64,...` URL. Handle HEIC from phones by
  telling the user to export as JPEG if the browser cannot decode it.
- Check that the model you are calling accepts images at all before building
  on it.

## 6. The experience around the call

- A real loading state with words ("Reading the label…"), elapsed time if it can
  exceed ~5s, and a way to cancel (`AbortController`).
- Stream text responses when the output is prose, so something appears at once.
  For structured results, show a skeleton of the result shape instead.
- Show the result with its reasoning visible (the summary, the findings), not
  just a number.
- Keep the user's input on failure so "try again" is one click.

## 7. Cost, privacy and abuse

- Log the model, latency, token usage and outcome — never the key, and never
  the user's content unless they agreed to it.
- Limit input size and request rate per user on public endpoints.
- Cache results for identical inputs where it is safe (hash of the image).

## 8. Verify with real inputs

Test with at least: a clear typical input, a hard one (blurry photo, cropped
label), a wrong one (a photo of a cat), and an edge (a food that genuinely has
no concerns — the findings list must come back empty). Report what each
returned.
