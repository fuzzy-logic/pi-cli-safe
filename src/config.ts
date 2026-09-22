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
	/** OpenAI-compatible endpoint for the local reviewer (layer 2). */
	llmEndpoint: string;
	llmModel: string;
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
	llmEndpoint: "http://127.0.0.1:8127/v1/chat/completions",
	llmModel: "reviewer",
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
	return cfg;
}
