"""Syntactic facts, extracted deterministically.

Measured, not assumed: Laya answered "does this act recursively on a whole
directory tree?" with 0.66 for `rm -rf ~/Documents` and 0.89 for `ls -la` --
worse than useless, and anti-correlated with the truth. `needs_root` barely
discriminated either (0.10-0.24 across commands with and without sudo).

Both are *syntax*. A flag is either present or it is not; there is nothing to
infer. So they are read off the string here, exactly, and the model is left to
do the part it is actually good at -- what the command means.

That division is the whole design: regex for form, Laya for meaning, policy for
what to do about it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# A short-option cluster containing r/R (`-rf`, `-Rv`), or the long form.
_RECURSIVE = re.compile(r"(?<![\w-])-[a-zA-Z]*[rR][a-zA-Z]*(?![\w-])|--recursive\b")
_ROOT = re.compile(r"\b(sudo|doas|pkexec|su)\b")
_FORCE = re.compile(r"(?<![\w-])-[a-zA-Z]*f[a-zA-Z]*(?![\w-])|--force\b")
# `>` but not `>>`, and not `2>` style fd-dups into a file we don't care about.
_TRUNCATING_REDIRECT = re.compile(r"(?<![>&\d])>(?!>)")
_GLOB_WIDE = re.compile(r"(?<![\w.])(/\*|~/\*|\*)(?=\s|$)")
# `curl ... | sh` vs `curl ... | jq` is a syntactic distinction, and Laya's
# fetch_exec fires on both. Nine of the corpus's false prompts came from that.
_PIPE_TO_SHELL = re.compile(r"\|\s*(sudo\s+|env\s+\S+=\S+\s+)*(ba|z|k|da|a)?sh\b|\|\s*(sudo\s+)?(python3?|perl|ruby|node)\b")
# Absolute paths outside the project. The model's `scope` put `node_modules` in
# "home"; the string says otherwise, so trust the string.
_ABS_PATH = re.compile(r"(?<![\w=])(~/|/(?!dev/null\b)[A-Za-z][\w.\-/]*)")
_SYSTEM_PATH = re.compile(r"(?<![\w=])/(etc|boot|usr|bin|sbin|lib|lib64|var|opt|srv|sys|proc|root)(/|\s|$)")


@dataclass
class Syntax:
    recursive: bool
    needs_root: bool
    force: bool
    truncating_redirect: bool
    wide_glob: bool
    pipes_to_shell: bool
    touches_system_path: bool
    touches_absolute_path: bool

    def as_dict(self) -> dict:
        return {
            "recursive": self.recursive,
            "needs_root": self.needs_root,
            "force": self.force,
            "truncating_redirect": self.truncating_redirect,
            "wide_glob": self.wide_glob,
            "pipes_to_shell": self.pipes_to_shell,
            "touches_system_path": self.touches_system_path,
            "touches_absolute_path": self.touches_absolute_path,
        }


def parse(command: str) -> Syntax:
    return Syntax(
        recursive=bool(_RECURSIVE.search(command)),
        needs_root=bool(_ROOT.search(command)),
        force=bool(_FORCE.search(command)),
        truncating_redirect=bool(_TRUNCATING_REDIRECT.search(command)),
        wide_glob=bool(_GLOB_WIDE.search(command)),
        pipes_to_shell=bool(_PIPE_TO_SHELL.search(command)),
        touches_system_path=bool(_SYSTEM_PATH.search(command)),
        touches_absolute_path=bool(_ABS_PATH.search(command)),
    )
