/**
 * Layer 3 — ask the user.
 *
 * The last resort, and the only layer that can approve something the earlier
 * layers were worried about. Your answer is also the highest-quality training
 * signal the system gets, so it always feeds the learning loop.
 */

import type { Candidate, Verdict } from "../types.js";

export interface AskResult {
	allowed: boolean;
	/** True when the user actively judged this dangerous, rather than just declining. */
	userSaysDangerous: boolean;
}

interface Ui {
	select(prompt: string, options: string[]): Promise<string | undefined>;
}

const ALLOW_ONCE = "Allow once";
const ALLOW_ALWAYS = "Allow — and stop asking about commands like this";
const BLOCK = "Block — this is dangerous";

export async function ask(ui: Ui, c: Candidate, prior: Verdict[]): Promise<AskResult & { choice: string }> {
	const worry = prior[prior.length - 1];
	const trail = prior
		.filter((v) => v.tier !== "allow")
		.map((v) => `  ${v.layer}: ${v.reason}`)
		.join("\n");

	const prompt =
		`⚠  pi-cli-safe — ${c.toolName}\n\n  ${c.command}\n\n` +
		`${trail || `  ${worry?.reason ?? "Flagged for review."}`}\n\nRun it?`;

	const choice = (await ui.select(prompt, [ALLOW_ONCE, ALLOW_ALWAYS, BLOCK])) ?? BLOCK;

	return {
		choice,
		allowed: choice !== BLOCK,
		userSaysDangerous: choice === BLOCK,
	};
}

export { ALLOW_ALWAYS, ALLOW_ONCE, BLOCK };
