/** Append-only decision log. Every decision is recorded with its full reasoning. */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Candidate, Verdict } from "./types.js";

export interface Decision {
	ts: string;
	tool: string;
	command: string;
	cwd: string;
	outcome: "allow" | "block";
	finalTier: string;
	decidedBy: string;
	reason: string;
	layers: Verdict[];
	ms: number;
}

export function record(path: string, d: Decision): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify(d)}\n`);
	} catch {
		// Logging must never break a tool call.
	}
}

export function makeDecision(
	c: Candidate,
	outcome: "allow" | "block",
	final: Verdict,
	layers: Verdict[],
	ms: number,
): Decision {
	return {
		ts: new Date().toISOString(),
		tool: c.toolName,
		command: c.command,
		cwd: c.cwd,
		outcome,
		finalTier: final.tier,
		decidedBy: final.layer,
		reason: final.reason,
		layers,
		ms,
	};
}
