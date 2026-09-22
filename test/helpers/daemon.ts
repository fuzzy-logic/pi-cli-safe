/**
 * A private Laya daemon for tests that teach.
 *
 * The learning-loop tests used to teach the *live* daemon, which left test
 * exemplars in the user's real store (nine copies of one exfiltration command
 * were found there). This spawns daemon/server.py with its own XDG_STATE_HOME
 * and socket, so nothing a test teaches outlives the run. Costs one model load
 * (~15 s, ~3 GiB), which is why only the tests that need it pay for it.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export interface PrivateDaemon {
	socket: string;
	stateDir: string;
	stop(): void;
}

/** The interpreter the installed daemon runs under, or null when absent. */
export function pythonForDaemon(): string | null {
	const candidate =
		process.env.PI_CLI_SAFE_PYTHON ?? join(homedir(), ".local", "share", "pi-cli-safe", "venv", "bin", "python");
	return existsSync(candidate) ? candidate : null;
}

export async function startPrivateDaemon(timeoutMs = 120_000): Promise<PrivateDaemon | null> {
	const py = pythonForDaemon();
	if (!py) return null;
	const stateDir = mkdtempSync(join(tmpdir(), "pi-cli-safe-test-"));
	const socket = join(stateDir, "laya.sock");
	const child: ChildProcess = spawn(py, [join(process.cwd(), "daemon", "server.py"), "--socket", socket], {
		env: { ...process.env, XDG_STATE_HOME: stateDir },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let log = "";
	child.stdout?.on("data", (c) => (log += c.toString()));
	child.stderr?.on("data", (c) => (log += c.toString()));

	const deadline = Date.now() + timeoutMs;
	while (!log.includes("listening on")) {
		if (child.exitCode !== null || Date.now() > deadline) {
			child.kill();
			rmSync(stateDir, { recursive: true, force: true });
			console.error(`private daemon did not start:\n${log.slice(-800)}`);
			return null;
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	return {
		socket,
		stateDir,
		stop() {
			child.kill();
			rmSync(stateDir, { recursive: true, force: true });
		},
	};
}
