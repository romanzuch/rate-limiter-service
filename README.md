# Rate Limiter Service

A standalone rate-limiter-as-a-service HTTP API, built test-first with CI from commit one. Other services would call this to check/consume a request against a named rate-limit policy — think a small, self-hosted alternative to a hosted rate-limiting API.

## Why this project

Portfolio project demonstrating strict TDD practice: the commit history is the artifact, not just a claim on a CV. Also covers real algorithmic content (sliding window / token bucket) and their concurrency/time edge cases.

## Stack

TypeScript, Fastify, in-memory store, Vitest, GitHub Actions CI (tests + typecheck on every push).

## Strategies

- **Sliding window** — counts requests in a rolling time window, avoiding fixed-window's boundary burst problem.
- **Token bucket** — smooth, bursty-allowance semantics via token refill over time.

## API

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/check` | none | Check/consume a request against a policy. |
| `GET` | `/policies` | none | List defined policies. |
| `POST` | `/policies` | admin key | Create a policy. |
| `PUT` | `/policies/:name` | admin key | Update a policy. |
| `DELETE` | `/policies/:name` | admin key | Remove a policy. |
| `GET` | `/stats/stream` | none | SSE stream of live check events. |

Full API contract, data flow, and testing strategy: [`docs/superpowers/specs/2026-08-25-rate-limiter-backend-design.md`](docs/superpowers/specs/2026-08-25-rate-limiter-backend-design.md).

## Companion project

A separate dashboard repo (React + Vite) consumes this service's HTTP + SSE API to show live traffic and includes a built-in load simulator. Not part of this repo.

## Status

In development — see [`docs/superpowers/plans/2026-08-25-rate-limiter-backend.md`](docs/superpowers/plans/2026-08-25-rate-limiter-backend.md) for the implementation plan.
