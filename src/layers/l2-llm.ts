/**
 * Layer 2 — local LLM reviewer.
 *
 * Only sees commands layer 1 could not settle. Runs against an
 * OpenAI-compatible endpoint on localhost, so it is free and nothing leaves the
 * machine. Default target is a small model (Qwen3.5-2B) on its own port: this
 * judgement is narrow and does not need a large model, and a small one will not
 * compete with a big coding model for GPU memory.
 */

import type { Candidate, Verdict } from "../types.js";

const SYSTEM = `You review shell commands for a coding agent and judge whether running one could cause damage the user would not be able to undo.

Damage means: data loss, an unbootable or broken system, leaked credentials, or an irreversible remote change.
Routine development work is safe, including building, testing, installing project dependencies, reading files, and git operations that do not discard committed work.

Reply with JSON only: {"verdict":"safe"|"dangerous","why":"<one short sentence>"}`;

export interface LlmResult {
	verdict: "safe" | "dangerous";
	why: string;
}

export async function reviewCommand(
	endpoint: string,
	model: string,
	c: Candidate,
	timeoutMs: number,
): Promise<LlmResult | null> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(endpoint, {
			method: "POST",
			headers: { "content-type": "application/json" },
			signal: ctrl.signal,
			body: JSON.stringify({
				model,
				temperature: 0,
				max_tokens: 120,
				messages: [
					{ role: "system", content: SYSTEM },
					{
						role: "user",
						content: `Working directory: ${c.cwd}\nTool: ${c.toolName}\nCommand:\n${c.command}`,
					},
				],
			}),
		});
		if (!res.ok) return null;
		const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
		const text = body.choices?.[0]?.message?.content ?? "";
		const match = text.match(/\{[\s\S]*\}/);
		if (!match) return null;
		const parsed = JSON.parse(match[0]) as LlmResult;
		if (parsed.verdict !== "safe" && parsed.verdict !== "dangerous") return null;
		return { verdict: parsed.verdict, why: String(parsed.why ?? "").slice(0, 300) };
	} catch {
		return null; // Unreachable, slow, or unparseable => the layer abstains.
	} finally {
		clearTimeout(timer);
	}
}

export function toVerdict(r: LlmResult | null, model: string): Verdict {
	if (!r) {
		return {
			tier: "review",
			reason: "Local reviewer unavailable — deferring to you.",
			layer: "l2",
			source: "unavailable",
		};
	}
	return {
		tier: r.verdict === "dangerous" ? "danger" : "allow",
		reason: r.why,
		layer: "l2",
		source: model,
	};
}
