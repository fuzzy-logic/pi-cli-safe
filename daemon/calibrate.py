#!/usr/bin/env python3
"""Measure the L0+L1 stack against data/seed_commands.py.

The headline number is the **false-prompt rate on safe commands**. A guard that
interrupts routine work gets switched off within a week, so that figure decides
whether this is shippable, not the raw accuracy.

L2 and L3 are deliberately not simulated: everything L1 marks "review" would go
to the local reviewer, and what matters here is how much reaches that far.
"""

from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "daemon"))
sys.path.insert(0, str(ROOT / "data"))

import policy  # noqa: E402
import syntax as syn  # noqa: E402
from questions import QUESTIONS  # noqa: E402
from seed_commands import rows  # noqa: E402

PROFILES = ["base", "archlinux", "luks", "infra"]


def load_rules():
    out = []
    for name in PROFILES:
        d = json.loads((ROOT / "profiles" / f"{name}.json").read_text())
        for r in d["rules"]:
            out.append((r["id"], re.compile(r["pattern"], re.I), r["severity"]))
    return out


RULES = load_rules()


def layer0(command: str):
    tier, rid = "allow", None
    for r_id, rx, sev in RULES:
        if rx.search(command) and policy.rank(sev) > policy.rank(tier):
            tier, rid = sev, r_id
    return tier, rid


def main() -> int:
    import laya

    agent = laya.load("convaiinnovations/laya")
    data = list(rows())
    print(f"{len(data)} commands; profiles={','.join(PROFILES)}\n")

    results = []
    t0 = time.perf_counter()
    for i, row in enumerate(data, 1):
        cmd = row["command"]
        l0_tier, rule_id = layer0(cmd)
        if l0_tier in ("block", "danger"):
            tier, by = l0_tier, f"l0:{rule_id}"
        else:
            res = agent.predict(cmd, QUESTIONS)
            f = policy.facts_from_answers(res["answers"])
            t, _why = policy.decide(f, syn.parse(cmd))
            tier, by = policy.escalate(l0_tier, t), "l1"
        results.append({**row, "tier": tier, "by": by})
        if i % 30 == 0:
            print(f"  ...{i}/{len(data)}", flush=True)

    elapsed = time.perf_counter() - t0
    print(f"\nscored in {elapsed:.0f}s ({elapsed / len(data) * 1000:.0f} ms/command)\n")

    safe = [r for r in results if r["expected"] == "allow"]
    danger = [r for r in results if r["expected"] == "prompt"]

    # "reaches the user" = danger or block. "review" goes to L2 first.
    def prompts(r):
        return r["tier"] in ("danger", "block")

    fp = [r for r in safe if prompts(r)]
    to_l2 = [r for r in safe if r["tier"] == "review"]
    fn = [r for r in danger if r["tier"] == "allow"]
    caught_l0 = [r for r in danger if r["by"].startswith("l0")]

    print("=" * 72)
    print(f"SAFE commands ({len(safe)})")
    print(f"  allowed silently      {len(safe) - len(fp) - len(to_l2):>4}  "
          f"{(len(safe) - len(fp) - len(to_l2)) / len(safe):.1%}")
    print(f"  sent to L2 reviewer   {len(to_l2):>4}  {len(to_l2) / len(safe):.1%}   (costs ~1-3s, no prompt)")
    print(f"  FALSE PROMPTS         {len(fp):>4}  {len(fp) / len(safe):.1%}   <- the number that matters")
    print()
    print(f"DANGEROUS commands ({len(danger)})")
    print(f"  caught at L0 (rules)  {len(caught_l0):>4}  {len(caught_l0) / len(danger):.1%}")
    print(f"  reach the user        {len(danger) - len(fn):>4}  {(len(danger) - len(fn)) / len(danger):.1%}")
    print(f"  MISSED (allowed)      {len(fn):>4}  {len(fn) / len(danger):.1%}")
    print("=" * 72)

    if fp:
        print(f"\nFalse prompts ({len(fp)}):")
        for r in fp:
            print(f"  {r['tier']:<7} {r['by']:<24} {r['command']}")
    if fn:
        print(f"\nMissed dangerous commands ({len(fn)}):")
        for r in fn:
            print(f"  {r['command']}\n      ({r['note']})")

    out = ROOT / "data" / "calibration.json"
    out.write_text(json.dumps({
        "n": len(data),
        "false_prompt_rate": round(len(fp) / len(safe), 4),
        "miss_rate": round(len(fn) / len(danger), 4),
        "l2_load": round(len(to_l2) / len(safe), 4),
        "ms_per_command": round(elapsed / len(data) * 1000, 1),
        "results": results,
    }, indent=1) + "\n")
    print(f"\nwrote {out.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
