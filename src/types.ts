/** Shared types for the pi-cli-safe cascade. */

/**
 * Risk tiers, ordered. `escalate()` relies on this order, and the learning loop's
 * raise-only rule is expressed as "never move a command to a lower index".
 */
export const TIERS = ["allow", "review", "danger", "block"] as const;
export type Tier = (typeof TIERS)[number];

export function tierRank(t: Tier): number {
	return TIERS.indexOf(t);
}

/** Returns whichever tier is more cautious. Never lowers risk. */
export function escalate(a: Tier, b: Tier): Tier {
	return tierRank(b) > tierRank(a) ? b : a;
}

export interface Verdict {
	tier: Tier;
	/** Human-readable justification, shown to the user and sent back to the agent. */
	reason: string;
	/** Which layer produced this: "l0" | "l1" | "l2" | "l3" | "learned". */
	layer: string;
	/** Rule id, model name, or exemplar id — whatever identifies the decision. */
	source?: string;
	/** Layer-specific payload, recorded in the decision log. */
	detail?: Record<string, unknown>;
}

export interface Candidate {
	/** The bash command, or a synthesised description for write/edit calls. */
	command: string;
	/** Paths the call touches, when known (write/edit). */
	paths: string[];
	cwd: string;
	toolName: string;
}

export interface Rule {
	id: string;
	severity: Tier;
	pattern: string;
	reason: string;
	examples?: string[];
}

export interface Profile {
	name: string;
	description: string;
	rules: Rule[];
}
