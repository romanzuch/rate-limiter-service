# Code Review: feat/initial-implementation

- **Date:** 2026-08-27
- **Diff reviewed:** `main...HEAD` (full branch diff)
- **Scope:** Store, strategies, registry, RateLimiter, routes, server/index
- **Cross-checked against:** `docs/superpowers/specs/2026-08-25-rate-limiter-backend-design.md`, `docs/superpowers/plans/2026-08-25-rate-limiter-backend.md`

## Findings

### 1. Composite store key can collide across policies
- **File:** `src/store.ts:5`
- **Summary:** The composite key is built by unescaped string concatenation (`` `${policy}::${key}` ``), so a policy name containing the `::` delimiter can collide with a different key under a different policy.
- **Failure scenario:** Admin creates a policy named `a::b` (nothing validates policy names). A client calling `POST /check` with `policy=a`, `key=b::c` produces the same store key (`a::b::c`) as `policy=a::b`, `key=c` — two unrelated clients silently share rate-limit state, violating the isolation guarantee `store.test.ts` itself asserts ("keeps state isolated between different policies for the same key").
- **Verdict:** CONFIRMED

### 2. `Retry-After` computed from the wrong field
- **File:** `src/routes/check.ts:42`
- **Summary:** `Retry-After` is computed from `result.remaining` (a small count) instead of `result.resetAt` (an epoch timestamp), as specified in the implementation plan.
- **Failure scenario:** On a 429, `remaining` is typically 0 and `Date.now()` is ~1.7e12, so `Math.ceil((0 - Date.now()) / 1000)` is hugely negative and `Math.max(0, …)` clamps it to 0 every time — clients are told to retry immediately (`Retry-After: 0`) instead of backing off, enabling retry storms and defeating the rate limiter's purpose. Confirmed against `docs/superpowers/plans/2026-08-25-rate-limiter-backend.md:1187`, which uses `result.resetAt` here.
- **Verdict:** CONFIRMED

### 3. Typo'd rate-limit header name
- **File:** `src/routes/check.ts:39`
- **Summary:** Header name typo: `X-ReateLimit-Reset` instead of the spec'd `X-RateLimit-Reset`.
- **Failure scenario:** Any client/dashboard that reads the standard `X-RateLimit-Reset` header (documented in `docs/superpowers/specs/2026-08-25-rate-limiter-backend-design.md:41`, and implemented correctly in the plan at line 1184) will find it absent and get `undefined` for the reset time.
- **Verdict:** CONFIRMED

### 4. `PUT /policies/:name` skips body validation
- **File:** `src/routes/policies.ts:49`
- **Summary:** `PUT /policies/:name` passes `request.body` straight to `registry.update` with no validation, unlike POST which at least checks `name`.
- **Failure scenario:** An admin PUTs `{}` (or a body missing `strategy`/`limit`/`capacity`) to `/policies/strict`; the registry silently stores it. Subsequent `/check` calls for that policy fall through to the token-bucket branch with `capacity`/`refillRatePerMs` undefined, producing NaN math that always yields `allowed: false` with no error surfaced — the policy silently and permanently denies every request.
- **Verdict:** CONFIRMED

### 5. Misleading `resetAt` when `refillRatePerMs` is 0
- **File:** `src/strategies/token-bucket.ts:24`
- **Summary:** When `refillRatePerMs` is 0 (an explicitly tested/supported config), `resetAt` on a denied check is set to `currentTime` even though the bucket will never refill.
- **Failure scenario:** Policy `{ capacity: 1, refillRatePerMs: 0 }` denies a second request; `resetAt` (and thus the 429 body's `retryAfter`) equals "now," implying an immediate retry will succeed, but the bucket never refills so every retry is denied again with the same misleading `resetAt`.
- **Verdict:** CONFIRMED

### 6. Loose equality on admin key comparison
- **File:** `src/routes/policies.ts:13`
- **Summary:** Admin key comparison uses loose `!=` instead of strict `!==` against a header value typed `string | string[] | undefined`.
- **Failure scenario:** If `x-admin-key` is sent as a duplicate header, Fastify/Node exposes it as an array; loose `!=` coerces the array to a string via `Array.prototype.toString` before comparing, so a single-element array `[adminApiKey]` compares equal to `deps.adminApiKey`, papering over the type mismatch instead of failing closed on unexpected input shapes.
- **Verdict:** CONFIRMED

### 7. `package.json` key typo
- **File:** `package.json:3`
- **Summary:** `"verson"` is a typo for `"version"`.
- **Failure scenario:** Any tooling that reads `package.json`'s `version` field (npm metadata, `require('./package.json').version` for a health/version endpoint, publishing) gets `undefined` instead of `"0.1.0"`.
- **Verdict:** CONFIRMED

## Files touched by findings

- `src/store.ts`
- `src/routes/check.ts`
- `src/routes/policies.ts`
- `src/strategies/token-bucket.ts`
- `package.json`
