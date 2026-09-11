# Implementation plan — Finding #5: honest `resetAt` when a token bucket never refills

**Status:** not started
**Review finding:** `docs/code-review/feat-initial-implementation.md` #5
**Related:** finding #4 decision record (`docs/decisions/2026-08-30-policy-config-validation.md`) — established that `refillRatePerMs: 0` is a *supported* config, so this finding cannot be closed by rejecting it at validation time.

---

## Files changed

| File | Change |
|------|--------|
| `src/strategies/token-bucket.ts` | **modified** — when `refillRatePerMs` is `0`, `resetAt` becomes `Infinity` instead of `currentTime` (the bucket has no future reset) |
| `src/strategies/token-bucket.test.ts` | **modified** — 1 new case: a static (`refillRatePerMs: 0`) bucket reports `resetAt === Infinity` on both the allowed-but-empty and the denied check |
| `src/routes/check.ts` | **modified** — treat a non-finite `resetAt` as "no reset": omit `X-RateLimit-Reset` and `Retry-After`, send `resetAt` / `retryAfter` as `null` in the JSON body |
| `src/routes/check.test.ts` | **modified** — 2 new cases: non-finite `resetAt` from the limiter → reset/retry headers absent, `200` body `resetAt: null`, `429` body `retryAfter: null` |

Nothing else is touched. `sliding-window.ts` always produces a finite `resetAt` (`windowMs >= 1`), so it needs no change. `rate-limiter.ts` passes the strategy result through untouched and stays as-is. The SSE stats path does not carry `resetAt`.

---

## Context

`checkTokenBucket` computes the retry hint like this (`src/strategies/token-bucket.ts:23-24`):

```ts
const deficit = Math.max(0, 1 - tokens);
const resetAt = config.refillRatePerMs > 0 ? currentTime + deficit / config.refillRatePerMs : currentTime;
```

When `refillRatePerMs === 0` the bucket is **static** — it starts with `capacity` tokens and never gains another one. The `: currentTime` fallback then says "the limit resets right now," which is the opposite of the truth.

`refillRatePerMs: 0` is not a degenerate input to reject — finding #4's decision record keeps it explicitly supported, and `token-bucket.test.ts` already uses it in two tests as a "fixed allowance, no refill" bucket. So the strategy has to return something honest for it.

**Failure path** — policy `{ strategy: "token-bucket", capacity: 1, refillRatePerMs: 0 }`:

1. First `POST /check` for a key → allowed, `tokens` goes to `0`.
2. Second `POST /check` → denied. `deficit = 1`, `refillRatePerMs` is `0`, so `resetAt = currentTime`.
3. `/check` route (`src/routes/check.ts`):
   - `X-RateLimit-Reset: <now>`
   - `Retry-After: Math.max(0, Math.ceil((now - Date.now()) / 1000))` → `0`
   - `429 { allowed: false, retryAfter: <now> }`
4. The client is told "retry immediately." It retries, gets denied again with the same hint, and loops. The bucket will never refill — only an admin `PUT /policies/:name` can change that.

The design spec (`docs/superpowers/specs/2026-08-25-rate-limiter-backend-design.md`, HTTP API row for `/check`) lists `X-RateLimit-Reset` and `Retry-After` as response headers but does not define their value for a bucket that never resets. This plan fills that gap.

## Design & trade-offs

### Approach

**Strategy layer — say "never" with `Infinity`.** Change the fallback so a static bucket reports `resetAt = Infinity`:

```ts
const resetAt = config.refillRatePerMs > 0 ? currentTime + deficit / config.refillRatePerMs : Infinity;
```

`Infinity` is the mathematically correct answer (`deficit / 0`), it keeps `CheckResult.resetAt` typed as `number` (the spec pins it), and `Number.isFinite` is a one-call guard at the boundary. It applies to both the allowed-but-now-empty check and the denied check — any time a static bucket is at or below one token, there is no finite moment it recovers.

**Route layer — a non-finite `resetAt` means "no automatic reset."** `/check` is the only consumer of `resetAt`. It presents the "never" case by *omitting* the time-based hints rather than emitting a nonsense value:

| surface | finite `resetAt` (unchanged) | non-finite `resetAt` (new) |
|---|---|---|
| `X-RateLimit-Reset` header | `result.resetAt` | **not set** |
| `Retry-After` header (429 only) | `max(0, ceil((resetAt - now) / 1000))` | **not set** |
| `200` body `resetAt` | `result.resetAt` | `null` |
| `429` body `retryAfter` | `result.resetAt` | `null` |

