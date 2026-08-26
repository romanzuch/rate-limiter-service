# Rate Limiter Service — Backend Design

*Design spec — drafted 2026-08-25 via brainstorming. Companion: the dashboard repo (separate project, consumes this service's HTTP + SSE API).*

## Purpose

A standalone rate-limiter-as-a-service: an HTTP API other services could call to check/consume a request against a named rate-limit policy. Built test-first (strict TDD) with CI from commit one — the whole point of the project is a commit history that proves TDD practice, not just claims it.

## Stack

TypeScript, Fastify, in-memory store, Vitest, GitHub Actions CI (test + typecheck on every push).

## Architecture

Four layers:

- **Store** — an in-memory `Map` keyed by `(rateLimitKey, policyName)`, holding whatever state each strategy needs: a timestamp list for sliding window, a token count + last-refill timestamp for token bucket. Pure in-memory; state resets on restart. No persistence, no Redis, no distributed limiting.
- **Strategies** — `SlidingWindowStrategy` and `TokenBucketStrategy`, both implementing a common `RateLimiter` interface:
  ```ts
  interface RateLimiter {
    check(key: string, config: PolicyConfig, now: () => number): {
      allowed: boolean;
      remaining: number;
      resetAt: number;
    };
  }
  ```
  Pure functions over injected state, with an injectable clock (`now: () => number`) so tests control time directly — no real timers, no sleeping in tests.
- **Policy registry** — in-memory store of named policies. Config is a discriminated union per strategy:
  ```ts
  type PolicyConfig =
    | { strategy: "sliding-window"; limit: number; windowMs: number }
    | { strategy: "token-bucket"; capacity: number; refillRatePerMs: number };
  ```
- **Live stats** — an internal `EventEmitter` broadcasts every check's verdict as it happens. An SSE endpoint subscribes to it and pushes events to connected clients (the dashboard, but any SSE client works).

## API surface

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/check` | none | `{ key, policy }` → `200 { allowed: true, remaining, resetAt }` or `429 { allowed: false, retryAfter }`. Response also sets `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `Retry-After` (on 429). |
| `GET` | `/policies` | none | List all defined policies. |
| `POST` | `/policies` | `X-Admin-Key` | Create a named policy. |
| `PUT` | `/policies/:name` | `X-Admin-Key` | Update a policy's config. |
| `DELETE` | `/policies/:name` | `X-Admin-Key` | Remove a policy. |
| `GET` | `/stats/stream` | none | SSE stream of check events: `{ key, policy, allowed, timestamp }`. |

Admin routes compare the `X-Admin-Key` header against an `ADMIN_API_KEY` env var via a Fastify `preHandler`; mismatched/missing key → `401`.

## Data flow

1. A client (dashboard, simulator, curl, anything) calls `POST /check`.
2. The registry resolves the named policy; if it doesn't exist, `404`.
3. The matching strategy runs against the store's current state for `(key, policy)`, using the injected clock, producing a verdict.
4. The verdict is returned to the caller as the HTTP response.
5. The same verdict is emitted on the internal event emitter.
6. Any open `/stats/stream` SSE connections receive the event and forward it to their client.

Error cases: `429` on limit exceeded, `404` on unknown policy, `400` on malformed request body, `401` on bad/missing admin key.

## Testing

Strict TDD, red-green-refactor, no exceptions:

1. Strategy logic first — unit tests per strategy using an injected fake clock (e.g. a counter or fixed-then-advanced timestamp), covering the boundary/edge cases each algorithm is known for (window boundary bursts for sliding window, refill timing/capacity clamping for token bucket).
2. Policy registry next — CRUD behavior, duplicate names, unknown-policy lookups.
3. HTTP routes via Fastify's `.inject()` — status codes, headers, error bodies.
4. SSE — subscribe, trigger a check, assert the event is delivered to the subscriber.

CI (GitHub Actions) runs `npm test` and typecheck on every push and PR.

## Out of scope (YAGNI)

- No persistence or Redis — pure in-memory, resets on restart.
- No distributed rate limiting (single process only).
- No fixed-window strategy.
- No auth beyond the single admin key on policy-write routes.
- No user accounts or multi-tenancy.

## Status

- [ ] Not started — spec approved, awaiting repo creation and implementation plan.
