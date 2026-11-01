# Tests

Run them with node; no framework, no runner to learn:

```
node tests/parse-test.mjs
node tests/servers-test.mjs
```

`OFFLINE=1` skips the checks that talk to a real service.

They live here rather than in a scratch folder because a scratch folder is
not backed up: a machine being rebuilt took a whole round's worth of them
with it, and the point of a test is to still be there next time.

Each check says what it is checking in a sentence, and prints what it got
whether it passed or not — so a run reads as a description of how the thing
behaves, not only as a list of what broke.

Current files:

- `parse-test.mjs` — every backend module and every page's script actually
  parses, and nothing at the top level is used before it is declared.
- `servers-test.mjs` — where a server's jar comes from, and what a generated
  pack says about itself.
- `app-icon-test.mjs` — the icon built from its layers, and the cog surviving
  every theme untouched.
- `background-test.mjs` — the launcher's background, including whether the
  wall really travels with the page.
- `loaders-test.mjs` — which loader builds exist for a Minecraft version.
- `newinstance-test.mjs` — the new-instance and new-server flows, the blur
  that belongs to them, and one step replacing another.
- `packtools-test.mjs` — the totem generator and the Vanilla Tweaks picker.
