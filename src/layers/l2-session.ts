/**
 * Layer 2 — ask the model Pi is already running.
 *
 * When Laya cannot settle a command, the session model gets one short turn with
 * the safety prompt. No second server, no separate model download, no extra GPU
 * memory — and it is always available, because if Pi is running then a model is
 * connected.
 *
 * Two things this trades away, stated plainly:
 *
 *  1. Cost. On a paid cloud model every uncertain command spends tokens. The
 *     per-session call budget below bounds that.
 *  2. Control. When this was benchmarked, larger models were *more* permissive
 *     as safety reviewers than small ones. Layer 2 is only as careful as the
 *     model you are coding with. It can only clear commands Laya was unsure
 *     about; it can never override a layer-0 rule or your own answer.
 */

import { SYSTEM_PROMPT, parseVerdict, userPrompt } from "./l2-llm.js";
import type { LlmResult } from "./l2-llm.js";
import type { Candidate } from "../types.js";

/** Minimal shape of what we need from ExtensionContext, so this stays testable. */
export interface SessionModelHost {
	model?: { id: string; provider: string } | undefined;
	modelRegistry?: {
		complete: (
			model: unknown,
			context: { systemPrompt?: string; messages: { role: string; content: unknown }[] },
			options?: Record<string, unknown>,
		) => Promise<{ content?: unknown }>;
	};
}

export class SessionReviewer {
	private calls = 0;

	constructor(private readonly maxCalls: number) {}

	get used(): number {
		return this.calls;
	}

	name(host: SessionModelHost): string {
		return host.model ? `${host.model.provider}/${host.model.id}` : "session model";
	}

	async review(host: SessionModelHost, c: Candidate, timeoutMs: number): Promise<LlmResult | null> {
		if (!host.model || !host.modelRegistry) return null;
		if (this.calls >= this.maxCalls) return null; // budget spent; cascade asks the user

		this.calls++;
		try {
			const result = await withTimeout(
				host.modelRegistry.complete(
					host.model,
					{
						systemPrompt: SYSTEM_PROMPT,
						messages: [
							{
								role: "user",
								content: [{ type: "text", text: userPrompt(c) }],
							},
						],
					},
					{ maxTokens: 160, temperature: 0 },
				),
				timeoutMs,
			);
			return parseVerdict(extractText(result?.content));
		} catch {
			return null; // abstain; the cascade falls through to asking the user
		}
	}
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (typeof part === "string") return part;
			const p = part as { type?: string; text?: string; thinking?: string };
			return p.text ?? p.thinking ?? "";
		})
		.join("");
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error("timeout")), ms);
		p.then(
			(v) => {
				clearTimeout(t);
				resolve(v);
			},
			(e) => {
				clearTimeout(t);
				reject(e);
			},
		);
	});
}
