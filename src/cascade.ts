/**
 * The cascade.
 *
 * Kept free of Pi's API so it can be unit-tested with plain objects: `runCascade`
 * takes the candidate plus injectable layer functions and returns a decision.
 */

import * as l0 from "./layers/l0-rules.js";
import * as l1 from "./layers/l1-laya.js";
import * as l2 from "./layers/l2-llm.js";
import type { Config } from "./config.js";
import type { Candidate, Tier, Verdict } from "./types.js";
import { escalate, tierRank } from "./types.js";

export interface CascadeDeps {
	score: (c: Candidate) => Promise<l1.LayaResponse | null>;
	review: (c: Candidate) => Promise<l2.LlmResult | null>;
	/** Name of the resolved reviewer, for the verdict trail. */
	reviewerName?: () => string;
}

export interface CascadeOutcome {
	/** "allow" and "block" are final; "ask" means layer 3 must run. */
	action: "allow" | "block" | "ask";
	final: Verdict;
	layers: Verdict[];
}

/**
 * Layers run cheapest-first and stop as soon as the answer is settled.
 *
 * A layer-0 `block` is the only verdict no later layer can soften — models get
 * to raise concern, never to wave through something a deterministic rule called
 * catastrophic.
 */
export async function runCascade(c: Candidate, cfg: Config, deps: CascadeDeps): Promise<CascadeOutcome> {
	const layers: Verdict[] = [];

	// ---- Layer 0: deterministic rules -------------------------------------
	const rules = l0.checkRules(c, cfg.profiles);
	layers.push(rules);

	if (rules.tier === "block") {
		return { action: "block", final: rules, layers };
	}
	if (rules.tier === "danger") {
		// Deterministic but not catastrophic: your call, no model needed.
		return { action: "ask", final: rules, layers };
	}

	// `review` from layer 0 is a floor: later layers may raise it, not clear it.
	let floor: Tier = rules.tier;

	// ---- Layer 1: Laya ----------------------------------------------------
	const laya = l1.toVerdict(await deps.score(c));
	layers.push(laya);

	const afterLaya = escalate(floor, laya.tier);
	if (afterLaya === "allow") {
		return { action: "allow", final: laya, layers };
	}
	if (afterLaya === "danger" || afterLaya === "block") {
		return { action: "ask", final: laya, layers };
	}
	floor = afterLaya; // "review" — genuinely uncertain, worth the slower layer

	// ---- Layer 2: local LLM reviewer --------------------------------------
	const llm = l2.toVerdict(await deps.review(c), deps.reviewerName?.() ?? "local reviewer");
	layers.push(llm);

	if (llm.tier === "allow" && tierRank(floor) <= tierRank("review")) {
		return { action: "allow", final: llm, layers };
	}

	// ---- Layer 3: ask ------------------------------------------------------
	return { action: "ask", final: llm, layers };
}
