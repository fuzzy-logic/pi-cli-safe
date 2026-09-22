"""The exemplar store — how the guard learns without retraining.

Laya's weights are frozen. Nothing here changes them. What it does instead is
keep the commands you (or the local reviewer) have ruled on, embedded with the
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
import threading
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable, List, Optional, Sequence

import numpy as np

# Cosine similarity above which a stored exemplar is considered to cover a new
# command. Deliberately high: these are short strings and the encoder puts
# unrelated shell commands closer together than prose. calibrate.py re-fits it.
DEFAULT_THRESHOLD = 0.92


@dataclass
class Exemplar:
    command: str
    label: str  # "dangerous" | "safe"
    source: str  # "l2" | "l3"
    ts: str
    applied: bool


class ExemplarStore:
    """Append-only JSONL plus an in-memory embedding matrix."""

    def __init__(self, path: Path, embed: Callable[[Sequence[str]], np.ndarray]):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._embed = embed
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
        vecs = self._embed([e.command for e in active])
        norms = np.linalg.norm(vecs, axis=1, keepdims=True)
        self._vecs = vecs / np.clip(norms, 1e-9, None)

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
        """Return (similarity, exemplar) when a known-dangerous command is close."""
        with self._lock:
            if self._vecs is None or len(self._vecs) == 0:
                return None
            q = self._embed([command])[0]
            q = q / max(float(np.linalg.norm(q)), 1e-9)
            sims = self._vecs @ q
            i = int(np.argmax(sims))
            best = float(sims[i])
            if best < threshold:
                return None
            return best, self._active()[i]

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
