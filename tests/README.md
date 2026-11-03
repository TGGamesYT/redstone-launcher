# Tests

Run them with node; no framework, no runner to learn:

```
tests/run-all.sh          # every suite, one line each
node tests/parse-test.mjs # or just the one
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
- `runs-test.mjs` — two copies of one instance keeping their own consoles.
- `download-test.mjs` — a download being all of it or none of it, against a
  server that drops the connection halfway.
- `content-test.mjs` — installing from a file, and which folder of jars a
  server keeps.
- `home-layout-test.mjs` — the home page's rows, and moving and resizing
  what is on them.
- `entity-parts-test.mjs` — which parts of a mob the launcher hides while
  it stands still, checked against a real client jar.

## pages-baseline.mjs

Not part of `run-all.sh`, deliberately: it is a before-and-after tool, not a
regression suite, and it fails on every intentional change to a page until the
baselines are saved again.

It exists for folding the launcher into a single page. The requirement on that
work is that every page comes out exactly as it was, so all fifteen are
photographed first and compared afterwards:

```sh
node tests/pages-baseline.mjs --save        # on the tree as it is now
node tests/pages-baseline.mjs               # after changing something
node tests/pages-baseline.mjs --only=settings
```

Each page gets a screenshot and a fingerprint -- the box of every element with
an id, plus the computed properties a refactor like this could disturb. The
fingerprint is what catches things: a screenshot says something moved, the
fingerprint says `body paddingLeft: was 20px, now 1px`.

Everything that would differ between runs is frozen: the clock, the random
greeting, and every answer the main process would give. A page that throws is
recorded too, because the ones that throw under these stubs have to throw the
same way afterwards.
