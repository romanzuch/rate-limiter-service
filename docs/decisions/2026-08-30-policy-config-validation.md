# Policy config is validated at the route boundary before it reaches the registry

*Decision record — 2026-08-30. Prompted by code-review finding #4 on `feat/initial-implementation` (`docs/code-review/feat-initial-implementation.md`).*

*Status: implemented on `feat/initial-implementation` (not yet committed). 53 tests pass, `tsc --noEmit` clean. The full implementation plan — file manifest, complete code, TDD cycles — is `docs/code-review/finding-04-policy-config-validation.md`.*

## Context

`POST /policies` and `PUT /policies/:name` are the only ways a `PolicyConfig`
enters the system. Neither validated the config body:

- `POST` checks that `name` is a non-empty string, then passes the rest of the
  body to `registry.create` untouched (`src/routes/policies.ts:28-33`).
- `PUT` passes `request.body` straight to `registry.update` with no check at all
  (`src/routes/policies.ts:49`).

`PolicyRegistry` is a thin `Map` wrapper — `create`/`update` only guard the
name's existence, then `this.policies.set(name, config)` stores whatever object
they were handed (`src/policies/registry.ts:22-34`).

**Failure path** (`PUT /policies/strict` with body `{}`):

1. Registry stores `{}` as `strict`'s config.
2. Next `POST /check` for `strict` → `RateLimiter.check` evaluates
   `config.strategy === "sliding-window"` → `false` → falls through to the
   token-bucket branch.
3. `checkTokenBucket(state, {}, clock)` reads `config.capacity` and
   `config.refillRatePerMs` as `undefined` → `Math.min(undefined, …)` → `NaN` →
   `allowed = NaN >= 1` → `false`, `resetAt = currentTime`.
4. That policy now returns `429` for every request, permanently, and no error is
   ever surfaced.

The design spec lists "`400` on malformed request body" as a required error case
(`docs/superpowers/specs/2026-08-25-rate-limiter-backend-design.md`, Data flow
section). The implementation plan never wired it up for these routes — for
`POST` *or* `PUT`. So the fix is not "match POST's behavior on PUT"; POST has the
same hole for the config portion. Both routes get the same validation.

## Decision

A standalone pure predicate, `isValidPolicyConfig(input: unknown): input is
PolicyConfig`, in `src/policies/validate-config.ts` with its own unit test file.
Both route handlers call it and return `400 { error: "<reason>" }` on `false`,
before touching the registry.

- **Pure function, not a registry method.** The registry's minimal surface is
  deliberate (see the store-key decision record). The only writers are these two
  routes; a guard at that boundary gives the same "registry never holds a
  malformed config" guarantee without moving HTTP-shaped concerns into the
  domain object.
- **Predicate, not a thrown error.** Validation of external input is expected
  control flow, not exceptional. A type-guard return also narrows `unknown` to
  `PolicyConfig` at the call site, so the handler passes a properly typed value
  to `registry.create` / `registry.update`.
- **Same function for both routes.** `POST` runs the existing `name` check
  first, then `isValidPolicyConfig` on the remaining fields. `PUT` runs
  `isValidPolicyConfig` on the whole body.

### Handler order

- `POST`: `401` (preHandler) → `400` name → `400` config → `409` duplicate → `201`
- `PUT`: `401` (preHandler) → `400` config → `404` unknown policy → `200`

`PUT` must reject before `registry.update`, so a bad body leaves the stored
policy unchanged.

## Validation rules

`input` is a non-null object, `strategy` is one of the two known values, and the
fields that strategy's branch reads are finite numbers within the range that
branch can compute on:

| strategy | required fields | constraint |
|----------|-----------------|------------|
| `sliding-window` | `limit`, `windowMs` | `Number.isFinite`, `limit >= 1`, `windowMs >= 1` |
| `token-bucket` | `capacity`, `refillRatePerMs` | `Number.isFinite`, `capacity >= 1`, `refillRatePerMs >= 0` |

- `Number.isFinite` rejects `NaN`, `Infinity`, and non-numbers in one call.
- `refillRatePerMs: 0` is a supported config (the token-bucket strategy and its
  tests handle it) — the guard must **accept** it. This is an explicit
  over-strictness trap to test against.
