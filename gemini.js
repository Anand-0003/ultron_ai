// Google Gemini as a ULTRON brain. Any model named "gemini-..." (no Ollama ":tag") is sent here;
// every other model stays on Ollama. Messages come in Ollama's shape and are translated.
//
// Key, first one found: $GEMINI_API_KEY, ~/.ultron-gemini-key, $GOOGLE_API_KEY.
// Get one at https://aistudio.google.com/apikey.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const API = 'https://generativelanguage.googleapis.com/v1beta/models';
const KEY_FILE = path.join(os.homedir(), '.ultron-gemini-key');

// Offered in the model picker, first one is the default brain. flash-lite answers in about a
// second; 3.5-flash is smarter but often takes 10s+ before the first word. (Pro models have
// no free-tier quota, so they're left out; add them here if the key gets billing.)
export const GEMINI_MODELS = (process.env.ULTRON_GEMINI_MODELS || 'gemini-3.5-flash-lite,gemini-3.5-flash')
  .split(',').map(m => m.trim()).filter(Boolean);

export const isGemini = model => /^gemini-/.test(model || '') && !model.includes(':');

// Read on every call, so a new key works without restarting ULTRON.
export function geminiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  try {
    const k = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (k) return k;
  } catch {}
  return (process.env.GOOGLE_API_KEY || '').trim();
}

const SIGNATURES = { '/9j/': 'image/jpeg', iVBOR: 'image/png', UklGR: 'image/webp', R0lGO: 'image/gif' };
const imageMime = b64 => Object.entries(SIGNATURES).find(([sig]) => b64.startsWith(sig))?.[1] || 'image/jpeg';

// Ollama messages -> Gemini: system messages become the system instruction, "assistant" becomes
// "model", images become inline parts, and back-to-back messages from one side are merged.
function toGemini(messages) {
  const system = [], contents = [];
  for (const m of messages) {
    if (m.role === 'system') { if (m.content) system.push(m.content); continue; }
    const role = m.role === 'assistant' ? 'model' : 'user';
    const parts = [];
    if (m.content) parts.push({ text: m.content });
    for (const img of m.images || []) parts.push({ inlineData: { mimeType: imageMime(img), data: img } });
    if (!parts.length) continue;
    const last = contents.at(-1);
    if (last?.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  }
  return { system: system.join('\n\n'), contents };
}

function errorText(body) {
  let msg;
  try { msg = JSON.parse(body).error?.message; } catch {}
  return (msg || body).split('\n')[0].slice(0, 200);
}

// Keep thinking short: this is a voice assistant. Models that refuse "minimal" get "low".
const noMinimal = new Set();

export async function* geminiChat(model, messages, { signal, options = {}, stats } = {}) {
  const key = geminiKey();
  if (!key) throw new Error('No Gemini API key (set GEMINI_API_KEY or write it to ~/.ultron-gemini-key)');
  const { system, contents } = toGemini(messages);
  const generationConfig = { temperature: options.temperature ?? 0.6 };
  if (options.stop?.length) generationConfig.stopSequences = options.stop.slice(0, 5);
  if (options.num_predict > 0) generationConfig.maxOutputTokens = options.num_predict;

  const t0 = Date.now();
  let res;
  for (const level of noMinimal.has(model) ? ['low'] : ['minimal', 'low']) {
    generationConfig.thinkingConfig = { thinkingLevel: level };
    res = await fetch(`${API}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        ...(system && { systemInstruction: { parts: [{ text: system }] } }),
        contents,
        generationConfig,
      }),
    });
    if (res.ok || level !== 'minimal' || res.status !== 400) break;
    const body = await res.text();
    if (!/thinking level/i.test(body)) throw new Error(`Gemini 400: ${errorText(body)}`);
    noMinimal.add(model);
  }
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${errorText(await res.text())}`);

  const decoder = new TextDecoder();
  let buf = '', tFirst = 0, outTokens = 0, finish = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const j = JSON.parse(line.slice(5));
      if (j.error) throw new Error(`Gemini: ${j.error.message}`);
      if (j.promptFeedback?.blockReason) throw new Error(`Gemini blocked the request (${j.promptFeedback.blockReason})`);
      const cand = j.candidates?.[0];
      if (cand?.finishReason) finish = cand.finishReason;
      if (j.usageMetadata?.candidatesTokenCount) outTokens = j.usageMetadata.candidatesTokenCount;
      for (const p of cand?.content?.parts || []) {
        if (p.thought || !p.text) continue;
        if (!tFirst) { tFirst = Date.now(); if (stats) stats.firstTokenMs = tFirst - t0; }
        yield p.text;
      }
    }
  }
  // Nothing said and not a normal stop (safety block, recitation...): an error, so the caller can fall back.
  if (!tFirst && finish && finish !== 'STOP') throw new Error(`Gemini returned no text (${finish})`);
  if (stats && tFirst && outTokens) stats.tokensPerSec = outTokens / Math.max((Date.now() - tFirst) / 1000, 0.05);
}
