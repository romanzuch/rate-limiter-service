# Implementation plan — Follow-up review findings #1–#3: `resetAt` headroom and `Retry-After` units

*Plan for the findings from `/code-review a9df0ca~1..HEAD` — the review run over the fix commits for the original `feat-initial-implementation.md` findings.*

## Files changed

| File | Change |
|---|---|
| `src/strategies/token-bucket.ts` | modified — `resetAt` is `currentTime` (not `Infinity`) whenever the bucket has no deficit, even for a static (`refillRatePerMs: 0`) bucket |
| `src/strategies/token-bucket.test.ts` | modified — 1 new case: a static bucket that still has tokens reports `resetAt === currentTime` |
| `src/routes/check.ts` | modified — the 429 body's `retryAfter` now carries the same seconds-delta as the `Retry-After` header, computed once and reused, instead of the raw epoch-ms `resetAt` |
| `src/routes/check.test.ts` | modified — the existing "returns 429 with Retry-After when denied" case is rewritten with frozen time to assert exact header **and** body values (also closes the test gap flagged in the retry-after decision record) |
| `docs/decisions/2026-08-30-retry-after-source-field.md` | modified — corrects the now-stale "header vs. body unit mismatch is intentional" note (finding #2) and adds an addendum recording finding #3's new consideration and why the omit-on-never-reset behavior stands |
| `docs/code-review/finding-05-token-bucket-reset.md` | modified — a pointer note where it claimed `Infinity` is correct "even with tokens remaining," linking here for the corrected tokens-remaining case |

## Context

`/code-review a9df0ca~1..HEAD` reviewed the fix commits for the original 7 findings and surfaced 3 new ones, all inside the `resetAt` / `Retry-After` code that findings #2 and #5 reworked:

1. **`token-bucket.ts:24`** — a static bucket (`refillRatePerMs: 0`) reports `resetAt: Infinity` on *every* check, including an allowed one with tokens still left (e.g. `capacity: 5`, 4 remaining). `/check` then drops `X-RateLimit-Reset` and sends `resetAt: null` on a 200 that isn't throttled at all, and disagrees with a non-static bucket, which reports `resetAt = currentTime` in the same tokens-remaining state.
2. **`check.ts:49`** — the 429 body's `retryAfter` is the raw epoch-ms `resetAt`, while the `Retry-After` *header* next to it is a seconds delta. Same name, same neighborhood, incompatible units.
3. **`check.ts:46`** — `Retry-After` is omitted entirely on a 429 from a bucket that never resets; some retry middleware treats an absent header as "retry now," which is exactly the retry-storm behavior finding #2 fixed the header to prevent.

Findings #1 and #2 get real fixes below. Finding #3 was discussed and the decision is to **keep the current omit-on-never-reset behavior** — see Design & trade-offs. It's still "addressed" in the sense that the decision record now documents the new consideration and why it doesn't change the outcome, so a future reviewer doesn't re-raise it cold.

## Design & trade-offs

### #1 — `resetAt` should reflect deficit, not just `refillRatePerMs`

The strategy already computes `deficit = Math.max(0, 1 - tokens)` — it knows, per check, whether the bucket actually has no room. The bug is that the `Infinity` fallback ignores that and fires for *any* static bucket, not just an exhausted one:

```ts
const resetAt = config.refillRatePerMs > 0 ? currentTime + deficit / config.refillRatePerMs : Infinity;
```

Gating on `deficit === 0` first fixes it without touching the exhausted case:

```ts
const resetAt =
    deficit === 0
        ? currentTime
        : config.refillRatePerMs > 0
          ? currentTime + deficit / config.refillRatePerMs
          : Infinity;
```

This doesn't regress the existing "reports resetAt of Infinity for a static bucket that never refills" test — both its cases (`capacity: 1`) end with `tokens === 0`, hence `deficit === 1 > 0`, hence still `Infinity`. It only changes behavior for a static bucket that has headroom, which no existing test exercised.

**Alternative considered and rejected:** leave finding-05's blanket rule as-is. Rejected — the reviewer's `capacity: 5`, 4-remaining scenario is a real, previously-untested case, and the inconsistency with the non-static bucket (which already reports `currentTime` when it has headroom) means `X-RateLimit-Reset` means different things depending on strategy config for no reason. `docs/code-review/finding-05-token-bucket-reset.md`'s claim that `Infinity` is correct "even with tokens remaining" (line 126) is superseded by this plan for that specific case; its reasoning for the *exhausted* case is unaffected and stays correct.

### #2 — 429 body `retryAfter` should match the header's units

```ts
if (!result.allowed) {
    const retryAfter = resetAt !== null ? Math.max(0, Math.ceil((resetAt - Date.now()) / 1000)) : null;
    if (retryAfter !== null) {
        reply.header("Retry-After", retryAfter);
    }
    return reply.status(429).send({ allowed: false, retryAfter });
}
```

Computing the seconds-delta once and reusing it for both the header and the body directly resolves the finding: a client reading `body.retryAfter` now gets the same number as the header, not a 13-digit epoch timestamp under a duration-shaped name.

**Alternative considered and rejected:** rename the body field to `resetAt` (matching the 200 body) and keep the epoch value. Rejected — the design spec already names the field `retryAfter` (`429 { allowed: false, retryAfter }`), which reads as "how long to wait," the same thing the `Retry-After` header communicates. Fixing the *value* to match the *name* is smaller and doesn't touch the spec's field name.

This also closes the test gap `docs/decisions/2026-08-30-retry-after-source-field.md` flagged under "Test gap (follow-up, not done here)": the rewritten test freezes time and asserts the header's exact value, which nothing currently does.

### #3 — `Retry-After` stays omitted on a never-resetting 429

Decision: keep the status quo from finding #5. The new consideration (some retry middleware defaults to "retry now" when `Retry-After` is absent) is real, but weighed against finding #5's original argument — a fabricated finite number (e.g. a day) is still a lie told to every client of a never-resetting policy, and "no data" is a more honest signal than "come back in 24h" when that's not actually true. Sending a number doesn't fix a misbehaving client; it just changes what it's wrong about. No code changes for this finding — see the decision record addendum below.

**Out of scope:** `sliding-window.ts` (still always finite, untouched), the 200 body's `resetAt` representation (still epoch-ms, spec-compliant, unchanged), and threading the injected `Clock` into the route instead of calling `Date.now()` directly (already flagged as a separate change in the retry-after decision record).

## Full code

### `src/strategies/token-bucket.ts`

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
    const resetAt =
        deficit === 0
            ? currentTime
            : config.refillRatePerMs > 0
              ? currentTime + deficit / config.refillRatePerMs
              : Infinity;

    return {
        result: { allowed, remaining: Math.floor(tokens), resetAt, limit: config.capacity },
        nextState: { tokens, lastRefillAt: currentTime },
    };
}
```

**Change vs. current:** line 24 only — `resetAt` gates on `deficit === 0` before falling through to the existing refill-rate ternary. Everything else is identical.

### `src/strategies/token-bucket.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { checkTokenBucket } from "./token-bucket.js";

