/**
 * The learning loop.
 *
 * Laya's weights are frozen; nothing here retrains them. What it does is build
 * an exemplar store the daemon compares new commands against by embedding
 * similarity, so a command merely *similar* to one you flagged inherits the
 * caution on the very next call.
 *
 * Raise-only. A "dangerous" verdict applies immediately. A "safe" verdict goes
 * to a pending queue and needs explicit sign-off (`/safe review`) before it can
 * ever lower a tier. The costs are asymmetric, so the learning is too: one
 * careless "allow" must never teach the guard to permit something destructive.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import type { Candidate } from "./types.js";

export type Label = "dangerous" | "safe";

export interface Lesson {
	ts: string;
	command: string;
	cwd: string;
	label: Label;
	/** "l2" when the session model decided, "l3" when you did. */
	source: string;
	/** Dangerous lessons apply at once; safe ones wait for review. */
	applied: boolean;
}

/** Hand a lesson to the daemon; fall back to a spool file so nothing is lost. */
export function teach(socketPath: string, stateDir: string, c: Candidate, label: Label, source: string): void {
	const lesson: Lesson = {
		ts: new Date().toISOString(),
		command: c.command,
		cwd: c.cwd,
		label,
		source,
		// Raise-only: dangerous is immediate, safe is queued for review.
		applied: label === "dangerous",
	};

	spool(stateDir, lesson);

	try {
		const sock = connect(socketPath);
		const finish = () => {
			try {
				sock.destroy();
			} catch {}
		};
		const timer = setTimeout(finish, 500);
		timer.unref?.();
		sock.on("connect", () => {
			sock.write(`${JSON.stringify({ op: "teach", ...lesson })}\n`);
			setTimeout(finish, 50).unref?.();
		});
		sock.on("error", finish);
	} catch {
		// Spooled above; `/safe promote` replays it later.
	}
}

function spool(stateDir: string, lesson: Lesson): void {
	try {
		mkdirSync(stateDir, { recursive: true });
		appendFileSync(join(stateDir, "lessons.jsonl"), `${JSON.stringify(lesson)}\n`);
	} catch {
		// Never break a tool call over bookkeeping.
	}
}
