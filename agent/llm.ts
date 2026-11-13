/**
 * llm.ts — optional LLM reasoning layer.
 *
 * Deliberately one-directional: the model may VETO a payment the policy
 * engine approved, but it can never approve one the engine refused. Safety
 * degrades toward the deterministic path, never toward the model's mood.
 *
 * Any OpenAI-compatible endpoint works (OpenAI, OpenRouter, local Ollama
 * at http://localhost:11434/v1, ...). Configure via env:
 *   LLM_BASE_URL   e.g. https://api.openai.com/v1
 *   LLM_API_KEY    bearer token
 *   LLM_MODEL      e.g. gpt-4o-mini, llama3.1
 */
import type { Invoice, PolicyState, Verdict } from "./policy.js";
import { formatEther } from "viem";

export interface LlmNote {
  model: string;
  vetoed: boolean;
  confidence: number | null;
  reason: string;
}

const BASE = process.env.LLM_BASE_URL?.trim();
const KEY = process.env.LLM_API_KEY?.trim();
const MODEL = process.env.LLM_MODEL?.trim();

export function llmEnabled() {
  return !!(BASE && KEY && MODEL);
}

function prompt(inv: Invoice, s: PolicyState, verdict: Verdict): string {
  return `You are the risk reviewer for Sentinel, an autonomous treasury agent on QoreChain.
An invoice awaits settlement. The deterministic policy verdict is "${verdict.action}" (${verdict.reason}).

Invoice:
- id: ${inv.id}
- vendor: ${inv.vendor}
- amount: ${formatEther(inv.amount)} QOR
- ref: ${inv.ref}
- submitted: ${new Date(Number(inv.createdAt) * 1000).toISOString()}

Policy: per-tx cap ${formatEther(s.perTxCap)} QOR, daily cap ${formatEther(s.dailyCap)} QOR,
mandate threshold ${formatEther(s.mandateThreshold)} QOR, spent today ${formatEther(s.spentToday)} QOR.

Reply with EXACTLY one JSON object, no prose:
{"veto": true|false, "confidence": 0-1, "reason": "one sentence"}
Veto only for a concrete anomaly (e.g. duplicate-looking ref, absurd amount vs ref). Do not veto routine payments.`;
}

export async function llmReview(inv: Invoice, s: PolicyState, verdict: Verdict): Promise<LlmNote | null> {
  if (!llmEnabled()) return null;
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        messages: [
          { role: "system", content: "You output strict JSON only." },
          { role: "user", content: prompt(inv, s, verdict) },
        ],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { model: MODEL!, vetoed: false, confidence: null, reason: `llm http ${res.status}` };
    const body = (await res.json()) as any;
    const text: string = body.choices?.[0]?.message?.content ?? "";
    const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    return {
      model: MODEL!,
      vetoed: verdict.action !== "refuse" && parsed.veto === true, // veto can only restrict
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : null,
      reason: String(parsed.reason ?? "").slice(0, 300),
    };
  } catch (e) {
    return { model: MODEL!, vetoed: false, confidence: null, reason: `llm error: ${e instanceof Error ? e.message.slice(0, 120) : e}` };
  }
}
