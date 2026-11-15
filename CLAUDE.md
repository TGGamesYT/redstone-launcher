# Working on this repository

## The version is not mine to change

`package.json`'s `version` is set by the repository's owner and by nobody else.
Never bump it, never "tidy" it, and never include it in a change — not as part
of a release commit, not to match a changelog, not for any other reason. If a
change seems to need a version bump, say so and leave the number alone.

## Commits

Every commit message ends with the attribution lines the session gives for
commits (a `Co-Authored-By:` line naming the model that wrote it, and the
`Claude-Session:` link), exactly as given. Don't copy them from an older
commit: the model and the session change.

No model identifier appears in a commit message, a PR title or body, a code
comment, or anything else pushed to the repository. That belongs in chat only.

## Branch

All work goes to `main`, pushed with `git push origin HEAD:main`. Never create
or push a `claude/...` branch.

## TODO.md

Kept per batch of feedback, in the order it was given. A finished item keeps
its heading and gains a short note on what was actually wrong, so nothing is
re-reported as missing and the reasoning survives.