A missing `X-RateLimit-Reset` / `Retry-After` is the honest signal: there is no time at which a retry starts succeeding. A client should treat it as "blocked until the policy changes," not "retry soon." `null` in the JSON body carries the same meaning explicitly (and `JSON.stringify(Infinity)` is already `null`, so the body shape is stable either way — the code is made explicit so it does not depend on that quirk).

### Alternatives considered and rejected

| Option | Why not |
|--------|---------|
| **Widen `CheckResult.resetAt` to `number \| null`** | The design spec pins `resetAt: number`. The union ripples into `sliding-window.ts`, `rate-limiter.ts`, every test that builds a `CheckResult`, and both `/check` response shapes — a large change to express something one `Number.isFinite` check at the single consumer already handles. |
| **Sentinel finite value (`Number.MAX_SAFE_INTEGER`, or `currentTime + 10 years`)** | A magic number with no meaning, and it still produces a misleading `Retry-After` — a valid integer telling the client to retry in ~104 000 days. "Absent" communicates "never" better than a huge number does. |
| **Add a `retryable: false` / `willReset: false` flag to `CheckResult`** | New field on the core result type, set by every strategy, threaded through `rate-limiter.ts` and both response bodies, for one config edge case. `Number.isFinite(resetAt)` already encodes it. |
| **Reject `refillRatePerMs: 0` in `isValidPolicyConfig`** | Directly contradicts the finding #4 decision record (static bucket is a supported mode) and breaks the two `token-bucket.test.ts` cases that rely on it. Validation is the wrong layer for this. |
| **Leave the strategy at `currentTime`, fix only the route** | The route can't distinguish "reset is genuinely now" from "there is no reset" without the strategy telling it. The honest value has to originate where the `refillRatePerMs === 0` fact lives. |

### Out of scope

- **Sliding-window `resetAt`** — always finite (`windowMs >= 1`); untouched.
- **`X-RateLimit-Reset` epoch vs. delta-seconds format** — a separate spec question; this plan keeps the existing epoch-ms value on the finite path.
- **Finding #6** (`!=` on the admin key) and **finding #7** (`package.json` typo) — unrelated.
- **A dashboard/consumer contract for the absent header** — documented here in prose; no consumer code in this repo to change.

## Full code

### Changed file — `src/strategies/token-bucket.ts` (final state)

```ts
import { Clock } from "../clock.js";
import { CheckResult, TokenBucketState } from "./types.js";

export interface TokenBucketConfig {
    capacity: number;
    refillRatePerMs: number;
}

export function checkTokenBucket(
    state: TokenBucketState | undefined,
    config: TokenBucketConfig,
    now: Clock
): { result: CheckResult; nextState: TokenBucketState } {
    const currentTime = now();
    const previous = state ?? { tokens: config.capacity, lastRefillAt: currentTime };

    const elapsedMs = Math.max(0, currentTime - previous.lastRefillAt);
    const refilled = Math.min(config.capacity, previous.tokens + elapsedMs * config.refillRatePerMs);

    const allowed = refilled >= 1;
    const tokens = allowed ? refilled - 1 : refilled;

    const deficit = Math.max(0, 1 - tokens);
    const resetAt = config.refillRatePerMs > 0 ? currentTime + deficit / config.refillRatePerMs : Infinity;

    return {
        result: { allowed, remaining: Math.floor(tokens), resetAt, limit: config.capacity },
        nextState: { tokens, lastRefillAt: currentTime },
    };
}
```

**Change vs. current:** line 24 only — the ternary's false branch `currentTime` → `Infinity`. Everything else is identical.

> Note: when `tokens >= 1` (bucket not yet empty) `deficit` is `0`, so on the finite path `resetAt === currentTime` as before. On the static path it is now `Infinity` even with tokens remaining — correct: a static bucket's count never climbs back up, so there is no future moment it is "reset." The `remaining` field still reports the live count for `X-RateLimit-Remaining`.

**Superseded in part (2026-09-11):** the claim above that `Infinity` is
> correct "even with tokens remaining" held only because no test exercised
> a static bucket with headroom. `docs/code-review/finding-08-resetat-headroom-and-retryafter-units.md`
> narrows this: `resetAt` is `Infinity` only when `deficit > 0` (the bucket
> is actually at/under one token); a static bucket that still has tokens
> reports `resetAt === currentTime`, same as a non-static bucket in the same
> state. The exhausted-bucket case this plan was written for is unchanged.

