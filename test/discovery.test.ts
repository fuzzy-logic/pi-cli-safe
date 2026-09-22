import { afterEach, describe, expect, it, vi } from "vitest";
import * as d from "../src/discovery.js";

const OK = { status: "ok" };

/** Stub fetch so endpoints can be simulated without running a server. */
function mockEndpoints(map: Record<string, { health?: unknown; props?: unknown; models?: unknown }>) {
	vi.stubGlobal("fetch", async (url: string | URL) => {
		const u = String(url);
		for (const [base, r] of Object.entries(map)) {
			if (!u.startsWith(base)) continue;
			const body = u.endsWith("/health") ? r.health : u.endsWith("/props") ? r.props : r.models;
			if (body === undefined) return { ok: false, json: async () => ({}) };
			return { ok: true, json: async () => body };
		}
		throw new Error("unreachable");
	});
}

afterEach(() => vi.unstubAllGlobals());

const gpu4b = {
	health: OK,
	props: { model_path: "/m/Qwen3-VL-4B-Instruct-UD-Q4_K_XL.gguf", model_alias: "reviewer" },
	models: { data: [{ id: "reviewer" }] },
};
const moe35b = {
	health: OK,
	props: { model_path: "/m/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf" },
	models: { data: [{ id: "big" }] },
};

describe("inspect", () => {
	it("rejects a server that is still loading", async () => {
		mockEndpoints({
			"http://a": { health: { error: { message: "Loading model" } }, props: {}, models: {} },
		});
		// 200 with a loading body is the trap: the status code says nothing.
		expect(await d.inspect("http://a/v1")).toBeNull();
	});

	it("reads the model path behind an alias", async () => {
		mockEndpoints({ "http://a": gpu4b });
		const r = await d.inspect("http://a/v1");
		expect(r?.model).toBe("reviewer");
		expect(r?.modelPath).toContain("Qwen3-VL-4B");
	});

	it("returns null for an unreachable endpoint", async () => {
		mockEndpoints({});
		expect(await d.inspect("http://nope/v1")).toBeNull();
	});
});

describe("ranking", () => {
	it("prefers the lower false-safe model over the larger one", async () => {
		mockEndpoints({ "http://big": moe35b, "http://small": gpu4b });
		const { chosen } = await d.discover(["http://big/v1", "http://small/v1"], {
			selection: "best",
			allowCpu: false,
		});
		// The 35B is ~7x larger and scored 3 false-safes to the 4B's 0.
		// Ranking by size would pick exactly the wrong one.
		expect(chosen?.modelPath).toContain("Qwen3-VL-4B");
		expect(chosen?.falseSafe).toBe(0);
	});

	it("'first' honours the order given, which is how NPU preference works", async () => {
		mockEndpoints({ "http://npu": moe35b, "http://gpu": gpu4b });
		const { chosen } = await d.discover(
			[{ url: "http://npu/v1", runtime: "npu" }, { url: "http://gpu/v1", runtime: "gpu" }],
			{ selection: "first", allowCpu: false },
		);
		expect(chosen?.endpoint).toBe("http://npu/v1");
		expect(chosen?.runtime).toBe("npu");
	});

	it("skips a CPU endpoint unless allowed", async () => {
		mockEndpoints({ "http://cpu": gpu4b });
		const spec = [{ url: "http://cpu/v1", runtime: "cpu" as const }];
		expect((await d.discover(spec, { selection: "best", allowCpu: false })).chosen).toBeNull();
		expect((await d.discover(spec, { selection: "best", allowCpu: true })).chosen).not.toBeNull();
	});

	it("returns null when nothing is usable", async () => {
		mockEndpoints({});
		const { chosen } = await d.discover(["http://a/v1", "http://b/v1"], {
			selection: "best",
			allowCpu: false,
		});
		expect(chosen).toBeNull();
	});
});

describe("cache", () => {
	it("keys on endpoint and model path so a swapped model invalidates", () => {
		const a = d.cacheKey({ endpoint: "http://a/v1", modelPath: "/m/one.gguf" });
		const b = d.cacheKey({ endpoint: "http://a/v1", modelPath: "/m/two.gguf" });
		expect(a).not.toBe(b);
	});
});
