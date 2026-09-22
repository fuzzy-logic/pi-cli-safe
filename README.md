# pi-cli-safe

A graded safety cascade for the [Pi coding agent](https://github.com/badlogic/pi-mono).

Most command guards are a single boolean: a command either trips a regex or it
runs unexamined. This one runs four layers, cheapest first, and only interrupts
you when nothing cheaper could decide.

Every layer runs **locally and free**, which is the property that makes it work.
There is no budget pressure to leave commands unexamined, so every command gets
looked at — not just the ones a pattern happened to catch.

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
 L2  local LLM reviewer                              ~1–3 s   local · free
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
| Safe commands sent to L2 (no prompt, ~1–3 s) | 14.4% |
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

## Choosing the reviewer

**By default there is nothing to choose.** Pi is already connected to a model,
so when Laya cannot settle a command, layer 2 asks that one. No second server,
no model download, no GPU memory, no configuration:

```json
{ "llmBackend": "session", "sessionReviewBudget": 40 }
```

The budget caps reviews per session, because on a paid cloud model each one
spends tokens. Past the cap layer 2 abstains and the cascade asks you instead.

Two reasons to run a dedicated reviewer instead (`"llmBackend": "endpoint"`):
**cost**, if your session model is billed; and **control**, because bigger
models measured as *more permissive* reviewers, so the session model may be a
worse judge than a small one chosen for the job.

### Dedicated reviewer (optional)

You name **endpoints**, not models. The plugin works out which of them is
serving the best reviewer.

```json
{
  "llmEndpoints": [
    { "url": "http://127.0.0.1:8130/v1", "runtime": "npu" },
    { "url": "http://127.0.0.1:8127/v1", "runtime": "gpu" }
  ],
  "llmSelection": "best",
  "allowCpuReviewer": false
}
```

Order is preference, which is how NPU-before-GPU is expressed. `"best"` ranks by
measured false-safe rate; `"first"` takes the first healthy endpoint; `"pinned"`
skips discovery. An endpoint declared `cpu` is skipped unless you allow it, and
one that answers implausibly slowly is treated as CPU-bound and rejected.

Known models are scored from `data/reviewer-scorecard.json`. Unknown ones are
probed with 12 commands, and the result is cached for a week keyed by endpoint
plus GGUF path, so swapping the model behind a port re-probes automatically.

**Ranking is by false-safe rate, never by size**, because size is actively
misleading here:

| model | size | runtime | accuracy | false-safe | false alarms | median |
|---|---|---|---|---|---|---|
| **Qwen3-4B-Instruct-2507** | 2.4G | GPU | **97.5%** | **0/20** | 1/20 | **556 ms** |
| Qwen3-VL-4B | 3.2G | GPU | 95.0% | **0/20** | 2/20 | 499 ms |
| Ornith-1.5-9B | 7.1G | GPU | 95.0% | **0/20** | 2/20 | 1596 ms |
| GLM-4.7-Flash | 25G | GPU | 97.5% | 1/20 | 0/20 | 1114 ms |
| Qwen3.6-35B-A3B | 22G | GPU | 92.5% | **3/20** | 0/20 | 1123 ms |
| Qwen3.5-2B | 1.2G | GPU | 67.5% | 1/20 | 12/20 | 447 ms |
| Qwen3-4B-Instruct-2507 | 3.1G | **NPU** | 92.5% | 1/20 | 2/20 | 2555 ms |
| Qwen3.5-4B | 3.4G | **NPU** | 90.0% | 2/20 | 2/20 | 3198 ms |

The two largest models were the most permissive: the 22G MoE waved through
`rm -rf ~/Documents/archive` and `sudo mkinitcpio -P`. A 2.4G model beat a 25G
one, and dropping a vision tower the job never uses (VL-4B to Instruct-4B)
*improved* accuracy rather than costing it.

The NPU rows are real and work — FastFlowLM on XDNA2. The same model was run on
both: **97.5% / 0 false-safe / 556 ms on the iGPU, 92.5% / 1 false-safe /
2555 ms on the NPU.** Identical weights, so the accuracy gap is the NPU
quantisation, and it is ~4.5x slower. It is still the right choice
when you want the GPU left entirely free for a coding model, which is why
endpoint order rather than a hard rule decides it. A reviewer that fails
either of those during probing is **rejected outright rather than ranked** — no
layer 2 is better than a permissive one, because the cascade then asks you.

Reasoning is disabled for the reviewer. A model that thinks first spends its
whole budget on `reasoning_content` and returns empty `content`, so no verdict
ever arrives; the client sends `enable_thinking: false` and `reasoning_effort:
none`, and falls back to reading the verdict out of `reasoning_content` for
servers that ignore both.

## Install

The guard is useful with nothing but Pi:

```bash
pi install pi-cli-safe
pi install @giuseppe.trisciuoglio/pi-prevent-destructive-commands   # layer 0
```

That gives you L0 → L3. Every other layer is optional and each degrades
independently: a dead daemon skips its layer, it never blocks your agent.

To add layer 1 (Laya) and layer 2 (the local reviewer):

```bash
pip install laya                       # ~1.7 GB checkpoint on first run
cp systemd/*.service ~/.config/systemd/user/
systemctl --user edit pi-cli-safe-laya   # set PI_CLI_SAFE_PYTHON and PI_CLI_SAFE_DIR
systemctl --user edit pi-cli-safe-llm    # set LLAMA_SERVER and LLAMA_MODEL
systemctl --user enable --now pi-cli-safe-laya pi-cli-safe-llm
```

Use `systemctl --user edit` for the paths rather than editing the units in
place, so an update to this repo does not clobber your local values.

**If your reviewer is a reasoning model**, thinking is disabled for it. A model
that reasons first spends its whole token budget on `reasoning_content` and
returns empty `content` — the verdict never arrives. The client sends
`enable_thinking: false` and `reasoning_effort: none`, and falls back to reading
the verdict out of `reasoning_content` for servers that ignore both. The shipped
llama.cpp unit also sets it server-side. Qwen3.5-2B went from *no answer at all*
to a correct verdict in ~550 ms.

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

1. **Exemplars, immediate.** Every command you or the reviewer calls dangerous
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
npm test                              # 60 tests: rules, cascade, raise-only invariant
npm run typecheck
python daemon/server.py --selftest    # scores a fixed set against the real model
python daemon/calibrate.py            # false-prompt and miss rates
```

[fuzzy-logic/pi-cli-safe](https://github.com/fuzzy-logic/pi-cli-safe) · MIT. Built on [Laya](https://github.com/NandhaKishorM/laya) (Apache-2.0).

## Debugging

`PI_CLI_SAFE_DEBUG=1 pi …` traces every guarded tool call to stderr: the
candidate, which layer decided, each layer's tier and source, and the total
time. `source: unavailable` on layer 1 means the Laya daemon did not answer
within `layaTimeoutMs`; on layer 2 it means no reviewer was resolved.
