# Store key structure — nested maps over a composite string key

*Decision record — 2026-08-28. Prompted by code-review finding #1 on `feat/initial-implementation` (`docs/code-review/feat-initial-implementation.md`).*

## Context

`Store<T>` holds per-caller strategy state addressed by a `(key, policy)` pair
(`key` = the client-supplied rate-limit subject, `policy` = the named policy).
The first implementation flattened the pair into one `Map<string, T>` entry via
string concatenation:

```ts
private makeKey(key: string, policy: string): string {
    return `${policy}::${key}`;
}
```

This mapping is not injective. Any component containing the `::` delimiter makes
two distinct pairs collide onto the same entry:

| policy | key    | composite |
|--------|--------|-----------|
| `a`    | `b::c` | `a::b::c` |
| `a::b` | `c`    | `a::b::c` |

Two unrelated callers then silently share one rate-limit window — a violation of
the isolation guarantee `src/store.test.ts` asserts. Reachable two ways:

- **Namespaced names.** `tier::free`, `team::acme`, `env::staging` are natural
  policy names; client keys are routinely structured (`ip:1.2.3.4`,
  `user:42:route:/x`). No malice required.
- **Registered `::` policy.** `PolicyRegistry` does not constrain the name
  charset, so an admin can register `a::b` directly.

## Decision

Two-level map. The outer map is keyed by `policy`; each value is its own inner
map keyed by `key`. Nothing is concatenated, so there is no delimiter to collide
on.

```ts
export class Store<T> {
    private state = new Map<string, Map<string, T>>();

    get(key: string, policy: string): T | undefined {
        return this.state.get(policy)?.get(key);
    }

    set(key: string, policy: string, value: T): void {
        let inner = this.state.get(policy);
        if (inner === undefined) {
            inner = new Map<string, T>();
            this.state.set(policy, inner);
        }
        inner.set(key, value);
    }
}
```

- **Read** uses optional chaining: an absent policy short-circuits to
  `undefined`, matching the previous "unknown key → undefined" behavior.
- **Write** does get-or-create: the first `set` for a policy allocates that
  policy's inner map and stores it; later writes reuse it. A `Map` is a
  reference type, so `this.state.set(policy, inner)` stores the same object that
  the following `inner.set(key, value)` mutates — nothing is assigned back.
- Public method signatures are unchanged, so `RateLimiter` and every route/test
  are untouched. This was a pure internal-representation swap, done test-first
  (new failing test in `src/store.test.ts` for the `::` case, then this change).

`makeKey` was deleted. `::` is no longer meaningful anywhere in the store —
`a::b` is just an ordinary outer key sitting next to `policy-a`.

## Alternatives considered and rejected

| Option | Why not |
|--------|---------|
| **Escape the delimiter** (`\:` for `:`, `\\` for `\`, then join) | Works, but hand-rolled escaping is the classic place to introduce an off-by-one. Nested maps remove the whole failure class instead of patching one delimiter. |
| **Unambiguous flat key** (`JSON.stringify([policy, key])`, or length-prefix `${policy.length}:${policy}${key}`) | Correct and minimal-diff, but less obvious to a reader than two maps, and keeps a serialization step that has no upside here. |
| **Validate policy/key charset at the boundary** | Reasonable defense-in-depth, but it is a behavior change (rejects currently-legal input), must be repeated at every entry point, and does not belong *in* the store — the store should be correct regardless of what flows in. Complementary, not a fix. Left undone; revisit only if a separate finding calls for name validation. |

## Deferred refactor: `bucketFor` helper

`set` contains a 4-line get-or-create block. It could be extracted:

```ts
private bucketFor(policy: string): Map<string, T> {
    let inner = this.state.get(policy);
    if (inner === undefined) {
        inner = new Map<string, T>();
        this.state.set(policy, inner);
    }
    return inner;
}
// set(...) { this.bucketFor(policy).set(key, value); }
```

**Not done deliberately.** There is exactly one caller. Per the repo's scope
rule ("three similar lines beat a premature abstraction"), the inline version
stays.

**Revisit trigger:** a *second* caller that legitimately needs create-on-write
(e.g. an atomic read-modify-write helper on the store). Not a plain read — see
the invariant below.

## Invariant: the read path must never create buckets

`get` must stay a plain `this.state.get(policy)?.get(key)` chain. It must not be
routed through `bucketFor` (or any create-on-write helper), now or after a
future extraction. `bucketFor` has a side effect — it allocates and stores an
empty inner map. If `get` used it, merely querying an unknown policy would
permanently litter `state` with empty maps, and a read would mutate the store.
The write path does get-or-create; the read path does not. Keep that asymmetry.

## Other things to know later

- **No eviction / unbounded growth.** Entries are only ever added. Inner maps and
  outer entries are never removed or expired. A high-cardinality `key` space
  grows `state` without bound; this matches the spec's "in-memory, resets on
  restart, no persistence" stance, but a long-lived deployment would want a reap
  or TTL. Out of scope now.
- **Deleting a policy from `PolicyRegistry` does not touch the store.** That
  policy's inner map (and its counter state) lingers until process restart. If a
  name is later re-registered, it inherits the stale state. If this matters,
  wire policy deletion to a `Store` cleanup — which is the concrete "second
  caller" that would justify extracting `bucketFor` and adding a
  `delete(policy)` method.
- **Minimal surface.** No `has`, `delete`, `clear`, or `size` on `Store` — add
  each only when a real caller needs it (YAGNI).
- **Concurrency.** Single-threaded Node, synchronous map operations, no `await`
  between the get and the set inside `set` — no interleaving to worry about.
- **Don't reintroduce a composite string key** as a "simplification." The
  collision described above is why it's gone; `key` and `policy` are now free to
  contain any characters, including `::`.

## References

- Code review: `docs/code-review/feat-initial-implementation.md` (finding #1)
- Design spec: `docs/superpowers/specs/2026-08-25-rate-limiter-backend-design.md`
  (Architecture → Store — the "`Map` keyed by `(rateLimitKey, policyName)`" line
  is realized as the nested map described here)
- Implementation: `src/store.ts`, `src/store.test.ts`
- Commit: `4bd6823` — *fix: isolate Store state per policy using nested maps*
