/** Configuration, with defaults chosen so `pi install` alone is useful and safe. */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
	 *   "off"      no layer 2; uncertain commands go straight to you
	 */
	llmBackend: "session" | "off";
	/** Cap on session-model reviews per session, so a paid model cannot run away. */
	sessionReviewBudget: number;
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
	// Laya answers in ~400 ms on an idle box and ~600 ms while a large model is
	// generating on the same GPU. 400 ms silently disabled layer 1 under real load.
	layaTimeoutMs: 1500,
	// The session model needs no setup and is always there, so it is the default.
	llmBackend: "session",
	sessionReviewBudget: 40,
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
 * Accept config written for earlier versions. Layer 2 used to be able to run
 * against a dedicated llama-server ("endpoint", with llmEndpoints, llmSelection,
 * llmModel, allowCpuReviewer). That backend is gone: any such config now means
 * the session model, and the stale keys are dropped so they cannot confuse anyone
 * reading `/safe status`. Anything but "off" is "session".
 */
function migrate(cfg: Config): Config {
	const loose = cfg as unknown as Record<string, unknown>;
	if (loose.llmBackend !== "off") loose.llmBackend = "session";
	for (const stale of ["llmEndpoint", "llmEndpoints", "llmSelection", "llmModel", "allowCpuReviewer"]) {
		delete loose[stale];
	}
	return cfg;
}
