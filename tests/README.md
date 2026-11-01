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
