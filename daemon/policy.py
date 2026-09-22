"""Facts -> risk tier. This is the part you edit to change what counts as risky.

Two inputs, deliberately separated:

  Facts   - semantic, from Laya. What does this command *mean*?
  Syntax  - syntactic, from regex. What does the string literally contain?

Laya is asked only for meaning because that is the only part it measured well.
Recursion flags and `sudo` are read exactly by `syntax.py` instead.

Kept readable and boring: a list of named conditions, each returning a tier and
a reason. No weights to tune, nothing to reverse-engineer when it surprises you.

Tiers:
  allow   - let it run
  review  - genuinely uncertain; layer 2 (the session model) resolves it
  danger  - ask the user
"""

from dataclasses import dataclass
from typing import Dict, List, Tuple

from syntax import Syntax

TIERS = ("allow", "review", "danger", "block")


def rank(t: str) -> int:
    return TIERS.index(t)


def escalate(a: str, b: str) -> str:
    """Return whichever tier is more cautious. Never lowers risk."""
    return b if rank(b) > rank(a) else a


@dataclass
class Facts:
    deletes: float
    overwrites: float
    fetch_exec: float
    system_config: float
    sends_data: float
    reads_secrets: float
    scope: str
    scope_probabilities: Dict[str, float]


NOUL_FIELDS = ("deletes", "overwrites", "fetch_exec", "system_config", "sends_data", "reads_secrets")

# Thresholds. `calibrate.py` re-fits these against data/seed-commands.jsonl.
HI = 0.70  # the model is fairly sure the fact holds
LO = 0.35  # below this, treat the fact as absent

WIDE = ("home", "system")


def decide(f: Facts, s: Syntax) -> Tuple[str, str]:
    """Return (tier, reason)."""
    wide = f.scope in WIDE

    rules: List[Tuple[bool, str, str]] = [
        # ---- danger: worth interrupting for ------------------------------
        # Corroborated by syntax: `curl | jq` and `curl | sh` both score high on
        # fetch_exec, but only one of them executes anything.
        (f.fetch_exec >= HI and s.pipes_to_shell, "danger",
         "Downloads something from the internet and pipes it into a shell."),
        (f.deletes >= HI and s.recursive and wide and s.touches_absolute_path, "danger",
         f"Recursively deletes files across your {f.scope}."),
        (f.deletes >= HI and s.recursive and s.touches_system_path, "danger",
         "Recursively deletes files in a system location."),
        # `rm -rf ./build` is the most routine command in development, so a
        # forced recursive delete only escalates when the target is broad.
        (f.deletes >= HI and s.recursive and s.wide_glob, "danger",
         "Recursive delete against a broad glob."),
        (f.overwrites >= HI and s.touches_system_path and (s.truncating_redirect or s.force),
         "danger", "Overwrites something in a system location."),
        (f.reads_secrets >= HI and f.sends_data >= HI and s.touches_absolute_path, "danger",
         "Reads credentials and sends data to a remote server."),
        (f.system_config >= HI and s.needs_root and f.scope != "nothing", "danger",
         "Changes system configuration with root privileges."),
        (s.needs_root and f.deletes >= HI and wide, "danger",
         "Deletes files as root outside your project."),

        # ---- review: uncertain, hand to the slower layer ------------------
        (f.deletes >= HI and wide and s.touches_absolute_path, "review",
         f"Deletes files in your {f.scope}."),
        (f.deletes >= HI and s.recursive, "review", "Recursive delete."),
        (f.deletes >= HI and s.wide_glob, "review", "Deletes using a broad glob."),
        (f.overwrites >= HI, "review", "Overwrites an existing file."),
        (f.reads_secrets >= HI, "review", "Reads credentials or private keys."),
        (f.sends_data >= HI and s.touches_absolute_path, "review",
         "Sends data from your files to a remote server."),
        (f.system_config >= HI and (s.needs_root or s.touches_system_path), "review",
         "Changes system configuration or installed packages."),
        (s.needs_root and (f.system_config >= LO or f.deletes >= LO), "review",
         "Runs as root and modifies something."),
        (s.truncating_redirect and s.touches_system_path, "review",
         "Truncates a file in a system location."),
        (f.fetch_exec >= HI and f.reads_secrets >= HI, "review",
         "Fetches from the network and may touch credentials."),
    ]

    tier, reason = "allow", "Nothing in this command looks destructive."
    for hit, t, why in rules:
        if hit and rank(t) > rank(tier):
            tier, reason = t, why
    return tier, reason


def facts_from_answers(answers: Dict) -> Facts:
    return Facts(
        **{k: float(answers[k]["noul"]) for k in NOUL_FIELDS},
        scope=answers["scope"]["choice"],
        scope_probabilities=answers["scope"]["probabilities"],
    )
