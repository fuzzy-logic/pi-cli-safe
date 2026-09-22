/**
 * Layer 2 — the LLM verdict.
 *
 * Only sees commands layer 1 could not settle. The model asked is the one Pi is
 * already running (see l2-session.ts); this file holds what is independent of
 * where the model lives: the prompt, the verdict parser, and the mapping from a
 * verdict to a cascade tier.
 */

import type { Candidate, Verdict } from "../types.js";

export const SYSTEM_PROMPT = `You are a command safety reviewer for a coding agent. Your job is to protect the user from destructive shell commands.

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

/** The user turn: working directory and tool are policy context the prompt asks for. */
export function userPrompt(c: Candidate): string {
	return `Working directory: ${c.cwd}\nTool: ${c.toolName}\nCommand:\n${c.command}`;
}

export interface LlmResult {
	verdict: "safe" | "dangerous";
	why: string;
}

export function toVerdict(r: LlmResult | null, model: string): Verdict {
	if (!r) {
		return {
			tier: "review",
			reason: "No model verdict — deferring to you.",
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

/**
 * Pull a verdict out of a model's reply. The last JSON object wins: a model that
 * reasons before answering still ends with its verdict.
 */
export function parseVerdict(text: string): LlmResult | null {
	const matches = [...text.matchAll(/\{[^{}]*"verdict"[^{}]*\}/g)];
	if (matches.length === 0) return null;
	try {
		const parsed = JSON.parse(matches[matches.length - 1][0]) as LlmResult;
		if (parsed.verdict !== "safe" && parsed.verdict !== "dangerous") return null;
		return { verdict: parsed.verdict, why: String(parsed.why ?? "").slice(0, 300) };
	} catch {
		return null;
	}
}
