# Implementation plan — Finding #4: validate policy config on `POST` and `PUT /policies`

**Status:** implemented on `feat/initial-implementation` (not yet committed) — 53 tests pass, `tsc --noEmit` clean
**Decision record:** `docs/decisions/2026-08-30-policy-config-validation.md` (rationale, alternatives)
**Review finding:** `docs/code-review/feat-initial-implementation.md` #4

---

## Files changed

| File | Change |
|------|--------|
| `src/policies/validate-config.ts` | **new** — the `isValidPolicyConfig` predicate |
| `src/policies/validate-config.test.ts` | **new** — 7 unit tests for the predicate |
| `src/routes/policies.ts` | **modified** — call the guard in the `POST` and `PUT` handlers; body generics `→ unknown`; drop the `as PolicyConfig` cast |
| `src/routes/policies.test.ts` | **modified** — 2 new cases (`POST` / `PUT` reject an invalid config); the existing 8 are unchanged and stay green |

Nothing else is touched. `src/policies/registry.ts`, the strategies, and
`requireAdminKey` (finding #6's `!=`) are all left as-is.

---

## Context

`POST /policies` and `PUT /policies/:name` are the only ways a `PolicyConfig`
enters the system, and neither validates the config body:

- `POST` (`src/routes/policies.ts:28`) checks `name` is a non-empty string, then
  passes the rest of the body to `registry.create` untouched.
- `PUT` (`src/routes/policies.ts:49`) passes `request.body` straight to
  `registry.update` with no check at all.

`PolicyRegistry` (`src/policies/registry.ts`) is a thin `Map` wrapper — it only
guards the name, then stores whatever object it was handed.

**Failure path** — `PUT /policies/strict` with body `{}`:

1. Registry stores `{}` as `strict`'s config.
2. Next `POST /check` for `strict` → `RateLimiter.check` evaluates
   `config.strategy === "sliding-window"` → `false` → falls through to the
   token-bucket branch.
3. `checkTokenBucket(state, {}, clock)` reads `config.capacity` /
   `config.refillRatePerMs` as `undefined` → `Math.min(undefined, …)` → `NaN` →
   `allowed = NaN >= 1` → `false`.
4. That policy now returns `429` for every request, permanently, with no error
   surfaced.

The design spec requires `400` on a malformed request body
(`docs/superpowers/specs/2026-08-25-rate-limiter-backend-design.md`, Data flow).
It was never implemented for these routes — for `POST` *or* `PUT` — so both are
in scope.

## Design & trade-offs

**Approach:** a standalone pure predicate,
`isValidPolicyConfig(input: unknown): input is PolicyConfig`, in
`src/policies/validate-config.ts` with its own unit-test file. Both route
handlers call it and return `400 { error: "invalid policy config" }` on `false`,
before touching the registry.

- **Pure function, not a registry method** — keeps `PolicyRegistry`'s minimal
  surface; the only writers are these two routes, so a guard at that boundary
  gives the same "registry never holds junk" guarantee.
- **Predicate, not a thrown error** — validation of external input is expected
  control flow, and a type-guard return narrows `unknown` → `PolicyConfig` at
  the call site, so no `as` cast is needed when calling the registry.
- **Same function for both routes** — `POST` runs the existing `name` check
  first, then the guard on the remaining fields; `PUT` runs the guard on the
  whole body.

**Validation rules:**

| strategy | required fields | constraint |
|----------|-----------------|------------|
| `sliding-window` | `limit`, `windowMs` | number, finite, `limit >= 1`, `windowMs >= 1` |
| `token-bucket` | `capacity`, `refillRatePerMs` | number, finite, `capacity >= 1`, `refillRatePerMs >= 0` |

`refillRatePerMs: 0` is a **supported** config (the strategy and its tests handle
it) — the guard must accept it. Unknown / missing `strategy`, non-object bodies
(`"foo"`, `null`, arrays), and non-numeric fields are rejected.

**Handler order:**

- `POST`: `401` (preHandler) → `400` name → `400` config → `409` duplicate → `201`
- `PUT`: `401` (preHandler) → `400` config → `404` unknown policy → `200`

**Out of scope:**

- Rejecting unknown extra keys (e.g. `capacity` on a sliding-window config).
  YAGNI; best done later via Fastify JSON Schema.
- Policy `name` charset validation — see the store-key decision record.
- Finding #6 (loose `!=` on the admin-key compare, `src/routes/policies.ts:13`) —
  a separate finding; `requireAdminKey` is left exactly as-is here.
- Finding #5 (`resetAt` when the bucket never refills) — strategy-layer, separate.

## Full code

### New file — `src/policies/validate-config.ts`

```ts
import type { PolicyConfig } from "../strategies/types.js";

export function isValidPolicyConfig(input: unknown): input is PolicyConfig {
    if (typeof input !== "object" || input === null) {
        return false;
    }

    const config = input as Record<string, unknown>;

    if (config.strategy === "sliding-window") {
        const { limit, windowMs } = config;
        return (
            typeof limit === "number" &&
            Number.isFinite(limit) &&
            limit >= 1 &&
            typeof windowMs === "number" &&
            Number.isFinite(windowMs) &&
            windowMs >= 1
        );
    }

    if (config.strategy === "token-bucket") {
        const { capacity, refillRatePerMs } = config;
        return (
            typeof capacity === "number" &&
            Number.isFinite(capacity) &&
            capacity >= 1 &&
            typeof refillRatePerMs === "number" &&
            Number.isFinite(refillRatePerMs) &&
            refillRatePerMs >= 0
        );
    }

    return false;
}
```

`Number.isFinite` is kept even after `typeof … === "number"` because
`typeof NaN === "number"` and `typeof Infinity === "number"` are both `true`.

### New file — `src/policies/validate-config.test.ts` (final state)

```ts
import { describe, it, expect } from "vitest";
import { isValidPolicyConfig } from "./validate-config.js";

describe("isValidPolicyConfig", () => {
    it("accepts a valid sliding-window config", () => {
        expect(isValidPolicyConfig({ strategy: "sliding-window", limit: 1, windowMs: 1000 })).toBe(true);
    });

    it("rejects a non-object body", () => {
        expect(isValidPolicyConfig("sliding-window")).toBe(false);
        expect(isValidPolicyConfig(null)).toBe(false);
    });

    it("rejects a missing or unknown strategy", () => {
        expect(isValidPolicyConfig({ limit: 1, windowMs: 1000 })).toBe(false);
        expect(isValidPolicyConfig({ strategy: "fixed-window", limit: 1, windowMs: 1000 })).toBe(false);
    });

    it("rejects a sliding-window config with a non-numeric or missing field", () => {
        expect(isValidPolicyConfig({ strategy: "sliding-window", windowMs: 1000 })).toBe(false);
        expect(isValidPolicyConfig({ strategy: "sliding-window", limit: "1", windowMs: 1000 })).toBe(false);
    });

    it("rejects a sliding-window config with out-of-range values", () => {
        expect(isValidPolicyConfig({ strategy: "sliding-window", limit: 0, windowMs: 1000 })).toBe(false);
        expect(isValidPolicyConfig({ strategy: "sliding-window", limit: 1, windowMs: 0 })).toBe(false);
    });

    it("accepts a valid token-bucket config and rejects a missing or non-numeric field", () => {
        expect(isValidPolicyConfig({ strategy: "token-bucket", capacity: 10, refillRatePerMs: 0.5 })).toBe(true);
        expect(isValidPolicyConfig({ strategy: "token-bucket", refillRatePerMs: 1 })).toBe(false);
        expect(isValidPolicyConfig({ strategy: "token-bucket", capacity: 5, refillRatePerMs: "fast" })).toBe(false);
    });

    it("rejects a token-bucket config with out-of-range values but accepts refillRatePerMs of 0", () => {
        expect(isValidPolicyConfig({ strategy: "token-bucket", capacity: 0, refillRatePerMs: 1 })).toBe(false);
        expect(isValidPolicyConfig({ strategy: "token-bucket", capacity: 5, refillRatePerMs: -1 })).toBe(false);
        expect(isValidPolicyConfig({ strategy: "token-bucket", capacity: 1, refillRatePerMs: 0 })).toBe(true);
    });
});
```

> Two `it` blocks carry an "and" on purpose — the accept-case in each rides along
> with the reject-cases it shares a GREEN step with (see cycles 6 and 7). Split
> them if you prefer; the driving RED in each is the reject-case.

### Changed file — `src/routes/policies.ts` (final state)

```ts
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { PolicyRegistry, PolicyAlreadyExistsError, PolicyNotFoundError } from "../policies/registry.js";
import { isValidPolicyConfig } from "../policies/validate-config.js";

interface PoliciesRouteDeps {
    registry: PolicyRegistry;
    adminApiKey: string;
}

function requireAdminKey(deps: PoliciesRouteDeps) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        const key = request.headers["x-admin-key"];
        if (key != deps.adminApiKey) {
            return reply.status(401).send({ error: "invalid or missing admin key" });
        }
    };
}

export function registerPoliciesRoutes(app: FastifyInstance, deps: PoliciesRouteDeps): void {
    app.get("/policies", async () => {
        return { policies: deps.registry.list() };
    });

    app.post<{ Body: unknown }>(
        "/policies",
        { preHandler: requireAdminKey(deps) },
        async (request, reply) => {
            const body = (request.body ?? {}) as Record<string, unknown>;
            const { name, ...config } = body;

            if (typeof name !== "string" || !name) {
                return reply.status(400).send({ error: "name is required" });
            }
            if (!isValidPolicyConfig(config)) {
                return reply.status(400).send({ error: "invalid policy config" });
            }

            try {
                deps.registry.create(name, config);
            } catch (err) {
                if (err instanceof PolicyAlreadyExistsError) {
                    return reply.status(409).send({ error: `policy already exists: ${name}` });
                }
                throw err;
            }
            return reply.status(201).send({ name, config });
        }
    );

    app.put<{ Params: { name: string }; Body: unknown }>(
        "/policies/:name",
        { preHandler: requireAdminKey(deps) },
        async (request, reply) => {
            if (!isValidPolicyConfig(request.body)) {
                return reply.status(400).send({ error: "invalid policy config" });
            }
            try {
                deps.registry.update(request.params.name, request.body);
            } catch (err) {
                if (err instanceof PolicyNotFoundError) {
                    return reply.status(404).send({ error: `unknown policy: ${request.params.name}` });
                }
                throw err;
            }
            return reply.status(200).send({ name: request.params.name, config: request.body });
        }
    );

    app.delete<{ Params: { name: string } }>(
        "/policies/:name",
        { preHandler: requireAdminKey(deps) },
        async (request, reply) => {
            try {
                deps.registry.delete(request.params.name);
            } catch (err) {
                if (err instanceof PolicyNotFoundError) {
                    return reply.status(404).send({ error: `unknown policy: ${request.params.name}` });
                }
                throw err;
            }
            return reply.status(204).send();
        }
    );
}
```

Changes vs. current:

- New `isValidPolicyConfig` import.
- `POST` body generic `{ name: string } & PolicyConfig` → `unknown`; the
  `?? ({} as …)` cast becomes `?? {}` onto `Record<string, unknown>`; the guard
  call is added; `registry.create(name, config)` loses its `as PolicyConfig`
  cast (the guard narrows `config`).
- `PUT` body generic `PolicyConfig` → `unknown`; the guard call is added ahead of
  the `try`.
- `GET`, `DELETE`, `requireAdminKey` unchanged.

### Changed file — `src/routes/policies.test.ts` — 2 new cases

Append these two `it` blocks inside the `describe("/policies", …)`. They are
built in cycles 8 and 9 below.

```ts
    it("POST rejects a config that fails validation", async () => {
        const { app, registry } = buildTestApp();

        const response = await app.inject({
            method: "POST",
            url: "/policies",
            headers: { "x-admin-key": ADMIN_KEY },
            payload: { name: "broken", limit: 1, windowMs: 1000 },
        });

        expect(response.statusCode).toBe(400);
        expect(registry.get("broken")).toBeUndefined();
    });

    it("PUT rejects a config that fails validation and leaves the policy unchanged", async () => {
        const { app, registry } = buildTestApp();
        registry.create("strict", { strategy: "sliding-window", limit: 1, windowMs: 1000 });

        const response = await app.inject({
            method: "PUT",
            url: "/policies/strict",
            headers: { "x-admin-key": ADMIN_KEY },
            payload: {},
        });

        expect(response.statusCode).toBe(400);
        expect(registry.get("strict")).toEqual({ strategy: "sliding-window", limit: 1, windowMs: 1000 });
    });
```

The existing 8 cases are **not** edited and stay green:

- "POST rejects requests without a valid admin key" — `preHandler` returns `401`
  before validation runs (its payload's `slidin-window` typo never gets checked).
- "POST creates a policy" / "returns 409" / "PUT updates an existing policy" /
  "PUT returns 404" all send well-formed configs, so they pass the new guard.

## TDD sequence

Each cycle: add the test, run it, confirm the **RED** for the stated reason,
apply the **GREEN** delta, confirm it passes plus the whole file stays green.

Command throughout the guard cycles:

```
npx vitest run src/policies/validate-config.test.ts
```

---

### Cycle 1 — accepts a valid sliding-window config

**Test:** the `"accepts a valid sliding-window config"` block.

**RED:** first run errors — `Cannot find module './validate-config.js'`. Create
`src/policies/validate-config.ts` with a stub so it becomes a real assertion
failure:

```ts
import type { PolicyConfig } from "../strategies/types.js";

export function isValidPolicyConfig(input: unknown): input is PolicyConfig {
    return false;
}
```

Re-run → `expected false to be true`.

**GREEN:** minimal — flip the body:

```ts
    return true;
```

Passes. (Yes, this ignores the input; cycle 2 forces the first branch.)

---

### Cycle 2 — rejects a non-object body

**Test:** the `"rejects a non-object body"` block.

**RED:** `return true` → `expected true to be false` on `isValidPolicyConfig("sliding-window")`.

**GREEN:** add the object guard, keep the trailing `return true`:

```ts
    if (typeof input !== "object" || input === null) {
        return false;
    }
    return true;
```

---

### Cycle 3 — rejects a missing or unknown strategy

**Test:** the `"rejects a missing or unknown strategy"` block.

**RED:** `{ limit: 1, windowMs: 1000 }` → `return true` → `expected true to be false`.

**GREEN:** allow-list the two known strategies:

```ts
    const config = input as Record<string, unknown>;

    if (config.strategy === "sliding-window" || config.strategy === "token-bucket") {
        return true;
    }

    return false;
```

---

### Cycle 4 — rejects a sliding-window config with a non-numeric or missing field

**Test:** the `"… non-numeric or missing field"` block.

**RED:** `{ strategy: "sliding-window", windowMs: 1000 }` → the allow-list returns
`true` → `expected true to be false`.

**GREEN:** replace the `"sliding-window"` arm of the allow-list with a real check
(no range yet):

```ts
    if (config.strategy === "sliding-window") {
        const { limit, windowMs } = config;
        return (
            typeof limit === "number" &&
            Number.isFinite(limit) &&
            typeof windowMs === "number" &&
            Number.isFinite(windowMs)
        );
    }

    if (config.strategy === "token-bucket") {
        return true;
    }

    return false;
```

---

### Cycle 5 — rejects a sliding-window config with out-of-range values

**Test:** the `"… out-of-range values"` block.

**RED:** `{ strategy: "sliding-window", limit: 0, windowMs: 1000 }` →
`Number.isFinite(0)` is `true` → `expected true to be false`.

**GREEN:** add the bounds to the sliding-window arm:

```ts
            typeof limit === "number" &&
            Number.isFinite(limit) &&
            limit >= 1 &&
            typeof windowMs === "number" &&
            Number.isFinite(windowMs) &&
            windowMs >= 1
```

---

### Cycle 6 — token-bucket: rejects missing / non-numeric fields (accepts a valid one)

**Test:** the `"accepts a valid token-bucket config and rejects a missing or non-numeric field"` block.

**RED:** `{ strategy: "token-bucket", refillRatePerMs: 1 }` → the `token-bucket`
arm still returns `true` → `expected true to be false`. (The accept-case in the
same test already passes — it's the ride-along.)

**GREEN:** replace the `token-bucket` arm with a real check (no range yet):

```ts
    if (config.strategy === "token-bucket") {
        const { capacity, refillRatePerMs } = config;
        return (
            typeof capacity === "number" &&
            Number.isFinite(capacity) &&
            typeof refillRatePerMs === "number" &&
            Number.isFinite(refillRatePerMs)
        );
    }
```

---

### Cycle 7 — token-bucket: rejects out-of-range values, accepts `refillRatePerMs: 0`

**Test:** the `"… out-of-range values but accepts refillRatePerMs of 0"` block.

**RED:** `{ strategy: "token-bucket", capacity: 5, refillRatePerMs: -1 }` →
`Number.isFinite(-1)` is `true` → `expected true to be false`.

**GREEN:** add the bounds — `capacity >= 1` and `refillRatePerMs >= 0`:

```ts
            typeof capacity === "number" &&
            Number.isFinite(capacity) &&
            capacity >= 1 &&
            typeof refillRatePerMs === "number" &&
            Number.isFinite(refillRatePerMs) &&
            refillRatePerMs >= 0
```

The `refillRatePerMs: 0 → true` assertion locks `>= 0`; a later "tidy-up" to
`> 0` would fail this test. The file now matches **Full code** above.

---

### Cycle 8 — `POST /policies` rejects an invalid config

Command from here:

```
npx vitest run src/routes/policies.test.ts
```

**Test** — add to `src/routes/policies.test.ts`:

```ts
    it("POST rejects a config that fails validation", async () => {
        const { app, registry } = buildTestApp();

        const response = await app.inject({
            method: "POST",
            url: "/policies",
            headers: { "x-admin-key": ADMIN_KEY },
            payload: { name: "broken", limit: 1, windowMs: 1000 },
        });

        expect(response.statusCode).toBe(400);
        expect(registry.get("broken")).toBeUndefined();
    });
```

**RED:** today the handler stores the strategy-less config and returns `201` →
`expected 201 to be 400`.

**GREEN:** in the `POST` handler, after the `name` check, add:

```ts
            if (!isValidPolicyConfig(config)) {
                return reply.status(400).send({ error: "invalid policy config" });
            }
```

Add the import: `import { isValidPolicyConfig } from "../policies/validate-config.js";`

You'll also need the `POST` body-typing changes from **Full code** (generic →
`unknown`, `?? {}` onto `Record<string, unknown>`, drop the `as PolicyConfig`
cast) for `npm run typecheck` to pass.

---

### Cycle 9 — `PUT /policies/:name` rejects an invalid config

**Test** — add to `src/routes/policies.test.ts`:

```ts
    it("PUT rejects a config that fails validation and leaves the policy unchanged", async () => {
        const { app, registry } = buildTestApp();
        registry.create("strict", { strategy: "sliding-window", limit: 1, windowMs: 1000 });

        const response = await app.inject({
            method: "PUT",
            url: "/policies/strict",
            headers: { "x-admin-key": ADMIN_KEY },
            payload: {},
        });

        expect(response.statusCode).toBe(400);
        expect(registry.get("strict")).toEqual({ strategy: "sliding-window", limit: 1, windowMs: 1000 });
    });
```

**RED:** today the handler calls `registry.update` with `{}` and returns `200` →
`expected 200 to be 400` (and the stored config would be `{}`).

**GREEN:** in the `PUT` handler, before the `try`:

```ts
            if (!isValidPolicyConfig(request.body)) {
                return reply.status(400).send({ error: "invalid policy config" });
            }
```

Plus the `PUT` body generic `PolicyConfig` → `unknown` from **Full code**.

---

### Refactor

- Both handlers now have a single guard call each — nothing to dedupe.
- Confirm the two body-typing changes are in and no `as PolicyConfig` cast
  remains in `POST`.
- `npx vitest run` — full suite green, output pristine.
- `npm run typecheck` — clean.

## Commit plan

Commits track the cycle, matching the repo's convention (one per logical green
state is the floor):

1. `test: add failing spec for isValidPolicyConfig` → `feat: add policy config validator`
   — cycles 1–7 (squash the guard cycles into one red + one green commit, or keep
   them separate if you committed each).
2. `test: PUT/POST /policies reject invalid config` → `fix: validate policy config on POST and PUT /policies`
   — cycles 8–9 plus the body-typing changes.
3. `docs: implementation plan + decision record for finding #4`
   — this file and `docs/decisions/2026-08-30-policy-config-validation.md`.

After committing, replace the `_pending_` line at the bottom of the decision
record with commit 2's hash.