- Unknown `strategy` strings, missing `strategy`, and non-object bodies
  (`"foo"`, `null`, arrays) are all rejected.

## Alternatives considered and rejected

| Option | Why not |
|--------|---------|
| **Inline the checks in each handler** | Duplicates non-trivial logic across `POST` and `PUT`, and it is more than the one-line `name` check to justify copy-paste. |
| **Validate inside `PolicyRegistry.create` / `update`** | Grows the domain object's responsibility and error vocabulary for a guarantee the route boundary already provides. Consistent with keeping `Store`/`Registry` minimal until a real second caller appears. |
| **Fastify JSON Schema (`schema: { body }`)** | The idiomatic-Fastify path and worth adopting later — it also gives response serialization. But a discriminated-union body schema (`oneOf` + per-branch `required` / `additionalProperties`) is a fiddly detour for this finding, and mixes `name` + config into one schema on `POST`. Recorded as a future refactor, not this change. |
| **Throw `InvalidPolicyConfigError`, catch in the route** | Matches the existing `try/catch` around registry errors, but uses exceptions for expected input variance. A predicate keeps validation as a plain pure function, separate from the registry's error types. |

## TDD sequence

Guard unit tests first (`src/policies/validate-config.test.ts`), one behavior
per red-green:

1. accepts a valid `sliding-window` config; then a valid `token-bucket` config
2. rejects a missing / unknown `strategy`
3. rejects non-numeric or missing `limit` (`sliding-window`) and `capacity`
   (`token-bucket`)
4. rejects `limit` below `1`; rejects negative `capacity`
5. **accepts `refillRatePerMs: 0`** (over-strictness guard)
6. rejects a non-object body (`"foo"`, `null`)

Then wire-in tests in `src/routes/policies.test.ts`:

7. `POST /policies` with a config missing `strategy` → `400`, `registry` unchanged
8. `PUT /policies/:name` with `{}` → `400`, the existing policy's config unchanged

Refactor pass: dedupe the `POST` / `PUT` call sites; confirm the guard narrows
`unknown` to `PolicyConfig` so no `as` cast is needed at the call sites.

Assert on the outcome (`isValidPolicyConfig(x) === false`, HTTP status, stored
config), not on the exact wording of the `error` string.

## Deferred / noted

- **Unknown extra keys are not rejected.** A body with `strategy:
  "sliding-window"` plus a stray `capacity` passes as long as `limit` /
  `windowMs` are valid. Tightening to reject unrecognised keys is a separate
  YAGNI call, best done via the Fastify-schema route above.
- **Policy `name` charset is still unvalidated** — see the store-key decision
  record. That was left as complementary defense-in-depth; this change does not
  address it and the nested-map store no longer needs it to be correct.
- **Finding #5 relation.** Once `refillRatePerMs: 0` configs are explicitly
  allowed through here, finding #5's "misleading `resetAt` when the bucket never
  refills" is the remaining rough edge for that config — a strategy-layer fix,
  not a validation one.

## References

- Code review: `docs/code-review/feat-initial-implementation.md` (finding #4)
- Design spec: `docs/superpowers/specs/2026-08-25-rate-limiter-backend-design.md`
  (Data flow — "`400` on malformed request body")
- Related decision: `docs/decisions/2026-08-28-store-key-structure.md`
  (registry/store minimal surface; name-charset validation left undone)
- Implementation — files changed:
  - `src/policies/validate-config.ts` (new) — the `isValidPolicyConfig` predicate
  - `src/policies/validate-config.test.ts` (new) — 7 unit tests for the predicate
  - `src/routes/policies.ts` (modified) — call the guard in the `POST` and `PUT`
    handlers; body generics `→ unknown`; drop the `as PolicyConfig` cast
  - `src/routes/policies.test.ts` (modified) — 2 new cases (`POST` / `PUT` reject
    an invalid config); the existing 8 are unchanged
  - `src/policies/registry.ts`, `src/strategies/token-bucket.ts` — read for
    context, not changed
- Commits: `75a777d` (validator), `6065c5b` (route wiring — *fix: validate policy config on POST and PUT /policies*), `ab900d5` (docs)