describe("checkTokenBucket", () => {
    it("starts full and allows requests up to capacity", () => {
        const config = { capacity: 2, refillRatePerMs: 0 };
        const now = () => 0;

        const first = checkTokenBucket(undefined, config, now);
        expect(first.result.allowed).toBe(true);
        expect(first.result.remaining).toBe(1);

        const second = checkTokenBucket(first.nextState, config, now);
        expect(second.result.allowed).toBe(true);
        expect(second.result.remaining).toBe(0);
    });

    it("denies requests once the bucket is empty", () => {
        const config = { capacity: 1, refillRatePerMs: 0 };
        const now = () => 0;

        const first = checkTokenBucket(undefined, config, now);
        const second = checkTokenBucket(first.nextState, config, now);

        expect(second.result.allowed).toBe(false);
    });

    it("refills tokens over time", () => {
        const config = { capacity: 1, refillRatePerMs: 0.001 };
        let currentTime = 0;
        const now = () => currentTime;

        const first = checkTokenBucket(undefined, config, now);
        expect(first.result.allowed).toBe(true);

        const second = checkTokenBucket(first.nextState, config, now);
        expect(second.result.allowed).toBe(false);

        currentTime = 1000;
        const third = checkTokenBucket(second.nextState, config, now);
        expect(third.result.allowed).toBe(true);
    });

    it("clamps refull at capacity", () => {
        const config = { capacity: 2, refillRatePerMs: 1 };
        let currentTime = 0;
        const now = () => currentTime;

        const first = checkTokenBucket(undefined, config, now);
        currentTime = 1000;
        const second = checkTokenBucket(first.nextState, config, now);

        expect(second.result.remaining).toBeLessThanOrEqual(config.capacity);
    });

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

    it("reports resetAt as currentTime for a static bucket that still has tokens", () => {
        const config = { capacity: 5, refillRatePerMs: 0 };
        const now = () => 1000;

        const first = checkTokenBucket(undefined, config, now);

        expect(first.result.allowed).toBe(true);
        expect(first.result.remaining).toBe(4);
        expect(first.result.resetAt).toBe(1000);
    });
})
```

**Change vs. current:** one new `it` block appended before the closing `})`. The four unchanged cases and the existing Infinity case are untouched.

### `src/routes/check.ts`

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
            const retryAfter = resetAt !== null ? Math.max(0, Math.ceil((resetAt - Date.now()) / 1000)) : null;
            if (retryAfter !== null) {
                reply.header("Retry-After", retryAfter);
            }
            return reply.status(429).send({ allowed: false, retryAfter });
        }

        return reply.status(200).send({ allowed: true, remaining: result.remaining, resetAt });
    });
}
```