### Changed file — `src/strategies/token-bucket.test.ts` — 1 new case

Add this `it` block inside `describe("checkTokenBucket", …)`:

```ts
    it("reports resetAt of Infinity for a static bucket that never refills", () => {
        const config = { capacity: 1, refillRatePerMs: 0 };
        const now = () => 0;

        const first = checkTokenBucket(undefined, config, now);
        expect(first.result.allowed).toBe(true);
        expect(first.result.resetAt).toBe(Infinity);

        const second = checkTokenBucket(first.nextState, config, now);
        expect(second.result.allowed).toBe(false);
        expect(second.result.resetAt).toBe(Infinity);
    });
```

The existing four cases are unchanged. Two of them (`"starts full…"`, `"denies requests once the bucket is empty"`) already use `refillRatePerMs: 0` but never assert on `resetAt`, so they stay green.

### Changed file — `src/routes/check.ts` (final state)

```ts
import type { FastifyInstance } from "fastify";
import type { RateLimiter } from "../rate-limiter.js";
import type { CheckEventBus } from "../events.js";
import { PolicyNotFoundError } from "../policies/registry.js";

interface CheckRouteDeps {
    rateLimiter: RateLimiter;
    eventBus: CheckEventBus;
}

interface CheckBody {
    key: string;
    policy: string;
}

export function registerCheckRoute(app: FastifyInstance, deps: CheckRouteDeps): void {
    app.post<{ Body: CheckBody }>("/check", async (request, reply) => {
        const body = request.body ?? ({} as CheckBody);
        const { key, policy } = body;

        if (typeof key !== "string" || typeof policy !== "string") {
            return reply.status(400).send({ error: "key and policy are required strings" });
        }

        let result;
        try {
            result = deps.rateLimiter.check(key, policy);
        } catch (err) {
            if (err instanceof PolicyNotFoundError) {
                return reply.status(404).send({ error: `unknown policy: ${policy}` });
            }
            throw err;
        }

        deps.eventBus.emit({ key, policy, allowed: result.allowed, timestamp: Date.now() });

        const resetAt = Number.isFinite(result.resetAt) ? result.resetAt : null;

        reply.header("X-RateLimit-Limit", result.limit);
        reply.header("X-RateLimit-Remaining", result.remaining);
        if (resetAt !== null) {
            reply.header("X-RateLimit-Reset", resetAt);
        }

        if (!result.allowed) {
            if (resetAt !== null) {
                reply.header("Retry-After", Math.max(0, Math.ceil((resetAt - Date.now()) / 1000)));
            }
            return reply.status(429).send({ allowed: false, retryAfter: resetAt });
        }

        return reply.status(200).send({ allowed: true, remaining: result.remaining, resetAt });
    });
}
```

**Changes vs. current:**

- New `const resetAt = Number.isFinite(result.resetAt) ? result.resetAt : null;` computed once.
- `X-RateLimit-Reset` is set only when `resetAt !== null` (was set unconditionally from `result.resetAt`).
- `Retry-After` is set only when `resetAt !== null` (was computed from `result.resetAt` unconditionally on the 429 path).
- `429` body: `retryAfter: resetAt` (was `retryAfter: result.resetAt`).
- `200` body: `resetAt` (was `resetAt: result.resetAt`).
- `X-RateLimit-Limit` / `X-RateLimit-Remaining` / 400 / 404 / event emit — unchanged.

### Changed file — `src/routes/check.test.ts` — 2 new cases

Add these `it` blocks inside `describe("POST /check", …)`:

```ts
    it("omits reset headers and nulls resetAt in the body when the limiter reports no reset (allowed)", async () => {
        const rateLimiter = {
            check: vi.fn().mockReturnValue({ allowed: true, remaining: 0, resetAt: Infinity, limit: 1 }),
        } as unknown as RateLimiter;
        const { app } = buildTestApp(rateLimiter);

        const response = await app.inject({
            method: "POST",
            url: "/check",
            payload: { key: "user-1", policy: "static" },
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers["x-ratelimit-reset"]).toBeUndefined();
        expect(JSON.parse(response.body)).toEqual({ allowed: true, remaining: 0, resetAt: null });
    });

    it("omits Retry-After and nulls retryAfter when the limiter reports no reset (denied)", async () => {
        const rateLimiter = {
            check: vi.fn().mockReturnValue({ allowed: false, remaining: 0, resetAt: Infinity, limit: 1 }),
        } as unknown as RateLimiter;
        const { app } = buildTestApp(rateLimiter);

        const response = await app.inject({
            method: "POST",
            url: "/check",
            payload: { key: "user-1", policy: "static" },
        });

        expect(response.statusCode).toBe(429);
        expect(response.headers["retry-after"]).toBeUndefined();
        expect(response.headers["x-ratelimit-reset"]).toBeUndefined();
        expect(JSON.parse(response.body)).toEqual({ allowed: false, retryAfter: null });
    });
```

