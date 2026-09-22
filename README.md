# pi-cli-safe

A graded safety cascade for the [Pi coding agent](https://github.com/badlogic/pi-mono).

Most command guards are a single boolean: a command either trips a regex or it
runs unexamined. This one runs four layers, cheapest first, and only interrupts
you when nothing cheaper could decide.

Layers 0 and 1 run **locally and free**, which is the property that makes it
work: there is no budget pressure to leave commands unexamined, so every command
gets looked at — not just the ones a pattern happened to catch. Layer 2 only
sees the commands those two could not settle.

```
bash · write · edit
   │
 L0  deterministic rules                              ~1 ms
     pi-prevent-destructive-commands + 42 profile rules
     └─ hit → block
   │
 L1  Laya — a 421M decision model                   ~285 ms   local · free
     ├─ clearly safe      → allow
     ├─ clearly dangerous → ask you
     └─ uncertain         → L2
   │
 L2  the model Pi is already running                 ~1–3 s
     ├─ safe      → allow
     └─ dangerous → ask you
   │
 L3  you                                    and your answer is remembered
```

## Measured

Against `data/seed_commands.py` — 111 ordinary development commands and 70
genuinely destructive ones — using layers 0 and 1 only:

| | |
|---|---|
| Safe commands allowed silently | **85.6%** |
| Safe commands sent to L2, the session model (no prompt, ~1–3 s) | 14.4% |
| **Safe commands that falsely interrupt you** | **0.0%** |
| Dangerous commands that reach you | **100%** |
| Dangerous caught at L0, before any model | 87.1% |
| Median latency | 285 ms/command |

The false-prompt rate is the number that matters. A guard that nags on
`rm -rf node_modules` gets switched off in week one.

**Read that table honestly:** the thresholds were tuned against this corpus, so
these are fit figures, not a held-out generalisation estimate. Treat them as
evidence the design is sound, not as a guarantee about your commands. Re-run
`daemon/calibrate.py` after adding your own cases.

## The design rule that shaped everything

Laya is asked **only for meaning** — never for syntax, and never for policy.

That came out of measurement. The first version of the question set asked it
things that sound reasonable and score terribly:

| question | `rm -rf ~/Documents` | `ls -la` |
|---|---|---|
| *"Does this act recursively on a whole directory tree?"* | **0.66** | **0.89** |

Anti-correlated. *"Does this need root privileges?"* was no better — 0.10 to
0.24 whether or not `sudo` was present.

Both of those are **syntax**. A flag is either in the string or it is not;
there is nothing to infer. So `daemon/syntax.py` reads them off the string
exactly, and the model is left to do the part it is genuinely good at. The same
fix applied to `curl | jq` versus `curl | sh` — Laya's `fetch_exec` fires on
both, but only one executes anything — and gating on that removed **every
remaining false prompt**, 8.1% to 0%.

A third rule fell out of the same exercise: passing extra context into the model
state hurts. Including the working directory shifted verdicts for identical
commands and put a false `reads_secrets` of 0.83 on `rm -rf ~/Documents`.
Removing it took that to 0.00 and cut latency from ~600 ms to ~285 ms. The model
sees the command and nothing else; the working directory is policy context, and
policy is not the model's job.

So: **regex for form, Laya for meaning, a policy table for what to do about
it.** If you want to change what counts as dangerous, edit `daemon/policy.py` —
not the question strings. Putting your definition of "dangerous" into an
instruction does not work; the model treats it as a topic cue rather than a
specification, and answers the question it thinks you meant.

## Layer 2 is the model you are already using

There is nothing to run and nothing to choose. Pi is connected to a model, so
when Laya cannot settle a command, layer 2 asks that one — through Pi's own
model registry, with a short fixed safety prompt and reasoning turned off.
No second server, no model download, no extra GPU memory.

```json
{ "llmBackend": "session", "sessionReviewBudget": 40 }
```

The budget caps reviews per session, because on a paid cloud model each one
spends tokens. Past the cap layer 2 abstains and the cascade asks you instead.
`"llmBackend": "off"` skips the layer entirely.

Two things this trades away, stated plainly. **Cost**, if your session model is
billed. **Judgement**: when this was measured, larger models were *more*
permissive safety reviewers than small ones, so layer 2 is only as careful as
the model you are coding with. The design limits what that can cost you: layer
2 can only clear a command Laya was genuinely unsure about. It cannot soften a
layer-0 rule, and it never gets the last word on anything Laya or a rule called
dangerous — that goes to you.

A model that thinks first spends its whole token budget on reasoning and
returns no verdict, so the request asks for reasoning off and takes the last
JSON object in the reply either way.

## Install

The guard is useful with nothing but Pi:

```bash
pi install pi-cli-safe
pi install @giuseppe.trisciuoglio/pi-prevent-destructive-commands   # layer 0
```

That gives you L0, L2 and L3: layer 2 needs nothing beyond the model Pi is
already talking to. Layer 1 is optional and degrades independently: a dead
daemon skips its layer, it never blocks your agent.

To add layer 1 (Laya):

```bash
pip install laya                       # ~1.7 GB checkpoint on first run
cp systemd/pi-cli-safe-laya.service ~/.config/systemd/user/
systemctl --user edit pi-cli-safe-laya   # set PI_CLI_SAFE_PYTHON and PI_CLI_SAFE_DIR
systemctl --user enable --now pi-cli-safe-laya
```

Use `systemctl --user edit` for the paths rather than editing the unit in
place, so an update to this repo does not clobber your local values.

## Profiles

Rules are grouped so you only load what applies to you.

| profile | rules | what it covers |
|---|---|---|
| `base` | 13 | block devices, `mkfs`, `dd`, fork bombs, `curl \| sh`, root deletes |
| `infra` | 13 | firewall, network, power, k8s, cloud, databases, destructive git |
| `archlinux` | 11 | `mkinitcpio`, `sbctl`, bootloader, `/boot`, sudoers, pacman |
| `luks` | 5 | `cryptsetup luksFormat`/`luksErase`, crypttab |

```json
{ "profiles": ["base", "infra", "archlinux", "luks"] }
```

in `~/.config/pi-cli-safe/config.json` or `.pi/pi-cli-safe.json`.

`archlinux` and `luks` exist because the existing guards all assume the thing
worth protecting is a *project*. On a machine with an encrypted root and a
signed UKI, a bad `mkinitcpio` does not cost you a file — it costs you a
bootable laptop.

## Learning

Laya's weights are frozen and nothing here retrains them. What happens instead:

1. **Exemplars, immediate.** Every command you or the session model calls dangerous
   is stored and embedded using the encoder that is *already loaded*
   (`laya.embed_fn_from_agent` — no second model, no extra memory). New commands
   are compared against them and something merely *similar* to what you flagged
   inherits the caution on the very next call. Three details make that safe to
   rely on, each measured rather than assumed:
   - **Centred, not raw, cosine.** Mean-pooled embeddings of shell commands are
     anisotropic: unrelated commands sit at a median cosine of 0.85, and `df -h`
     scored 0.95 against an exfiltration exemplar. Subtracting the seed-corpus
     mean pulls unrelated pairs to ~0 while paraphrases stay at 0.5–0.8.
   - **Same head required.** The new command must start with the same program
     (`rm`, `git push`, …) as the exemplar. The encoder cannot tell `| sh` from
     `| jq`, but it never needs to compare `tar` with `mv` either.
   - **Graded raise.** A close match (≥ 0.75) inherits *danger*; a looser one
     (≥ 0.55) is only raised to *review*, so the LLM layer gets a look before
     anyone is interrupted. Against a realistic eight-exemplar store this cut
     false hits on the 111 safe seed commands from 35 to 3.
2. **Recalibration, periodic.** Accumulated labels re-fit the layer-1
   thresholds via `daemon/calibrate.py`.
3. **Fine-tuning, manual.** Laya ships a fine-tuning notebook. `/safe export`
   writes the store in its format for when there is enough signal to justify it.

**Raise-only.** A *dangerous* verdict applies at once. A *safe* verdict is
recorded but never consulted until you approve it. The costs are asymmetric — a
wrong block costs one prompt, a wrong allow can cost the machine — so the
learning is asymmetric too. One careless "allow" can never teach the guard to
permit something destructive.

Your store lives in `~/.local/state/pi-cli-safe/`, is gitignored, and is never
published. The repo ships only the synthetic seed corpus.

## Non-interactive sessions

Under `pi -p` there is no one to ask, so layer 3 cannot run. The default is to
block with a reason, matching Pi's own `permission-gate.ts`. Set
`"nonInteractive": "allow"` if you would rather it ran.

## What this is not

**A safety net against accidents, not a security boundary.**

Every layer reads a *string*. None of them resolve `$VAR`, decode base64, follow
an alias, or know what a script contains. `rm -rf /` is caught;
`eval "$(printf '\x72\x6d...')"` is not. An agent that has been prompt-injected
can phrase things to look benign and the cascade will agree.

The load-bearing protection is still a git-backed workspace you can restore
from, OS-level permissions, and a throwaway VM for anything irreplaceable. This
raises the floor. It does not build a wall.

## Development

```bash
npm test                              # rules, cascade, session reviewer, raise-only invariant
npm run typecheck
python daemon/server.py --selftest    # scores a fixed set against the real model
python daemon/calibrate.py            # false-prompt and miss rates
```

[fuzzy-logic/pi-cli-safe](https://github.com/fuzzy-logic/pi-cli-safe) · MIT. Built on [Laya](https://github.com/NandhaKishorM/laya) (Apache-2.0).

## Debugging

`PI_CLI_SAFE_DEBUG=1 pi …` traces every guarded tool call to stderr: the
candidate, which layer decided, each layer's tier and source, and the total
time. `source: unavailable` on layer 1 means the Laya daemon did not answer
within `layaTimeoutMs`; on layer 2 it means the session model gave no verdict
within `llmTimeoutMs`, the session budget is spent, or no model is connected.
