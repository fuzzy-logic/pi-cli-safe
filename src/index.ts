/**
 * pi-cli-safe — a fuzzy-logic safety cascade for the Pi coding agent.
 *
 * Cheap checks first, expensive ones only when genuinely uncertain, and a human
 * only when nothing else can decide. Every layer runs locally and costs nothing,
 * so there is no budget pressure to leave commands unexamined.
 *
 * This is a safety net against accidents, not a security boundary — see README.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runCascade } from "./cascade.js";
import { loadConfig } from "./config.js";
import * as l1 from "./layers/l1-laya.js";
import * as l3 from "./layers/l3-user.js";
import { teach } from "./learn.js";
import { ReviewerPool } from "./reviewer.js";
import { makeDecision, record } from "./log.js";
import type { Candidate } from "./types.js";

/** `PI_CLI_SAFE_DEBUG=1` traces each layer to stderr; off by default. */
const DEBUG = process.env.PI_CLI_SAFE_DEBUG === "1";
function dbg(msg: string): void {
	if (DEBUG) process.stderr.write(`[pi-cli-safe ${new Date().toISOString().slice(11, 23)}] ${msg}\n`);
}

/** Build a Candidate from whichever tool is being called. */
function toCandidate(toolName: string, input: Record<string, unknown>, cwd: string): Candidate | null {
	if (toolName === "bash") {
		const command = typeof input.command === "string" ? input.command : "";
		if (!command.trim()) return null;
		return { command, paths: [], cwd, toolName };
	}
	if (toolName === "write" || toolName === "edit") {
		const path = typeof input.path === "string" ? input.path : "";
		if (!path) return null;
		// Synthesised so the same path rules that guard `> /etc/sudoers` in bash
		// also guard a direct file write, which a bash-only guard misses entirely.
		return { command: `${toolName} ${path}`, paths: [path], cwd, toolName };
	}
	return null;
}

export default function (pi: ExtensionAPI) {
	// One pool per session: discovery runs in the background and is reused.
	let pool: ReviewerPool | null = null;

	pi.on("tool_call", async (event, ctx) => {
		dbg(`tool_call ${event.toolName} hasUI=${String(ctx.hasUI)}`);
		const cwd = ctx.cwd ?? process.cwd();
		const cfg = loadConfig(cwd);
		if (!cfg.enabled || !cfg.tools.includes(event.toolName)) return undefined;

		const candidate = toCandidate(event.toolName, event.input as Record<string, unknown>, cwd);
		if (!candidate) return undefined;

		// ctx carries the session model, which is layer 2's default backend.
		if (!pool) pool = new ReviewerPool(cfg, ctx as never);
		const reviewers = pool;

		dbg(`candidate ${JSON.stringify(candidate.command).slice(0, 80)} laya=${cfg.layaSocket} backend=${cfg.llmBackend}`);
		const started = Date.now();
		const outcome = await runCascade(candidate, cfg, {
			score: (c) => l1.scoreCommand(cfg.layaSocket, c, cfg.layaTimeoutMs),
			review: (c) => reviewers.review(c),
			reviewerName: () => reviewers.name(),
		});

		dbg(`cascade done in ${Date.now() - started} ms: action=${outcome.action} tier=${outcome.final.tier} layers=${outcome.layers.map((l) => `${l.layer}:${l.tier}/${l.source ?? ""}`).join(" ")}`);
		const finish = (allowed: boolean, reason: string) => {
			record(
				cfg.logFile,
				makeDecision(candidate, allowed ? "allow" : "block", outcome.final, outcome.layers, Date.now() - started),
			);
			dbg(`finish allowed=${allowed}`);
			return allowed ? undefined : { block: true, reason };
		};

		if (outcome.action === "allow") return finish(true, "");

		if (outcome.action === "block") {
			return finish(false, `pi-cli-safe blocked this: ${outcome.final.reason} [rule ${outcome.final.source}]`);
		}

		// action === "ask" — layer 3.
		if (!ctx.hasUI) {
			// No human available to confirm, so the honest options are allow or block.
			if (cfg.nonInteractive === "allow") return finish(true, "");
			return finish(
				false,
				`pi-cli-safe blocked this in a non-interactive session (no UI to confirm): ${outcome.final.reason}`,
			);
		}

		const answer = await l3.ask(ctx.ui, candidate, outcome.layers);
		outcome.layers.push({
			tier: answer.allowed ? "allow" : "block",
			reason: `User chose: ${answer.choice}`,
			layer: "l3",
			source: "user",
		});

		// Your answer is the best signal the system gets, so it always teaches.
		if (answer.userSaysDangerous) {
			teach(cfg.layaSocket, cfg.stateDir, candidate, "dangerous", "l3");
		} else if (answer.choice === l3.ALLOW_ALWAYS) {
			// Raise-only: queued for review, never auto-applied.
			teach(cfg.layaSocket, cfg.stateDir, candidate, "safe", "l3");
		}

		return finish(answer.allowed, `pi-cli-safe: you declined this command. ${outcome.final.reason}`);
	});
}
