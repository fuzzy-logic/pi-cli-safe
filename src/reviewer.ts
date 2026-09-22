/**
 * Session-level reviewer resolution.
 *
 * Discovery is not on the hot path. The first tool call kicks it off and waits
 * only briefly — a scorecard hit resolves in well under 100 ms — so a session
 * does not open with a spurious prompt. A slow probe still falls through: no tool
 * call waits longer than FIRST_CALL_WAIT_MS, and every later call reuses the result.
 */

import * as d from "./discovery.js";
import type { Config } from "./config.js";
import { reviewCommand } from "./layers/l2-llm.js";
import type { Candidate } from "./types.js";
import type { LlmResult } from "./layers/l2-llm.js";
import { SessionReviewer, type SessionModelHost } from "./layers/l2-session.js";

/** How stale a resolution may get before we re-check what the endpoint is serving. */
const RECHECK_MS = 10 * 60 * 1000;
/** Longest the first review waits for discovery before abstaining. */
const FIRST_CALL_WAIT_MS = 1000;

export class ReviewerPool {
	private current: d.Reviewer | null = null;
	private resolvedAt = 0;
	private inFlight: Promise<void> | null = null;

	private session: SessionReviewer;

	constructor(
		private cfg: Config,
		/** Pi's ExtensionContext, when the session-model backend is in use. */
		private host?: SessionModelHost,
	) {
		this.session = new SessionReviewer(cfg.sessionReviewBudget);
	}

	/** What was chosen, for /safe status. */
	get chosen(): d.Reviewer | null {
		return this.current;
	}

	/** Human-readable name of whatever is actually answering. */
	name(): string {
		if (this.cfg.llmBackend === "session") {
			return this.host ? this.session.name(this.host) : "session model";
		}
		return this.current?.model ?? "local reviewer";
	}

	private stale(): boolean {
		return !this.current || Date.now() - this.resolvedAt > RECHECK_MS;
	}

	/** Kick off discovery if needed. Never awaited by a tool call. */
	private refresh(): void {
		if (this.inFlight || !this.stale()) return;
		this.inFlight = (async () => {
			try {
				if (this.cfg.llmSelection === "pinned") {
					const specs = d.normalizeEndpoints(this.cfg.llmEndpoints);
					const first = specs[0];
					if (first && this.cfg.llmModel) {
						this.current = {
							endpoint: first.url,
							model: this.cfg.llmModel,
							modelPath: "",
							runtime: first.runtime ?? "unknown",
							falseSafe: 0,
							falseAlarm: 0,
							medianMs: 0,
							source: "scorecard",
						};
					}
				} else {
					const { chosen } = await d.discover(this.cfg.llmEndpoints, {
						selection: this.cfg.llmSelection === "first" ? "first" : "best",
						allowCpu: this.cfg.allowCpuReviewer,
					});
					this.current = chosen;
					if (chosen) d.remember(this.cfg.stateDir, chosen);
				}
				this.resolvedAt = Date.now();
			} catch {
				this.resolvedAt = Date.now(); // do not spin on a broken endpoint
			} finally {
				this.inFlight = null;
			}
		})();
	}

	/** Review one command with whichever reviewer is currently resolved. */
	async review(c: Candidate): Promise<LlmResult | null> {
		if (this.cfg.llmBackend === "off") return null;
		if (this.cfg.llmBackend === "session") {
			// Nothing to discover: Pi already has a model connected.
			return this.host ? this.session.review(this.host, c, this.cfg.llmTimeoutMs) : null;
		}
		this.refresh();
		if (!this.current && this.inFlight) {
			await Promise.race([this.inFlight, new Promise<void>((res) => setTimeout(res, FIRST_CALL_WAIT_MS).unref?.())]);
		}
		const r = this.current;
		if (!r) return null; // layer 2 abstains; the cascade asks the user instead
		const out = await reviewCommand(`${r.endpoint}/chat/completions`, r.model, c, this.cfg.llmTimeoutMs);
		if (out === null) {
			// The endpoint changed under us, or died. Re-resolve next call.
			this.resolvedAt = 0;
		}
		return out;
	}

	/** Resolve synchronously, for tests and `/safe status`. */
	async resolveNow(): Promise<d.Reviewer | null> {
		this.resolvedAt = 0;
		this.refresh();
		await this.inFlight;
		return this.current;
	}
}
