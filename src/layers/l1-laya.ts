/**
 * Layer 1 — Laya.
 *
 * A 421M non-autoregressive decision model, scored over a unix socket by a
 * resident Python daemon. ~130 ms on CPU, local, free, so every command can be
 * examined rather than only the ones a regex flagged.
 *
 * The daemon is optional. If the socket is absent or slow the layer reports
 * "unavailable" and the cascade continues to layer 2 — a dead daemon degrades
 * the guard, it never blocks the agent.
 */

import { connect } from "node:net";
import type { Candidate, Tier, Verdict } from "../types.js";

/** Semantic facts from Laya. Syntactic ones are read off the string instead —
 *  the model measured badly on those. See daemon/syntax.py. */
export interface LayaFacts {
	deletes: number;
	overwrites: number;
	fetch_exec: number;
	system_config: number;
	sends_data: number;
	reads_secrets: number;
	scope: string;
	scope_probabilities: Record<string, number>;
	syntax: {
		recursive: boolean;
		needs_root: boolean;
		force: boolean;
		truncating_redirect: boolean;
		wide_glob: boolean;
		pipes_to_shell: boolean;
		touches_system_path: boolean;
		touches_absolute_path: boolean;
	};
}

export interface LayaResponse {
	tier: Tier;
	reason: string;
	facts: LayaFacts;
	/** Set when the exemplar store raised this command's tier. */
	learned?: { similarity: number; exemplar: string; raisedTo: Tier };
	ms: number;
}

/** One request/response over the socket. Resolves null on any failure. */
export function scoreCommand(
	socketPath: string,
	c: Candidate,
	timeoutMs: number,
): Promise<LayaResponse | null> {
	return new Promise((resolve) => {
		let settled = false;
		const done = (v: LayaResponse | null) => {
			if (settled) return;
			settled = true;
			try {
				sock.destroy();
			} catch {}
			resolve(v);
		};

		const sock = connect(socketPath);
		const timer = setTimeout(() => done(null), timeoutMs);
		timer.unref?.();

		let buf = "";
		sock.on("connect", () => {
			sock.write(`${JSON.stringify({ op: "score", command: c.command, cwd: c.cwd, paths: c.paths })}\n`);
		});
		sock.on("data", (chunk) => {
			buf += chunk.toString();
			const nl = buf.indexOf("\n");
			if (nl === -1) return;
			clearTimeout(timer);
			try {
				done(JSON.parse(buf.slice(0, nl)) as LayaResponse);
			} catch {
				done(null);
			}
		});
		sock.on("error", () => {
			clearTimeout(timer);
			done(null);
		});
	});
}

export function toVerdict(r: LayaResponse | null): Verdict {
	if (!r) {
		return {
			tier: "review",
			reason: "Laya daemon unavailable — deferring to the next layer.",
			layer: "l1",
			source: "unavailable",
		};
	}
	const reason = r.learned
		? `${r.reason} (matches a command you previously flagged, similarity ${r.learned.similarity.toFixed(2)})`
		: r.reason;
	return {
		tier: r.tier,
		reason,
		layer: "l1",
		source: r.learned ? "laya+learned" : "laya",
		detail: { facts: r.facts, learned: r.learned, ms: r.ms },
	};
}
