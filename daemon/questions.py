"""The layer-1 question set.

Every question is a plain, observable fact about the command. None of them ask
"is this dangerous?" and none carry a definition of danger.

That is deliberate and measured. Asking Laya "is this a crisp?" while supplying
the rule *a crisp is a potato-based snack* scored 50% -- chance -- across ten
snacks. Asking the plain factual question, "does this contain potato?", scored
100% on identical data. A definition placed in the instruction behaves as a
topic cue, not a specification.

So the model reports facts and `policy.py` decides what they mean. If you want
to change what counts as dangerous, edit the policy table, not these strings.

Two questions were removed after measurement rather than guessed at. Laya scored
"does this act recursively on a whole directory tree?" at 0.66 for
`rm -rf ~/Documents` and 0.89 for `ls -la` -- anti-correlated with the truth --
and "does this need root privileges?" sat between 0.10 and 0.24 regardless of
whether `sudo` was present. Both are syntax, not meaning, so `syntax.py` reads
them off the string exactly. What is left here is what a model is actually
needed for.
"""

QUESTIONS = {
    "deletes": {
        "type": "noul",
        "instructions": "Does this shell command delete or remove files or directories?",
    },
    "overwrites": {
        "type": "noul",
        "instructions": "Does this shell command overwrite, truncate or format an existing file, disk or partition?",
    },
    "fetch_exec": {
        "type": "noul",
        "instructions": "Does this shell command download something from the internet and run it?",
    },
    "system_config": {
        "type": "noul",
        "instructions": "Does this shell command change system configuration or installed packages?",
    },
    "sends_data": {
        "type": "noul",
        "instructions": "Does this shell command send data to a remote server?",
    },
    "reads_secrets": {
        "type": "noul",
        "instructions": "Does this shell command read private keys, passwords or credentials?",
    },
    # Single, common, well-separated words. Longer, more "precise" option keys
    # measured worse: renaming options dropped a 4-way task from 88% to 75%,
    # because the label word carries more signal than its description.
    "scope": {
        "type": "choice",
        "instructions": "What does this command touch?",
        "criteria": {
            "nothing": "reads or prints only, changes nothing",
            "file": "a single named file",
            "project": "files inside the current project directory",
            "home": "the user's home directory and personal files",
            "system": "system directories, devices or installed software",
        },
    },
}

NOUL_KEYS = [k for k, v in QUESTIONS.items() if v["type"] == "noul"]
