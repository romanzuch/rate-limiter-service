# `Retry-After` is derived from `resetAt`, not `remaining`

*Decision record — 2026-08-30. Prompted by code-review finding #2 on `feat/initial-implementation` (`docs/code-review/feat-initial-implementation.md`).*

## Context

`POST /check` must set a `Retry-After` header on a `429` (design spec, API
surface table; implementation plan, the `/check` route step). `Retry-After` in
its delta-seconds form is *how many seconds the client should wait* before
retrying.

`CheckResult` carries two numbers that are easy to confuse:

| field | meaning | typical value on a 429 |
|-------|---------|------------------------|
| `remaining` | requests / tokens left in the window | `0` |
| `resetAt`   | epoch-ms timestamp when the window next admits a request | `Date.now() + windowMs` |

The first implementation fed the wrong one into the header:

```ts
reply.header("Retry-After", Math.max(0, Math.ceil((result.remaining - Date.now()) / 1000)));
```

With `remaining` at `0` and `Date.now()` around `1.75e12`, this is
`Math.ceil(-1.75e9)` clamped by `Math.max(0, …)` to **`0` on every 429**. Every
rate-limited client is told to retry immediately — a retry storm, which is the
exact failure the limiter exists to prevent.

`src/routes/check.test.ts` did not catch it: the "returns 429 with Retry-After
when denied" case asserts only `toBeDefined()`, and `"0"` is defined.

The implementation plan already showed the correct expression using
`result.resetAt`; this was a transcription slip, not a design gap.

## Decision

Source the header from `result.resetAt`:

```ts
reply.header("Retry-After", Math.max(0, Math.ceil((result.resetAt - Date.now()) / 1000)));
```

The arithmetic around it was already right and is kept:

- **Same clock, same epoch.** `resetAt` is produced by the strategies as
  `clock() + …`, and `Clock` defaults to `systemClock = () => Date.now()`, so
  `resetAt - Date.now()` is a well-defined millisecond gap.
- **`/1000`** converts that gap to seconds — the unit `Retry-After` delta-seconds
  expects.
- **`Math.ceil`** rounds the wait *up*, so a client never retries before the
  window has actually reset.
- **`Math.max(0, …)`** floors a just-passed `resetAt` at `0` rather than emitting
  a negative header.

Header-only change. Public behavior otherwise unchanged; no other route, test, or
type is touched.

## Alternatives considered and rejected

| Option | Why not |
|--------|---------|
| Emit `Retry-After` as an HTTP-date instead of delta-seconds | Both forms are RFC-legal, but the spec, the plan, and the `200` response all speak in the `resetAt` epoch/seconds vocabulary already. A date form adds a formatting step and a second time representation for no consumer benefit. |
| Also convert the `429` body's `retryAfter` to seconds so it matches the header | Out of scope — finding #2 is about the header. The body field carrying the raw `resetAt` timestamp is what the plan shows and what finding #5 assumes. Left as-is; see below. |
| Extract a `retryAfterSeconds(resetAt, now)` helper | One call site. Per the repo scope rule ("three similar lines beat a premature abstraction"), the inline expression stays. Revisit if a second caller appears. |
| Thread the injected `Clock` into the route so it stops calling `Date.now()` directly (also line 35) | A real improvement — one time source, deterministic tests — but it changes `CheckRouteDeps` and every route-wiring/test site. The plan's own route code calls `Date.now()` here. Separate change, not this fix. |

## Test gap (follow-up, not done here)

The fix currently ships with **no test that would have failed on the bug**. The
existing 429 case asserts only that the header exists.

Recommended next red-green cycle, in `src/routes/check.test.ts`:

- Freeze time (`vi.useFakeTimers()` + `vi.setSystemTime(FIXED)`).
- Mock `check` → `{ allowed: false, remaining: 0, resetAt: FIXED + 5000, limit: 5 }`.
- Assert `response.headers["retry-after"] === "5"` (write it red against the old
  code if reconstructing the cycle, then green).
- Decide whether the old `toBeDefined()` assertion is now redundant.

Until that lands, a regression on this line is invisible.

## Other things to know later

- **Finding #3 is still open.** `X-ReateLimit-Reset` (typo, `src/routes/check.ts`
  line 39) sits directly above the edited line and was deliberately left
  untouched — it is a separate finding with its own cycle.
- **Finding #5 feeds this header.** When a token-bucket policy has
  `refillRatePerMs: 0`, the strategy returns `resetAt = currentTime`, so
  `Retry-After` computes to `0` again — correct arithmetic, misleading input.
  Fixing finding #5 restores this header's honesty in that case.
- **Header vs. body unit mismatch is intentional for now.** `Retry-After`
  (header) is delta-seconds; `retryAfter` (429 body) is an epoch-ms timestamp.
  The plan specifies the body form; revisit only if a consumer needs them
  aligned.

## References

- Code review: `docs/code-review/feat-initial-implementation.md` (finding #2)
- Design spec: `docs/superpowers/specs/2026-08-25-rate-limiter-backend-design.md`
  (API surface — `Retry-After` on `429`)
- Implementation plan: `docs/superpowers/plans/2026-08-25-rate-limiter-backend.md`
  (the `/check` route step — the correct `result.resetAt` expression)
- Implementation: `src/routes/check.ts`, `src/routes/check.test.ts`
- Commit: _pending_ — *fix: source Retry-After from resetAt, not remaining*
