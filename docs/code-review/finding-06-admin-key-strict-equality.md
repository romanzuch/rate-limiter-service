# Implementation plan — Finding #6: strict equality on the admin-key compare

**Status:** not started
**Review finding:** `docs/code-review/feat-initial-implementation.md` #6

---

## Files changed

| File | Change |
|------|--------|
| `src/routes/policies.ts` | **modified** — `requireAdminKey` becomes an exported function; its comparison changes from `!=` to `!==` |
| `src/routes/policies.test.ts` | **modified** — 1 new unit test calling `requireAdminKey` directly with an array-shaped header value; existing 10 cases unchanged |

Nothing else is touched.

---

## Context

`requireAdminKey` (`src/routes/policies.ts:10-17`) guards every admin route:

```ts
function requireAdminKey(deps: PoliciesRouteDeps) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        const key = request.headers["x-admin-key"];
        if (key != deps.adminApiKey) {
            return reply.status(401).send({ error: "invalid or missing admin key" });
        }
    };
}
```

`request.headers["x-admin-key"]` is typed `string | string[] | undefined` (Fastify's
`IncomingHttpHeaders` index signature is generic across all header names — it allows
an array for *any* key, not just the handful Node actually arrays, like `set-cookie`).
`deps.adminApiKey` is a plain `string`. `!=` is loose equality: when the two operands'
types differ, JS coerces one side before comparing. For an array on the left, that
coercion is `Array.prototype.toString`, which joins elements with `,`. So:

```js
[adminApiKey] != adminApiKey   // false — coerces to the same string, "not-unequal"
```

A strict `!==` never coerces: comparing a `string[]` to a `string` is `true` (not
equal) regardless of contents, which is the correct behavior for an auth check —
an unexpected shape should fail closed, not get a chance to accidentally match.

