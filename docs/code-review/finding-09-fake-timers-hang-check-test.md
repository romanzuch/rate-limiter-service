# Implementation plan — Finding #9: `vi.useFakeTimers()` hangs the 429 retry-after test

*Found while verifying finding #8's implementation (`docs/code-review/finding-08-resetat-headroom-and-retryafter-units.md`), not from a fresh `/code-review` pass. `npm test -- check` was run to confirm finding #8 landed correctly; the rewritten 429 test times out, and — because the timeout fires before the test's own `vi.useRealTimers()` line runs — every test after it in the file times out too.*

## Files changed

| File | Change |
|---|---|
| `src/routes/check.test.ts` | modified — the 429 test now fakes only `Date`, not timers, so `app.inject()` can resolve |

## Context

The finding #8 plan's Cycle 2 test does this:

```ts
it("returns 429 with Retry-After header and body in seconds when denied", async () => {
    const FIXED = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(FIXED);
    // ...
    const response = await app.inject({ ... });
    vi.useRealTimers();
    // ...assertions...
});
```

Confirmed by running it in isolation (`npx vitest run src/routes/check.test.ts -t "returns 429..."`): it times out at 5000ms, every time, on its own — not an ordering artifact.

**Root cause:** `vi.useFakeTimers()` with no options fakes Vitest's full default set, which includes `setImmediate`/`setTimeout`/`clearImmediate` alongside `Date`. Fastify's `app.inject()` (via `light-my-request`) drives its mocked request/response cycle through real Node timer callbacks to flush data through the stream. With those callbacks faked and never manually advanced, the promise `app.inject()` returns never settles — the `await` hangs until Vitest's test timeout kills it.

Because the test times out *inside* the `it` block, execution never reaches the `vi.useRealTimers()` line below the `await`. Fake timers stay installed globally, so every subsequent test in the file — including ones that don't use timers at all, like `"returns 400 when key or policy is missing"` — inherits the same hang. This is why the full-file run showed 6 of 7 tests failing, not just the one test that actually has the bug.

Only `Date.now()` needs to be frozen here — the test doesn't advance time or assert on scheduled callbacks. Faking the rest of the timer surface is accidental scope, not something the test needs.

## Design & trade-offs

### Fix: narrow `vi.useFakeTimers()` to `Date` only

```ts
vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(FIXED);
```

`toFake: ["Date"]` keeps `Date.now()`/`new Date()` mocked (all this test needs — `check.ts` computes `retryAfter` from `resetAt - Date.now()`) while leaving `setImmediate`/`setTimeout` untouched, so `app.inject()`'s internal plumbing runs on real timers and the promise resolves normally.

**Alternative considered and rejected: `vi.spyOn(Date, "now").mockReturnValue(FIXED)` instead of `useFakeTimers`/`setSystemTime`.** Also fixes the hang — it never touches the timer subsystem at all. Rejected in favor of `toFake: ["Date"]` because it's a smaller diff (two existing lines keep their shape) and keeps `vi.setSystemTime`, which mocks `new Date()` too, not just `Date.now()` — more robust if `check.ts` or a future test starts constructing `Date` objects directly instead of calling `.now()`.

**Alternative considered and rejected: keep full `useFakeTimers()` and manually flush with `await vi.advanceTimersByTimeAsync(0)` (or `runAllTimersAsync()`) before awaiting `inject()`.** Works, but it's fragile — it depends on knowing how many ticks `light-my-request` needs internally, which is an implementation detail of a dependency, not something this test should encode. Narrowing what's faked avoids the question entirely.

**Out of scope:** the `vi.useRealTimers()` placement relative to `await app.inject(...)` — moving it into a `try/finally` would make cleanup safer against *future* hangs of any kind, but that's a general test-hygiene improvement orthogonal to this specific bug, and this repo has no other fake-timer test to justify the pattern yet.

## Full code

### `src/routes/check.test.ts`

Only the two lines at the top of the 429 test change:

```ts
    it("returns 429 with Retry-After header and body in seconds when denied", async () => {
        const FIXED = 1_700_000_000_000;
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(FIXED);

        const rateLimiter = {
            check: vi.fn().mockReturnValue({ allowed: false, remaining: 0, resetAt: FIXED + 5000, limit: 5 }),
        } as unknown as RateLimiter;
        const { app } = buildTestApp(rateLimiter);

        const response = await app.inject({
            method: "POST",
            url: "/check",
            payload: { key: "user-1", policy: "strict" }
        });

        vi.useRealTimers();

        expect(response.statusCode).toBe(429);
        expect(response.headers["retry-after"]).toBe("5");
        expect(JSON.parse(response.body)).toEqual({ allowed: false, retryAfter: 5 });
    });
```

**Change vs. current:** line 36 only — `vi.useFakeTimers()` → `vi.useFakeTimers({ toFake: ["Date"] })`. Everything else in the test, and every other test in the file, is untouched.

## TDD sequence

This isn't a new-behavior cycle — the assertions already exist and are already correct per finding #8; the test harness itself is what's broken. The cycle here is RED-is-already-observed → GREEN, no new test to write.

### Cycle 1 — fake-timers hang

**Command:** `npx vitest run src/routes/check.test.ts -t "returns 429 with Retry-After header and body in seconds when denied"`

**RED (already confirmed):**
```
FAIL src/routes/check.test.ts > POST /check > returns 429 with Retry-After header and body in seconds when denied
Error: Test timed out in 5000ms.
```
This happens because `vi.useFakeTimers()` fakes `setImmediate`, which `app.inject()` depends on internally; the awaited promise never resolves.

**GREEN:** apply the one-line change above.

Re-run the same command → passes in well under 5000ms, with the header and body assertions actually exercised (not skipped-by-timeout).

### After the fix

- `npx vitest run src/routes/check.test.ts` (whole file, no `-t` filter) — all 7 tests green. This confirms the cascade (finding #9's actual symptom) is gone, not just the one test.
- `npm test` — full suite green.
- `npm run typecheck` — unaffected; no type changes here.

## Commit plan

1. `fix: fake only Date in the 429 retry-after test so app.inject can resolve` — the one-line `check.test.ts` change (Cycle 1).
