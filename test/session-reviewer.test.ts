import { describe, expect, it, vi } from "vitest";
import { SessionReviewer, type SessionModelHost } from "../src/layers/l2-session.js";
import type { Candidate } from "../src/types.js";

const cmd: Candidate = { command: "rm -rf ~/Pictures", paths: [], cwd: "/home/u", toolName: "bash" };

function host(reply: string, opts: { fail?: boolean; delayMs?: number } = {}): SessionModelHost {
	return {
		model: { id: "glm-4.7-flash", provider: "llama-local" },
		modelRegistry: {
			complete: vi.fn(async () => {
				if (opts.fail) throw new Error("provider down");
				if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
				return { content: [{ type: "text", text: reply }] };
			}),
		},
	};
}

describe("session-model reviewer", () => {
	it("reads a verdict from the session model", async () => {
		const r = new SessionReviewer(40);
		const out = await r.review(host('{"verdict":"dangerous","why":"deletes personal files"}'), cmd, 5000);
		expect(out?.verdict).toBe("dangerous");
		expect(out?.why).toContain("personal");
	});

	it("takes the last verdict when the model reasons first", async () => {
		const r = new SessionReviewer(40);
		const reply = 'Let me think. {"verdict":"safe"} ... actually no. {"verdict":"dangerous","why":"unrecoverable"}';
		expect((await r.review(host(reply), cmd, 5000))?.verdict).toBe("dangerous");
	});

	it("abstains rather than guessing when the model errors", async () => {
		const r = new SessionReviewer(40);
		expect(await r.review(host("", { fail: true }), cmd, 5000)).toBeNull();
	});

	it("abstains on unparseable output", async () => {
		const r = new SessionReviewer(40);
		expect(await r.review(host("I think that looks fine to me"), cmd, 5000)).toBeNull();
	});

	it("times out rather than blocking the tool call", async () => {
		const r = new SessionReviewer(40);
		const out = await r.review(host('{"verdict":"safe"}', { delayMs: 300 }), cmd, 50);
		expect(out).toBeNull();
	});

	it("stops spending once the session budget is used", async () => {
		const r = new SessionReviewer(2);
		const h = host('{"verdict":"safe","why":"ok"}');
		expect(await r.review(h, cmd, 5000)).not.toBeNull();
		expect(await r.review(h, cmd, 5000)).not.toBeNull();
		// Budget spent: abstain, so the cascade asks the user instead of billing on.
		expect(await r.review(h, cmd, 5000)).toBeNull();
		expect(r.used).toBe(2);
		expect(h.modelRegistry?.complete).toHaveBeenCalledTimes(2);
	});

	it("abstains when no model is connected", async () => {
		const r = new SessionReviewer(40);
		expect(await r.review({}, cmd, 5000)).toBeNull();
	});

	it("names the model for the decision trail", () => {
		const r = new SessionReviewer(40);
		expect(r.name(host("{}"))).toBe("llama-local/glm-4.7-flash");
		expect(r.name({})).toBe("session model");
	});
});
