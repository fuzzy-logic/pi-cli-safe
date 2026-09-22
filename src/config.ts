/** Configuration, with defaults chosen so `pi install` alone is useful and safe. */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EndpointSpec } from "./discovery.js";

export interface Config {
	enabled: boolean;
	/** Rule profiles to load from profiles/. `base` is always sensible; the others are opt-in. */
	profiles: string[];
	/** Tool names the cascade inspects. */
	tools: string[];
	/** Unix socket for the Laya daemon (layer 1). Absent daemon => layer skipped. */
	layaSocket: string;
	layaTimeoutMs: number;
	/**
	 * Where layer 2's opinion comes from.
	 *   "session"  ask the model Pi is already running. Nothing to install.
	 *   "endpoint" use a dedicated reviewer from llmEndpoints (measured, local, free)
	 *   "off"      no layer 2; uncertain commands go straight to you
	 */
	llmBackend: "session" | "endpoint" | "off";
	/** Cap on session-model reviews per session, so a paid model cannot run away. */
	sessionReviewBudget: number;
	/**
	 * OpenAI-compatible endpoints for the layer-2 reviewer, in preference order.
	 * Order is how NPU-before-GPU is expressed: the NPU endpoint goes first.
	 * Entries may be a bare URL or { url, runtime, label }.
	 */
	llmEndpoints: (string | EndpointSpec)[];
	/**
	 * "best"   rank by measured false-safe rate and pick the winner
	 * "first"  take the first healthy endpoint, honouring your ordering
	 * "pinned" skip discovery and use llmEndpoints[0] with llmModel
	 */
	llmSelection: "best" | "first" | "pinned";
	/** Only used with "pinned". */
	llmModel: string | null;
	/** The reviewer should not run on CPU; set true to allow it anyway. */
	allowCpuReviewer: boolean;
	llmTimeoutMs: number;
	/** What to do when there is no UI to ask (pi -p). Layer 3 cannot run. */
	nonInteractive: "block" | "allow";
	/** Never hard-block on a model's opinion; only layer 0 rules and your own answers can. */
	logFile: string;
	stateDir: string;
}

const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`;
const stateDir = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "pi-cli-safe");

export const DEFAULTS: Config = {
	enabled: true,
	profiles: ["base"],
	tools: ["bash", "write", "edit"],
	layaSocket: join(runtimeDir, "pi-cli-safe-laya.sock"),
	layaTimeoutMs: 400,
	// The session model needs no setup and is always there, so it is the default.
	llmBackend: "session",
	sessionReviewBudget: 40,
	llmEndpoints: [
		// An NPU runtime, when one exists, is preferred simply by being first.
		{ url: "http://127.0.0.1:8130/v1", runtime: "npu", label: "npu" },
		{ url: "http://127.0.0.1:8127/v1", runtime: "gpu", label: "dedicated reviewer" },
	],
	llmSelection: "best",
	llmModel: null,
	allowCpuReviewer: false,
	llmTimeoutMs: 4000,
	nonInteractive: "block",
	logFile: join(stateDir, "decisions.jsonl"),
	stateDir,
};

/** Merge user config from ~/.config/pi-cli-safe/config.json and .pi/pi-cli-safe.json. */
export function loadConfig(cwd: string): Config {
	const candidates = [
		join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "pi-cli-safe", "config.json"),
		join(cwd, ".pi", "pi-cli-safe.json"),
	];
	let cfg: Config = { ...DEFAULTS };
	for (const path of candidates) {
		try {
			if (!existsSync(path)) continue;
			Object.assign(cfg, JSON.parse(readFileSync(path, "utf8")) as Partial<Config>);
		} catch {
			// A broken config file must not disable the guard.
		}
	}
	return migrate(cfg);
}

/**
 * Accept the pre-discovery config shape. `llmEndpoint` + `llmModel` used to name
 * one server; that now means "pin this one".
 */
function migrate(cfg: Config & { llmEndpoint?: string }): Config {
	if (cfg.llmEndpoint) {
		const url = cfg.llmEndpoint.replace(/\/chat\/completions$/, "");
		cfg.llmEndpoints = [{ url }];
		if (cfg.llmModel) cfg.llmSelection = "pinned";
		delete cfg.llmEndpoint;
	}
	return cfg;
}
