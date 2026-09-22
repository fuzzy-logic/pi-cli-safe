/**
 * Layer 0 — deterministic rules.
 *
 * This layer never consults a model and needs no daemon, which is what makes it
 * safe for the rest of the cascade to fail open: whatever else is down, the
 * catastrophic patterns still fire.
 *
 * It is a *supplement* to pi-prevent-destructive-commands, not a replacement.
 * That extension owns the cwd-boundary model for rm/rmdir/shred and the
 * git/docker/aws rule sets, and it registers its own tool_call hook, so install
 * both. These profiles cover what it does not check at all: block devices,
 * filesystem creation, the boot chain, and disk encryption.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Candidate, Profile, Rule, Tier, Verdict } from "../types.js";
import { escalate } from "../types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = join(HERE, "..", "..", "profiles");

const cache = new Map<string, Profile>();

export function loadProfiles(names: string[]): Profile[] {
	const out: Profile[] = [];
	for (const name of names) {
		let p = cache.get(name);
		if (!p) {
			try {
				p = JSON.parse(readFileSync(join(PROFILE_DIR, `${name}.json`), "utf8")) as Profile;
				cache.set(name, p);
			} catch {
				continue; // An unknown profile name is ignored, not fatal.
			}
		}
		out.push(p);
	}
	return out;
}

interface Compiled extends Rule {
	re: RegExp;
	profile: string;
}

const compiled = new Map<string, Compiled[]>();

function compile(profiles: Profile[]): Compiled[] {
	const key = profiles.map((p) => p.name).join(",");
	const hit = compiled.get(key);
	if (hit) return hit;
	const rules: Compiled[] = [];
	for (const p of profiles) {
		for (const r of p.rules) {
			try {
				rules.push({ ...r, re: new RegExp(r.pattern, "i"), profile: p.name });
			} catch {
				// A malformed pattern must not take the whole guard down.
			}
		}
	}
	compiled.set(key, rules);
	return rules;
}

/**
 * Text we match against. For bash this is the command; for write/edit we
 * synthesise `> <path>` so the same path rules (/etc/sudoers, /boot, …) apply
 * to a direct file write, which is otherwise invisible to a bash-only guard.
 */
function matchTarget(c: Candidate): string {
	if (c.toolName === "bash") return c.command;
	return c.paths.map((p) => `> ${p}`).join("\n");
}

export function checkRules(c: Candidate, profileNames: string[]): Verdict {
	const rules = compile(loadProfiles(profileNames));
	const target = matchTarget(c);
	let tier: Tier = "allow";
	const hits: { id: string; reason: string; severity: Tier }[] = [];

	for (const r of rules) {
		if (!r.re.test(target)) continue;
		hits.push({ id: r.id, reason: r.reason, severity: r.severity });
		tier = escalate(tier, r.severity);
	}

	if (hits.length === 0) {
		return { tier: "allow", reason: "No deterministic rule matched.", layer: "l0" };
	}
	// Report the most severe hit; keep the rest for the log.
	const worst = hits.reduce((a, b) => (a.severity === tier ? a : b));
	return {
		tier,
		reason: worst.reason,
		layer: "l0",
		source: worst.id,
		detail: { hits },
	};
}
