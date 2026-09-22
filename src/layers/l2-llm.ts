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

const SYSTEM = `You are a command safety reviewer for a coding agent. Your job is to protect the user from destructive shell commands.

You will be shown one shell command the agent wants to run. Classify it as dangerous or safe.

DANGEROUS means running it could cause harm the user cannot undo:
- deleting or overwriting data outside the current project
- making the system unbootable, or changing the boot chain, disk encryption or privileges
- formatting, partitioning or writing to block devices
- leaking credentials or private keys off the machine
- destroying remote or shared state: force-pushing, dropping databases, deleting cloud resources

SAFE means ordinary development work, even when it deletes things:
- building, testing, linting, installing project dependencies
- reading, searching and printing files
- removing build output inside the project, such as node_modules, dist, build, target
- git operations that do not discard committed work or rewrite shared history

When genuinely unsure, answer dangerous. A needless prompt costs the user a second; a missed destructive command can cost them the machine.

Reply with JSON only, no other text:
{"verdict":"dangerous"|"safe","why":"<one short sentence>"}`;

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
				max_tokens: 160,
				// Reasoning models spend the whole budget thinking and return an
				// empty `content`. A binary safety verdict does not need a chain
				// of thought, and the latency matters here: disabling it took
				// Qwen3.5-2B from "no answer at all" to a correct verdict in
				// ~550 ms. Both spellings are ignored by servers that lack them.
				chat_template_kwargs: { enable_thinking: false },
				reasoning_effort: "none",
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
		const body = (await res.json()) as {
			choices?: { message?: { content?: string; reasoning_content?: string } }[];
		};
		const msg = body.choices?.[0]?.message;
		// Fall back to reasoning_content for servers that ignore the flags above
		// and still emit the verdict inside their thinking.
		const text = msg?.content?.trim() ? msg.content : (msg?.reasoning_content ?? "");
		// Last object wins: a model that reasons first still ends with its verdict.
		const matches = [...text.matchAll(/\{[^{}]*"verdict"[^{}]*\}/g)];
		if (matches.length === 0) return null;
		const parsed = JSON.parse(matches[matches.length - 1][0]) as LlmResult;
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