**Checked before writing this plan — does a real request ever deliver that array?**
I sent a real duplicate `x-admin-key` header (via a raw socket, and separately via
Fastify's `inject()` with an array-valued header) and inspected what the handler
receives:

```
$ printf 'GET /probe HTTP/1.1\r\nHost: 127.0.0.1\r\nx-admin-key: test-admin-key\r\nx-admin-key: other\r\nConnection: close\r\n\r\n' | nc 127.0.0.1 <port>
{"key":"test-admin-key, other","isArray":false,"typeofKey":"string"}
```

Node's HTTP parser joins duplicate values of any header not on its short discard/array
list (`set-cookie`, `cookie`, and a handful of singleton headers) into **one
comma-joined string**, not an array — `x-admin-key` is not on that list. `app.inject()`
does the same. So through the real HTTP path *and* through the route-level tests this
repo already has, `key` is always `string | undefined` in practice; the `string[]`
branch of its type is unreachable from an actual request, and the two operators
behave identically for that path (loose vs. strict equality only differ when the
operand *types* differ).

**So why fix it:** this is a hardening / correctness fix, not a currently-exploitable
one. `!=` here is dead weight that:
- relies on the coincidence that nothing in this codebase, at this Fastify version,
  hands the header back as an array — a change to a proxy in front of this service,
  a Fastify upgrade, or an `x-admin-key` renamed to a header Node does treat as an
  array (unlikely, but the type doesn't rule it out) would silently reopen the
  coercion path;
- is a footgun the type signature itself is telling you about (`string | string[]`)
  that `eqeqeq`-style lint rules exist specifically to catch;
- costs nothing to fix — `!==` is strictly more correct on every input the type
  allows, and identical in behavior on every input the two existing e2e tests (and
  every real request) actually produce.

Since the divergent behavior only shows up for an array-shaped `key`, and no real
transport in this repo produces one, demonstrating the fix with a red test means
calling `requireAdminKey` directly with a hand-built request, bypassing
`app.inject()`. That requires exporting it.

## Design & trade-offs

**Export `requireAdminKey` as-is; unit-test it directly.** No new file, no
extraction to a separate module — it stays exactly where it is and exactly what it
is (a preHandler factory closed over `PoliciesRouteDeps`), just with `export` added.
The test builds a fake `FastifyRequest`/`FastifyReply` pair and calls the returned
guard function directly, so it can hand `key` an array without needing a transport
layer that will actually produce one.

**Alternatives considered:**

| Option | Why not |
|--------|---------|
| Fix `!=` → `!==` with no new test, on the grounds that it's "trivial" (a typo-class fix) | The repo's TDD rule has no size exception, and unlike a true one-character typo (e.g. finding #7's `package.json`), this one has a behavioral difference to pin down — skipping the test would leave the fix unverified and the regression silently re-introducible. |
| Drive the test through `app.inject()` with an array header value | Shown above to not work: `inject()` joins array header values into a single string before the handler ever sees them, same as real Node. It cannot reach the coercion branch at all. |
| Extract `requireAdminKey` into its own module (`src/policies/require-admin-key.ts`) with its own test file, mirroring `validate-config.ts` | Over-extraction for one function with one caller (`registerPoliciesRoutes`) and no reuse elsewhere. YAGNI — export in place, same as any other single-use helper in this file. |
| Widen nothing, just cast `request.headers["x-admin-key"] as string` before comparing | Silences the type instead of handling it; an actual array would then compare a stringified value against `adminApiKey`, reintroducing the exact coercion the fix removes — worse than doing nothing. |

**Out of scope:**
- Finding #7 (`package.json` `"verson"` typo) — unrelated, separate trivial fix.
- Constant-time comparison for the admin key (timing-attack hardening) — not raised
  by this finding; a separate concern if it's ever raised.
- Rejecting an `undefined` key differently from a wrong key — both already return
  401 with the same message, unchanged here.

## Full code

### Changed file — `src/routes/policies.ts` (final state)

```ts
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { PolicyRegistry, PolicyAlreadyExistsError, PolicyNotFoundError } from "../policies/registry.js";
import { isValidPolicyConfig } from "../policies/validate-config.js";

interface PoliciesRouteDeps {
    registry: PolicyRegistry;
    adminApiKey: string;
}

export function requireAdminKey(deps: PoliciesRouteDeps) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        const key = request.headers["x-admin-key"];
        if (key !== deps.adminApiKey) {
            return reply.status(401).send({ error: "invalid or missing admin key" });
        }
    };
}

export function registerPoliciesRoutes(app: FastifyInstance, deps: PoliciesRouteDeps): void {
    // ... unchanged — GET, POST, PUT, DELETE bodies are untouched by this finding
}
```

**Changes vs. current:** two lines only — `function requireAdminKey` gains `export`,
and its body's `!=` becomes `!==`. `PoliciesRouteDeps` stays un-exported (the test
passes a plain object literal; TypeScript checks it structurally against the
parameter type without needing the type imported). Everything below
`requireAdminKey` in the file is untouched.

### Changed file — `src/routes/policies.test.ts` — 1 new case

Add the import and this `it` block inside `describe("/policies", …)`:

```ts
import { describe, it, expect, vi } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import Fastify from "fastify";
import { registerPoliciesRoutes, requireAdminKey } from "./policies.js";
import { PolicyRegistry } from "../policies/registry.js";
```

```ts
    it("rejects an array-shaped admin-key header even when its only element matches", async () => {
        const guard = requireAdminKey({ registry: new PolicyRegistry(), adminApiKey: ADMIN_KEY });
        const request = { headers: { "x-admin-key": [ADMIN_KEY] } } as unknown as FastifyRequest;
        const send = vi.fn();
        const status = vi.fn().mockReturnValue({ send });
        const reply = { status } as unknown as FastifyReply;

        await guard(request, reply);

        expect(status).toHaveBeenCalledWith(401);
        expect(send).toHaveBeenCalledWith({ error: "invalid or missing admin key" });
    });
```

The existing 10 cases are **not** edited and stay green: every one of them drives
`requireAdminKey` through `app.inject()`, which only ever hands the handler a
`string | undefined` for `x-admin-key` (verified above) — both `!=` and `!==` agree
on every value those tests send.

## TDD sequence

Command throughout:

```
npx vitest run src/routes/policies.test.ts
```

---

### Cycle 1 — `requireAdminKey` rejects an array-shaped header even if its only element matches

**Test:** the `"rejects an array-shaped admin-key header…"` block above.

**RED:** `requireAdminKey` is not exported yet, so this first fails at compile/import
time (`requireAdminKey` is not a member of `./policies.js`). Add `export` to the
existing function *only* — no behavior change yet:

```ts
export function requireAdminKey(deps: PoliciesRouteDeps) {
```

Re-run. Now it imports fine, but the assertion fails: `[ADMIN_KEY] != ADMIN_KEY`
coerces the array to the string `"test-admin-key"` via `toString()`, which loosely
equals `ADMIN_KEY`, so the guard returns without calling `reply.status(...)` at all —
`expected "status" to be called with 401` fails with zero calls recorded.

**GREEN:** flip the operator:

```ts
        if (key !== deps.adminApiKey) {
```

Re-run → passes: a `string[]` is never `===` a `string`, so the guard now calls
`reply.status(401).send(...)`.

---

### Refactor

- One-line change, one new export — nothing to dedupe.
- Confirm the existing 10 cases in `policies.test.ts` are untouched and still green.
- `npx vitest run` — full suite green, output pristine.
- `npm run typecheck` — clean (the new test's two `as unknown as …` casts are the
  same pattern already used in `check.test.ts`).

## Commit plan

1. `test: requireAdminKey rejects an array-shaped header` → `fix: use strict equality for the admin-key comparison`
   — cycle 1 (`policies.ts` + `policies.test.ts`).
2. `docs: implementation plan for finding #6`
   — this file.
