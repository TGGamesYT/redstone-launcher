#!/usr/bin/env bash
# Every suite, one line each. OFFLINE=1 skips the ones that need a service.
cd "$(dirname "$0")/.." || exit 1
fail=0
for t in tests/*-test.mjs; do
  name=$(basename "$t" -test.mjs)
  out=$(node "$t" 2>&1)
  if [ $? -eq 0 ]; then
    printf '%-14s pass\n' "$name"
  else
    printf '%-14s FAIL\n' "$name"
    echo "$out" | grep -E '^(FAIL|       )' | head -20
    fail=$((fail + 1))
  fi
done
[ "$fail" -eq 0 ] && echo "all suites pass" || echo "$fail suite(s) failing"
exit $fail