**Change vs. current:** inside the `!result.allowed` branch — `retryAfter` is now computed once as a local (renamed from the inline expression) and used for both the header guard and the body, instead of reusing the epoch-ms `resetAt` for the body.

### `src/routes/check.test.ts`

```ts
import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { registerCheckRoute } from "./check.js";
import { PolicyNotFoundError } from "../policies/registry.js";
import type { RateLimiter } from "../rate-limiter.js";
import { CheckEventBus } from "../events.js";

function buildTestApp(rateLimiter: RateLimiter) {
    const app = Fastify();
    const eventBus = new CheckEventBus();
    registerCheckRoute(app, { rateLimiter, eventBus });
    return { app, eventBus };
}

describe("POST /check", () => {
    it("returns 200 and rate-limit headers when allowed", async () => {
        const rateLimiter = {
        check: vi.fn().mockReturnValue({ allowed: true, remaining: 4, resetAt: 1000, limit: 5 }),
        } as unknown as RateLimiter;
        const { app } = buildTestApp(rateLimiter); 

        const response = await app.inject({
            method: "POST",
            url: "/check",
            payload: { key: "user-1", policy: "strict" },
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers["x-ratelimit-remaining"]).toBe("4");
        expect(response.headers["x-ratelimit-limit"]).toBe("5");
        expect(JSON.parse(response.body)).toEqual({ allowed: true, remaining: 4, resetAt: 1000 });
    });

    it("returns 429 with Retry-After header and body in seconds when denied", async () => {
        const FIXED = 1_700_000_000_000;
        vi.useFakeTimers();
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

    it("returns 404 for an unknown policy", async () => {
        const rateLimiter = {
        check: vi.fn().mockImplementation(() => {
            throw new PolicyNotFoundError("missing");
        }),
        } as unknown as RateLimiter;
        const { app } = buildTestApp(rateLimiter);

        const response = await app.inject({
        method: "POST",
        url: "/check",
        payload: { key: "user-1", policy: "missing" },
        });

        expect(response.statusCode).toBe(404);
    });

    it("returns 400 when key or policy is missing", async () => {
        const rateLimiter = { check: vi.fn() } as unknown as RateLimiter;
        const { app } = buildTestApp(rateLimiter);

        const response = await app.inject({ method: "POST", url: "/check", payload: { key: "user-1" } });

        expect(response.statusCode).toBe(400);
    });

    it("emits a check event on the event bus", async () => {
        const rateLimiter = {
            check: vi.fn().mockReturnValue({ allowed: true, remaining: 4, resetAt: 1000, limit: 5 }),
        } as unknown as RateLimiter;
        const { app, eventBus } = buildTestApp(rateLimiter);
        const listener = vi.fn();
        eventBus.subscribe(listener);

        await app.inject({ method: "POST", url: "/check", payload: { key: "user-1", policy: "strict" } });

        expect(listener).toHaveBeenCalledWith(
            expect.objectContaining({ key: "user-1", policy: "strict", allowed: true })
        );
    });

    it("omits reset headers and nulls resetAt in the body when the limiter reports no reset (allowed)", async () => {
        const rateLimiter = {
            check: vi.fn().mockReturnValue({ allowed: true, remaining: 0, resetAt: Infinity, limit: 1}),
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
})
```

**Change vs. current:** the "returns 429 with Retry-After when denied" case is replaced with "returns 429 with Retry-After header and body in seconds when denied" — frozen time, exact header value, and a body assertion that pins `retryAfter` to the seconds delta instead of only checking the header is `toBeDefined()`. Every other case is unchanged.

### `docs/decisions/2026-08-30-retry-after-source-field.md`

Replace the stale bullet under "Other things to know later":

```md
- **Header vs. body unit mismatch is intentional for now.** `Retry-After`
  (header) is delta-seconds; `retryAfter` (429 body) is an epoch-ms timestamp.
  The plan specifies the body form; revisit only if a consumer needs them
  aligned.
```

with:

