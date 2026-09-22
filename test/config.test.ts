import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULTS, loadConfig } from "../src/config.js";

/** Write a project-local config and load it, with the user-level file pointed at nothing. */
function load(json: Record<string, unknown>) {
	const dir = mkdtempSync(join(tmpdir(), "pi-cli-safe-cfg-"));
	mkdirSync(join(dir, ".pi"));
	writeFileSync(join(dir, ".pi", "pi-cli-safe.json"), JSON.stringify(json));
	const prev = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = join(dir, "no-user-config");
	try {
		return { cfg: loadConfig(dir), dir };
	} finally {
		if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = prev;
	}
}

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("config", () => {
	it("defaults to the session model for layer 2", () => {
		expect(DEFAULTS.llmBackend).toBe("session");
	});

	it("migrates a config written for the removed dedicated-endpoint backend", () => {
		const { cfg, dir } = load({
			llmBackend: "endpoint",
			llmEndpoints: [{ url: "http://127.0.0.1:8127/v1", runtime: "gpu" }],
			llmSelection: "best",
			llmModel: null,
			allowCpuReviewer: false,
		});
		dirs.push(dir);
		// The guard must not silently lose layer 2 because a config predates the change.
		expect(cfg.llmBackend).toBe("session");
		for (const key of ["llmEndpoints", "llmSelection", "llmModel", "allowCpuReviewer"]) {
			expect(key in cfg).toBe(false);
		}
	});

	it("keeps an explicit off", () => {
		const { cfg, dir } = load({ llmBackend: "off" });
		dirs.push(dir);
		expect(cfg.llmBackend).toBe("off");
	});

	it("survives a broken file without disabling the guard", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-cli-safe-cfg-"));
		dirs.push(dir);
		mkdirSync(join(dir, ".pi"));
		writeFileSync(join(dir, ".pi", "pi-cli-safe.json"), "{ not json");
		expect(loadConfig(dir).enabled).toBe(true);
	});
});