The existing five cases are unchanged. `"returns 200 and rate-limit headers when allowed"` and `"returns 429 with Retry-After when denied"` both use finite `resetAt` values (`1000`, `Date.now() + 5000`), so they exercise the unchanged finite path and stay green.

## TDD sequence

Each cycle: add the test, run it, confirm the **RED** for the stated reason, apply the **GREEN** delta, confirm it passes and the whole file stays green.

---

### Cycle 1 — static bucket reports `resetAt === Infinity`

**Command:** `npx vitest run src/strategies/token-bucket.test.ts`

**Test:** the `"reports resetAt of Infinity for a static bucket that never refills"` block above.

**RED:** with `now = () => 0`, the current fallback returns `currentTime` (`0`) for both checks →
`expected 0 to be Infinity` on the first `resetAt` assertion.

**GREEN:** in `src/strategies/token-bucket.ts`, change the fallback:

```ts
const resetAt = config.refillRatePerMs > 0 ? currentTime + deficit / config.refillRatePerMs : Infinity;
```

Re-run → all five cases green. (`"refills tokens over time"` and `"clamps refull at capacity"` use `refillRatePerMs > 0`, unaffected.)

---

### Cycle 2 — `/check` omits `Retry-After` and nulls `retryAfter` on a non-finite reset (denied)

**Command from here:** `npx vitest run src/routes/check.test.ts`

**Test:** the `"omits Retry-After and nulls retryAfter when the limiter reports no reset (denied)"` block.

**RED:** the handler runs `Math.max(0, Math.ceil((Infinity - Date.now()) / 1000))` → `Infinity` →
`reply.header("Retry-After", Infinity)` sets the header to the string `"Infinity"` →
`expect(response.headers["retry-after"]).toBeUndefined()` fails (`"Infinity"` is defined).
(The body assertion happens to already hold — `JSON.stringify(Infinity)` is `null` — so the header is the RED driver.)

**GREEN:** apply the `src/routes/check.ts` changes — compute `resetAt` once with `Number.isFinite`, guard the `Retry-After` set with `if (resetAt !== null)`, and send `retryAfter: resetAt`.

Re-run → green, and the existing `"returns 429 with Retry-After when denied"` still passes (its `resetAt` is finite, so the header is still set).

---

### Cycle 3 — `/check` omits `X-RateLimit-Reset` and nulls `resetAt` on a non-finite reset (allowed)

**Test:** the `"omits reset headers and nulls resetAt in the body when the limiter reports no reset (allowed)"` block.

**RED:** after cycle 2, `X-RateLimit-Reset` is still set unconditionally near the top of the handler
(`reply.header("X-RateLimit-Reset", result.resetAt)` → `"Infinity"`) →
`expect(response.headers["x-ratelimit-reset"]).toBeUndefined()` fails.

**GREEN:** guard that header too — `if (resetAt !== null) reply.header("X-RateLimit-Reset", resetAt);` — and send the `200` body as `resetAt` (the pre-nulled const). This is the final state shown in **Full code**.

Re-run → green. `"returns 200 and rate-limit headers when allowed"` still passes: its `resetAt` is `1000`, header still set, body still `{ allowed: true, remaining: 4, resetAt: 1000 }`.

---

### Refactor

- `resetAt` is computed once and reused for both headers and both body shapes — no duplication to remove.
- `npx vitest run` — full suite green, output pristine.
- `npm run typecheck` — clean (`resetAt` is `number | null`; the `200`/`429` bodies now include `null` in that field's type, which Fastify's `send` accepts).

## Commit plan

Commits track the cycle (one per logical green state is the floor):

1. `test: static token bucket reports no reset` → `fix: return Infinity resetAt when a token bucket never refills`
   — cycle 1 (`token-bucket.ts` + `token-bucket.test.ts`).
2. `test: /check drops retry hints when resetAt is non-finite` → `fix: omit Retry-After / X-RateLimit-Reset when the limit never resets`
   — cycles 2–3 (`check.ts` + `check.test.ts`).
3. `docs: implementation plan for finding #5`
   — this file.