```md
- **Header and body now agree in seconds.** Follow-up review finding #2
  (`docs/code-review/finding-08-resetat-headroom-and-retryafter-units.md`)
  flagged the mismatch above as a real trap — a client reading `retryAfter`
  as "seconds to wait" (the name implies a delay) against an epoch-ms value
  would back off for millennia. The 429 body's `retryAfter` is now the same
  seconds-delta as the `Retry-After` header, computed once and reused.
```

And append a new section at the end of the file, after "## References":

```md
## Addendum — follow-up review finding #3 (2026-09-11)

`/code-review a9df0ca~1..HEAD` raised a new angle on the omit-on-never-reset
behavior from finding #5: some HTTP client retry middleware treats an absent
`Retry-After` as "retry immediately," which is the exact retry-storm behavior
this decision record's original fix exists to prevent.

Decision: unchanged. Sending a fabricated finite value (a day, a year, ever)
does not stop a client that already mishandles "retry-after is absent" from
mishandling "retry-after is a specific lie" — it just moves the failure from
"retries too fast" to "user waits behind an artificial number that has no
relationship to reality." Finding #5's original rejection of sentinel values
stands for the same reason it did there: absent is the only honest signal
for "no automatic reset," and a client's own backoff defaults are what should
fill the gap.

See `docs/code-review/finding-08-resetat-headroom-and-retryafter-units.md` for
the full discussion (findings #1–#3 of that review).
```

### `docs/code-review/finding-05-token-bucket-reset.md`

Insert a note immediately after the existing paragraph at line 126 (the one starting "`> Note: when \`tokens >= 1\`...`"):

```md
> **Superseded in part (2026-09-11):** the claim above that `Infinity` is
> correct "even with tokens remaining" held only because no test exercised
> a static bucket with headroom. `docs/code-review/finding-08-resetat-headroom-and-retryafter-units.md`
> narrows this: `resetAt` is `Infinity` only when `deficit > 0` (the bucket
> is actually at/under one token); a static bucket that still has tokens
> reports `resetAt === currentTime`, same as a non-static bucket in the same
> state. The exhausted-bucket case this plan was written for is unchanged.
```

## TDD sequence

### Cycle 1 — static bucket with headroom reports `resetAt === currentTime`

**Test:** the `"reports resetAt as currentTime for a static bucket that still has tokens"` block above, appended to `src/strategies/token-bucket.test.ts`.

**Command:** `npm test -- token-bucket`

**RED:** with the current unconditional `: Infinity` fallback, `first.result.resetAt` is `Infinity` →
`expected Infinity to be 1000` on the `resetAt` assertion. (`remaining` already passes — this branch doesn't touch token math.)

**GREEN:** apply the `src/strategies/token-bucket.ts` change — gate the ternary on `deficit === 0` first.

Re-run → green. The existing "reports resetAt of Infinity…" test also stays green (its cases both end at `deficit === 1`).

**Refactor:** none needed — the change is a single, already-minimal conditional.

### Cycle 2 — `/check` 429 body `retryAfter` matches the header's units

**Test:** the rewritten `"returns 429 with Retry-After header and body in seconds when denied"` block above, replacing the old case in `src/routes/check.test.ts`.

**Command:** `npm test -- check`

**RED:** the handler still sends `retryAfter: resetAt` (the raw epoch-ms value, `FIXED + 5000`) →
`expected { allowed: false, retryAfter: 1700000005000 } to equal { allowed: false, retryAfter: 5 }`.
(The header assertion `toBe("5")` already passes today — the body is the RED driver.)

**GREEN:** apply the `src/routes/check.ts` change — compute `retryAfter` once as the seconds delta, guard the header with it, and send it in the body.

Re-run → green. The "omits Retry-After and nulls retryAfter when the limiter reports no reset (denied)" case also stays green (`resetAt === null` still yields `retryAfter === null` either way).

**Refactor:** none needed.

### After both cycles

- `npm run typecheck` — clean. `retryAfter` stays `number | null`, same shape Fastify's `send` already accepted for that field.
- `npm test` — full suite green.
- Docs-only changes (`docs/decisions/2026-08-30-retry-after-source-field.md`, `docs/code-review/finding-05-token-bucket-reset.md`) have no test to run; edit them directly.

## Commit plan

1. `fix: only report a static token bucket's resetAt as unreachable when it has no tokens left` — Cycle 1's test + implementation.
2. `fix: send 429 body retryAfter in seconds, matching the Retry-After header` — Cycle 2's test + implementation.
3. `docs: record follow-up review findings #1-3 in the retry-after decision record and finding-05 plan` — the two doc edits above.
