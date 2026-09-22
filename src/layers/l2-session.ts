/**
 * Layer 2, session-model backend.
 *
 * Pi is already connected to a model. When Laya cannot settle a command, ask
 * that one. No second server, no separate model download, no GPU memory, no
 * discovery — and it is always available, because if Pi is running then a model
 * is connected.
 *
 * Two things this trades away, stated plainly:
 *
 *  1. Cost. On a paid cloud model every uncertain command spends tokens. The
 *     per-session call budget below bounds that; it is not free the way a local
 *     reviewer is.
 *  2. Control. Benchmarking showed larger models are *more* permissive as
 *     safety reviewers — a 22G MoE waved through `rm -rf ~/Documents/archive`
 *     that a 2.4G model caught. Using whatever the session happens to run gives
 *     up the ability to pick a model measured to be careful. The endpoint
 *     backend exists for when that control matters more than the simplicity.
 */

import { SYSTEM_PROMPT, parseVerdict } from "./l2-llm.js";
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
								content: [{ type: "text", text: `Working directory: ${c.cwd}\nTool: ${c.toolName}\nCommand:\n${c.command}` }],
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
