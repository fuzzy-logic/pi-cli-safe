"""The exemplar store — how the guard learns without retraining.

Laya's weights are frozen. Nothing here changes them. What it does instead is
keep the commands you (or the session model) have ruled on, embedded with the
*already-loaded* encoder via `laya.embed_fn_from_agent`, and compare each new
command against them by cosine similarity. A command merely *similar* to one you
flagged inherits the caution on the very next call.

Raise-only, by design. A "dangerous" exemplar applies immediately. A "safe" one
is stored but never consulted until you approve it with `/safe review`. The
costs are asymmetric -- a wrongly-blocked command costs you one prompt, a
wrongly-allowed one can cost the machine -- so the learning is asymmetric too.
One careless "allow" can never teach the guard to permit something destructive.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import threading
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable, List, Optional, Sequence

import numpy as np

# Similarity thresholds, in MEAN-CENTRED cosine space.
#
# Raw mean-pooled embeddings of shell commands are anisotropic: measured over the
# 181-command seed corpus, the median cosine between two *unrelated* commands is
# 0.85 and 7.6% of unrelated pairs exceed 0.92 -- `df -h` sat at 0.95 to a taught
# exfiltration command. Subtracting the corpus mean drops the unrelated median to
# -0.01 (p99 0.62) while paraphrases land at 0.50-0.78. Both bars below refer to
# that centred space; a store built without a centre falls back to raw cosine
# and should keep the old 0.92 bar.
#
#   >= DANGER_THRESHOLD  the paraphrase inherits "danger" outright
#   >= DEFAULT_THRESHOLD it is raised to "review" so the LLM layer double-checks
#
# On top of similarity, the new command must share the exemplar's head (its
# leading program, e.g. `rm`, `git push`): the encoder cannot tell `| sh` from
# `| jq`, but it never needs to compare `tar` with `mv` either. Measured against a
# realistic 8-exemplar store, this pair of rules cut false hits on the 111 safe
# seed commands from 35 to 3.
DEFAULT_THRESHOLD = 0.55
DANGER_THRESHOLD = 0.75
RAW_THRESHOLD = 0.92

_WRAPPERS = {"sudo", "doas", "env", "nohup", "time", "command", "builtin"}
_SUBCOMMAND = {"git", "docker", "podman", "kubectl", "systemctl", "npm", "pnpm", "yarn", "cargo", "pip", "gh", "apt", "pacman", "brew"}


def command_head(command: str) -> str:
    """The leading program of the first pipeline stage, e.g. `rm` or `git push`."""
    first = re.split(r"\||&&|;", command, maxsplit=1)[0]
    try:
        toks = shlex.split(first)
    except ValueError:
        toks = first.split()
    toks = [t for t in toks if "=" not in t or t.startswith("-")]  # drop VAR=val prefixes
    while toks and toks[0] in _WRAPPERS:
        toks = toks[1:]
    while toks and toks[0].startswith("-") and len(toks) > 1:  # e.g. `sudo -E cmd`
        toks = toks[1:]
    if not toks:
        return ""
    head = os.path.basename(toks[0])
    if head in _SUBCOMMAND:
        sub = next((t for t in toks[1:] if not t.startswith("-")), None)
        if sub:
            return f"{head} {sub}"
    return head


@dataclass
class Exemplar:
    command: str
    label: str  # "dangerous" | "safe"
    source: str  # "l2" | "l3"
    ts: str
    applied: bool


class ExemplarStore:
    """Append-only JSONL plus an in-memory embedding matrix."""

    def __init__(
        self,
        path: Path,
        embed: Callable[[Sequence[str]], np.ndarray],
        centre: Optional[np.ndarray] = None,
    ):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._embed = embed
        # Corpus mean; subtracted before normalising. None means raw cosine.
        self._centre = None if centre is None else np.asarray(centre, dtype=np.float64)
        self._lock = threading.Lock()
        self.items: List[Exemplar] = []
        self._vecs: Optional[np.ndarray] = None
        self._load()

    # ---- persistence -----------------------------------------------------
    def _load(self) -> None:
        if not self.path.exists():
            return
        rows = []
        for line in self.path.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
                rows.append(
                    Exemplar(
                        command=d["command"],
                        label=d["label"],
                        source=d.get("source", "unknown"),
                        ts=d.get("ts", ""),
                        applied=bool(d.get("applied", d["label"] == "dangerous")),
                    )
                )
            except Exception:
                continue  # A corrupt line must not stop the daemon starting.
        self.items = rows
        self._reembed()

    def _append_line(self, ex: Exemplar) -> None:
        with self.path.open("a") as fh:
            fh.write(json.dumps(asdict(ex)) + "\n")

    # ---- embeddings ------------------------------------------------------
    def _reembed(self) -> None:
        active = self._active()
        if not active:
            self._vecs = None
            return
        self._vecs = self._project(self._embed([e.command for e in active]))

    def _project(self, vecs: np.ndarray) -> np.ndarray:
        """Centre (when a corpus mean is known) and L2-normalise."""
        x = np.asarray(vecs, dtype=np.float64)
        if self._centre is not None:
            x = x - self._centre
        norms = np.linalg.norm(x, axis=1, keepdims=True)
        return x / np.clip(norms, 1e-9, None)

    def _active(self) -> List[Exemplar]:
        """Only applied, dangerous exemplars ever influence a decision."""
        return [e for e in self.items if e.applied and e.label == "dangerous"]

    # ---- public API ------------------------------------------------------
    def add(self, command: str, label: str, source: str) -> Exemplar:
        ex = Exemplar(
            command=command,
            label=label,
            source=source,
            ts=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            # Raise-only: dangerous applies now, safe waits for review.
            applied=(label == "dangerous"),
        )
        with self._lock:
            self.items.append(ex)
            self._append_line(ex)
            if ex.applied:
                self._reembed()
        return ex

    def nearest(self, command: str, threshold: float = DEFAULT_THRESHOLD):
        """Return (similarity, exemplar) when a known-dangerous command with the
        same head is at least `threshold` close; otherwise None."""
        with self._lock:
            if self._vecs is None or len(self._vecs) == 0:
                return None
            active = self._active()
            head = command_head(command)
            rows = [i for i, e in enumerate(active) if command_head(e.command) == head]
            if not rows:
                return None
            q = self._project(self._embed([command]))[0]
            sims = self._vecs[rows] @ q
            j = int(np.argmax(sims))
            best = float(sims[j])
            if best < threshold:
                return None
            return best, active[rows[j]]

    def pending(self) -> List[Exemplar]:
        """Safe verdicts awaiting your sign-off. Never consulted until approved."""
        return [e for e in self.items if not e.applied]

    def stats(self) -> dict:
        return {
            "total": len(self.items),
            "active_dangerous": len(self._active()),
            "pending_review": len(self.pending()),
            "path": str(self.path),
        }
