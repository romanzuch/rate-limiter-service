# Rate Limiter Service (Backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone rate-limiter-as-a-service HTTP API (Fastify + TypeScript) supporting sliding-window and token-bucket strategies, an admin-keyed policy CRUD API, and an SSE live-stats stream — all in-memory, strict TDD throughout.

**Architecture:** Layered: a generic in-memory `Store`, two pure strategy functions (sliding window, token bucket) operating on injected state + an injectable clock, a `PolicyRegistry` for named policy configs, a `RateLimiter` orchestrator dispatching to the right strategy, a `CheckEventBus` broadcasting verdicts, and three Fastify route modules (`/check`, `/policies`, `/stats/stream`) wired together in `buildApp()`.

**Tech Stack:** TypeScript (strict, ESM/NodeNext), Fastify, Vitest, GitHub Actions CI, Node >=20.

**Spec:** `docs/superpowers/specs/2026-08-25-rate-limiter-backend-design.md`

## Global Constraints

- In-memory only — no Redis, no database, no disk persistence.
- Only two strategies: sliding window and token bucket (no fixed window).
- Auth: a single shared `ADMIN_API_KEY` (env var), required only on `/policies` write routes (`POST`/`PUT`/`DELETE`); everything else is unauthenticated.
- All time-dependent logic takes an injectable `Clock` (`() => number`); unit tests never use real timers, `setTimeout`-based sleeps, or wall-clock waits to test time-based behavior.
- Package manager: npm. Module system: ESM (`"type": "module"`, `NodeNext` resolution).
- CI (GitHub Actions) runs typecheck + tests on every push and PR.

---

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `npm run typecheck`, `npm test`, `npm run build`, `npm run dev`, `npm start` — scripts every later task relies on.

- [ ] **Step 1: Create the feature branch**

```bash
git checkout -b feat/initial-implementation
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "rate-limiter-service",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "fastify": "latest"
  },
  "devDependencies": {
    "@types/node": "latest",
    "tsx": "latest",
    "typescript": "latest",
    "vitest": "latest"
  }
}
```

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "declaration": false,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 4: Write `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

- [ ] **Step 5: Write `.gitignore`**

```
node_modules/
dist/
.env
```

- [ ] **Step 6: Write `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
```

- [ ] **Step 7: Install dependencies**

Run: `npm install`
Expected: `package-lock.json` created, `node_modules/` populated, exits 0.

(Typecheck and test scripts are not run yet — `src/` is empty, so `tsc` would fail with "no inputs found" and `vitest run` would fail with "no test files found". Both get their first real run in Task 2.)

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore .github/workflows/ci.yml
git commit -m "chore: scaffold project (Fastify + TypeScript + Vitest + CI)"
```

---

### Task 2: Clock abstraction

**Files:**
- Create: `src/clock.ts`
- Test: `src/clock.test.ts`

**Interfaces:**
- Produces: `type Clock = () => number`, `const systemClock: Clock`.

- [ ] **Step 1: Write the failing test**

```ts
// src/clock.test.ts
import { describe, it, expect } from "vitest";
import { systemClock } from "./clock.js";

describe("systemClock", () => {
  it("returns the current time in milliseconds", () => {
    const before = Date.now();
    const result = systemClock();
    const after = Date.now();

    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThanOrEqual(after);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/clock.test.ts`
Expected: FAIL — cannot find module `./clock.js`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/clock.ts
export type Clock = () => number;

export const systemClock: Clock = () => Date.now();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/clock.test.ts`
Expected: PASS

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors)

- [ ] **Step 6: Commit**

```bash
git add src/clock.ts src/clock.test.ts
git commit -m "feat: add injectable Clock abstraction"
```

---

### Task 3: In-memory Store

**Files:**
- Create: `src/store.ts`
- Test: `src/store.test.ts`

**Interfaces:**
- Produces: `class Store<T> { get(key: string, policy: string): T | undefined; set(key: string, policy: string, value: T): void }`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/store.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "./store.js";

describe("Store", () => {
  it("returns undefined for a key that has not been set", () => {
    const store = new Store<{ count: number }>();
    expect(store.get("user-1", "policy-a")).toBeUndefined();
  });

  it("stores and retrieves state per key+policy pair", () => {
    const store = new Store<{ count: number }>();
    store.set("user-1", "policy-a", { count: 1 });

    expect(store.get("user-1", "policy-a")).toEqual({ count: 1 });
  });

  it("keeps state isolated between different keys under the same policy", () => {
    const store = new Store<{ count: number }>();
    store.set("user-1", "policy-a", { count: 1 });
    store.set("user-2", "policy-a", { count: 5 });

    expect(store.get("user-1", "policy-a")).toEqual({ count: 1 });
    expect(store.get("user-2", "policy-a")).toEqual({ count: 5 });
  });

  it("keeps state isolated between different policies for the same key", () => {
    const store = new Store<{ count: number }>();
    store.set("user-1", "policy-a", { count: 1 });
    store.set("user-1", "policy-b", { count: 9 });

    expect(store.get("user-1", "policy-a")).toEqual({ count: 1 });
    expect(store.get("user-1", "policy-b")).toEqual({ count: 9 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/store.test.ts`
Expected: FAIL — cannot find module `./store.js`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/store.ts
export class Store<T> {
  private state = new Map<string, T>();

  private makeKey(key: string, policy: string): string {
    return `${policy}::${key}`;
  }

  get(key: string, policy: string): T | undefined {
    return this.state.get(this.makeKey(key, policy));
  }

  set(key: string, policy: string, value: T): void {
    this.state.set(this.makeKey(key, policy), value);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/store.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/store.ts src/store.test.ts
git commit -m "feat: add generic in-memory Store keyed by (key, policy)"
```

---

### Task 4: Sliding window strategy

**Files:**
- Create: `src/strategies/types.ts`
- Create: `src/strategies/sliding-window.ts`
- Test: `src/strategies/sliding-window.test.ts`

**Interfaces:**
- Consumes: `Clock` from `../clock.js`.
- Produces:
  ```ts
  // src/strategies/types.ts
  export type PolicyConfig =
    | { strategy: "sliding-window"; limit: number; windowMs: number }
    | { strategy: "token-bucket"; capacity: number; refillRatePerMs: number };

  export interface CheckResult {
    allowed: boolean;
    remaining: number;
    resetAt: number;
    limit: number;
  }

  export interface SlidingWindowState {
    timestamps: number[];
  }

  export interface TokenBucketState {
    tokens: number;
    lastRefillAt: number;
  }
  ```
  ```ts
  // src/strategies/sliding-window.ts
  export interface SlidingWindowConfig {
    limit: number;
    windowMs: number;
  }

  export function checkSlidingWindow(
    state: SlidingWindowState | undefined,
    config: SlidingWindowConfig,
    now: Clock
  ): { result: CheckResult; nextState: SlidingWindowState };
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// src/strategies/sliding-window.test.ts
import { describe, it, expect } from "vitest";
import { checkSlidingWindow } from "./sliding-window.js";

describe("checkSlidingWindow", () => {
  it("allows requests under the limit", () => {
    const config = { limit: 2, windowMs: 1000 };
    const now = () => 0;

    const first = checkSlidingWindow(undefined, config, now);
    expect(first.result.allowed).toBe(true);
    expect(first.result.remaining).toBe(1);

    const second = checkSlidingWindow(first.nextState, config, now);
    expect(second.result.allowed).toBe(true);
    expect(second.result.remaining).toBe(0);
  });

  it("denies requests once the limit is reached within the window", () => {
    const config = { limit: 1, windowMs: 1000 };
    const now = () => 0;

    const first = checkSlidingWindow(undefined, config, now);
    const second = checkSlidingWindow(first.nextState, config, now);

    expect(second.result.allowed).toBe(false);
    expect(second.result.remaining).toBe(0);
  });

  it("prunes timestamps outside the window, allowing requests again", () => {
    const config = { limit: 1, windowMs: 1000 };
    let currentTime = 0;
    const now = () => currentTime;

    const first = checkSlidingWindow(undefined, config, now);
    expect(first.result.allowed).toBe(true);

    currentTime = 1500;
    const second = checkSlidingWindow(first.nextState, config, now);
    expect(second.result.allowed).toBe(true);
  });

  it("reports limit and resetAt", () => {
    const config = { limit: 1, windowMs: 1000 };
    const now = () => 0;

    const first = checkSlidingWindow(undefined, config, now);
    expect(first.result.limit).toBe(1);
    expect(first.result.resetAt).toBe(1000);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/strategies/sliding-window.test.ts`
Expected: FAIL — cannot find module `./sliding-window.js`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/strategies/types.ts
export type PolicyConfig =
  | { strategy: "sliding-window"; limit: number; windowMs: number }
  | { strategy: "token-bucket"; capacity: number; refillRatePerMs: number };

export interface CheckResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  limit: number;
}

export interface SlidingWindowState {
  timestamps: number[];
}

export interface TokenBucketState {
  tokens: number;
  lastRefillAt: number;
}
```

```ts
// src/strategies/sliding-window.ts
import type { Clock } from "../clock.js";
import type { CheckResult, SlidingWindowState } from "./types.js";

export interface SlidingWindowConfig {
  limit: number;
  windowMs: number;
}

export function checkSlidingWindow(
  state: SlidingWindowState | undefined,
  config: SlidingWindowConfig,
  now: Clock
): { result: CheckResult; nextState: SlidingWindowState } {
  const currentTime = now();
  const windowStart = currentTime - config.windowMs;
  const timestamps = (state?.timestamps ?? []).filter((t) => t > windowStart);

  const allowed = timestamps.length < config.limit;
  if (allowed) {
    timestamps.push(currentTime);
  }

  const remaining = Math.max(0, config.limit - timestamps.length);
  const resetAt = timestamps.length > 0 ? timestamps[0] + config.windowMs : currentTime + config.windowMs;

  return {
    result: { allowed, remaining, resetAt, limit: config.limit },
    nextState: { timestamps },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/strategies/sliding-window.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/strategies/types.ts src/strategies/sliding-window.ts src/strategies/sliding-window.test.ts
git commit -m "feat: add sliding window rate-limit strategy"
```

---

### Task 5: Token bucket strategy

**Files:**
- Create: `src/strategies/token-bucket.ts`
- Test: `src/strategies/token-bucket.test.ts`

**Interfaces:**
- Consumes: `Clock` from `../clock.js`; `CheckResult`, `TokenBucketState` from `./types.js`.
- Produces:
  ```ts
  export interface TokenBucketConfig {
    capacity: number;
    refillRatePerMs: number;
  }

  export function checkTokenBucket(
    state: TokenBucketState | undefined,
    config: TokenBucketConfig,
    now: Clock
  ): { result: CheckResult; nextState: TokenBucketState };
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// src/strategies/token-bucket.test.ts
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

  it("clamps refill at capacity", () => {
    const config = { capacity: 2, refillRatePerMs: 1 };
    let currentTime = 0;
    const now = () => currentTime;

    const first = checkTokenBucket(undefined, config, now);
    currentTime = 1000;
    const second = checkTokenBucket(first.nextState, config, now);

    expect(second.result.remaining).toBeLessThanOrEqual(config.capacity);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/strategies/token-bucket.test.ts`
Expected: FAIL — cannot find module `./token-bucket.js`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/strategies/token-bucket.ts
import type { Clock } from "../clock.js";
import type { CheckResult, TokenBucketState } from "./types.js";

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
  const resetAt = config.refillRatePerMs > 0 ? currentTime + deficit / config.refillRatePerMs : currentTime;

  return {
    result: { allowed, remaining: Math.floor(tokens), resetAt, limit: config.capacity },
    nextState: { tokens, lastRefillAt: currentTime },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/strategies/token-bucket.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/strategies/token-bucket.ts src/strategies/token-bucket.test.ts
git commit -m "feat: add token bucket rate-limit strategy"
```

---

### Task 6: Policy registry

**Files:**
- Create: `src/policies/registry.ts`
- Test: `src/policies/registry.test.ts`

**Interfaces:**
- Consumes: `PolicyConfig` from `../strategies/types.js`.
- Produces:
  ```ts
  export interface Policy {
    name: string;
    config: PolicyConfig;
  }

  export class PolicyAlreadyExistsError extends Error {}
  export class PolicyNotFoundError extends Error {}

  export class PolicyRegistry {
    list(): Policy[];
    get(name: string): PolicyConfig | undefined;
    create(name: string, config: PolicyConfig): void; // throws PolicyAlreadyExistsError
    update(name: string, config: PolicyConfig): void; // throws PolicyNotFoundError
    delete(name: string): void; // throws PolicyNotFoundError
  }
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// src/policies/registry.test.ts
import { describe, it, expect } from "vitest";
import { PolicyRegistry, PolicyAlreadyExistsError, PolicyNotFoundError } from "./registry.js";

describe("PolicyRegistry", () => {
  it("creates and retrieves a policy", () => {
    const registry = new PolicyRegistry();
    registry.create("strict", { strategy: "sliding-window", limit: 10, windowMs: 10000 });

    expect(registry.get("strict")).toEqual({ strategy: "sliding-window", limit: 10, windowMs: 10000 });
  });

  it("lists all policies", () => {
    const registry = new PolicyRegistry();
    registry.create("a", { strategy: "sliding-window", limit: 1, windowMs: 1000 });
    registry.create("b", { strategy: "token-bucket", capacity: 1, refillRatePerMs: 1 });

    expect(registry.list()).toHaveLength(2);
  });

  it("throws PolicyAlreadyExistsError on duplicate create", () => {
    const registry = new PolicyRegistry();
    registry.create("strict", { strategy: "sliding-window", limit: 10, windowMs: 10000 });

    expect(() =>
      registry.create("strict", { strategy: "sliding-window", limit: 5, windowMs: 5000 })
    ).toThrow(PolicyAlreadyExistsError);
  });

  it("updates an existing policy", () => {
    const registry = new PolicyRegistry();
    registry.create("strict", { strategy: "sliding-window", limit: 10, windowMs: 10000 });
    registry.update("strict", { strategy: "sliding-window", limit: 20, windowMs: 10000 });

    expect(registry.get("strict")).toEqual({ strategy: "sliding-window", limit: 20, windowMs: 10000 });
  });

  it("throws PolicyNotFoundError when updating an unknown policy", () => {
    const registry = new PolicyRegistry();
    expect(() =>
      registry.update("missing", { strategy: "sliding-window", limit: 1, windowMs: 1000 })
    ).toThrow(PolicyNotFoundError);
  });

  it("deletes a policy", () => {
    const registry = new PolicyRegistry();
    registry.create("strict", { strategy: "sliding-window", limit: 10, windowMs: 10000 });
    registry.delete("strict");

    expect(registry.get("strict")).toBeUndefined();
  });

  it("throws PolicyNotFoundError when deleting an unknown policy", () => {
    const registry = new PolicyRegistry();
    expect(() => registry.delete("missing")).toThrow(PolicyNotFoundError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/policies/registry.test.ts`
Expected: FAIL — cannot find module `./registry.js`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/policies/registry.ts
import type { PolicyConfig } from "../strategies/types.js";

export interface Policy {
  name: string;
  config: PolicyConfig;
}

export class PolicyAlreadyExistsError extends Error {}
export class PolicyNotFoundError extends Error {}

export class PolicyRegistry {
  private policies = new Map<string, PolicyConfig>();

  list(): Policy[] {
    return [...this.policies.entries()].map(([name, config]) => ({ name, config }));
  }

  get(name: string): PolicyConfig | undefined {
    return this.policies.get(name);
  }

  create(name: string, config: PolicyConfig): void {
    if (this.policies.has(name)) {
      throw new PolicyAlreadyExistsError(name);
    }
    this.policies.set(name, config);
  }

  update(name: string, config: PolicyConfig): void {
    if (!this.policies.has(name)) {
      throw new PolicyNotFoundError(name);
    }
    this.policies.set(name, config);
  }

  delete(name: string): void {
    if (!this.policies.has(name)) {
      throw new PolicyNotFoundError(name);
    }
    this.policies.delete(name);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/policies/registry.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/policies/registry.ts src/policies/registry.test.ts
git commit -m "feat: add in-memory policy registry"
```

---

### Task 7: Check event bus

**Files:**
- Create: `src/events.ts`
- Test: `src/events.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface CheckEvent {
    key: string;
    policy: string;
    allowed: boolean;
    timestamp: number;
  }

  export class CheckEventBus {
    emit(event: CheckEvent): void;
    subscribe(listener: (event: CheckEvent) => void): () => void; // returns an unsubscribe function
  }
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// src/events.test.ts
import { describe, it, expect, vi } from "vitest";
import { CheckEventBus } from "./events.js";

describe("CheckEventBus", () => {
  it("delivers emitted events to subscribers", () => {
    const bus = new CheckEventBus();
    const listener = vi.fn();
    bus.subscribe(listener);

    const event = { key: "user-1", policy: "strict", allowed: true, timestamp: 123 };
    bus.emit(event);

    expect(listener).toHaveBeenCalledWith(event);
  });

  it("stops delivering events after unsubscribe", () => {
    const bus = new CheckEventBus();
    const listener = vi.fn();
    const unsubscribe = bus.subscribe(listener);
    unsubscribe();

    bus.emit({ key: "user-1", policy: "strict", allowed: true, timestamp: 123 });

    expect(listener).not.toHaveBeenCalled();
  });

  it("supports multiple independent subscribers", () => {
    const bus = new CheckEventBus();
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    bus.subscribe(listenerA);
    bus.subscribe(listenerB);

    bus.emit({ key: "user-1", policy: "strict", allowed: true, timestamp: 123 });

    expect(listenerA).toHaveBeenCalledTimes(1);
    expect(listenerB).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/events.test.ts`
Expected: FAIL — cannot find module `./events.js`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/events.ts
import { EventEmitter } from "node:events";

export interface CheckEvent {
  key: string;
  policy: string;
  allowed: boolean;
  timestamp: number;
}

export class CheckEventBus {
  private emitter = new EventEmitter();

  emit(event: CheckEvent): void {
    this.emitter.emit("check", event);
  }

  subscribe(listener: (event: CheckEvent) => void): () => void {
    this.emitter.on("check", listener);
    return () => this.emitter.off("check", listener);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/events.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/events.ts src/events.test.ts
git commit -m "feat: add CheckEventBus for broadcasting check verdicts"
```

---

### Task 8: RateLimiter orchestrator

**Files:**
- Create: `src/rate-limiter.ts`
- Test: `src/rate-limiter.test.ts`

**Interfaces:**
- Consumes: `PolicyRegistry` (Task 6), `Store<T>` (Task 3), `checkSlidingWindow` (Task 4), `checkTokenBucket` (Task 5), `Clock` (Task 2).
- Produces:
  ```ts
  export class RateLimiter {
    constructor(registry: PolicyRegistry, store: Store<SlidingWindowState | TokenBucketState>, now: Clock);
    check(key: string, policyName: string): CheckResult; // throws PolicyNotFoundError
  }
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// src/rate-limiter.test.ts
import { describe, it, expect } from "vitest";
import { RateLimiter } from "./rate-limiter.js";
import { PolicyRegistry, PolicyNotFoundError } from "./policies/registry.js";
import { Store } from "./store.js";
import type { SlidingWindowState, TokenBucketState } from "./strategies/types.js";

describe("RateLimiter", () => {
  it("dispatches to the sliding-window strategy and persists state across calls", () => {
    const registry = new PolicyRegistry();
    registry.create("test-policy", { strategy: "sliding-window", limit: 2, windowMs: 1000 });
    const store = new Store<SlidingWindowState | TokenBucketState>();
    const limiter = new RateLimiter(registry, store, () => 0);

    expect(limiter.check("user-1", "test-policy").allowed).toBe(true);
    expect(limiter.check("user-1", "test-policy").allowed).toBe(true);
    expect(limiter.check("user-1", "test-policy").allowed).toBe(false);
  });

  it("dispatches to the token-bucket strategy", () => {
    const registry = new PolicyRegistry();
    registry.create("burst", { strategy: "token-bucket", capacity: 1, refillRatePerMs: 0 });
    const store = new Store<SlidingWindowState | TokenBucketState>();
    const limiter = new RateLimiter(registry, store, () => 0);

    expect(limiter.check("user-1", "burst").allowed).toBe(true);
    expect(limiter.check("user-1", "burst").allowed).toBe(false);
  });

  it("keeps state isolated per key under the same policy", () => {
    const registry = new PolicyRegistry();
    registry.create("test-policy", { strategy: "sliding-window", limit: 1, windowMs: 1000 });
    const store = new Store<SlidingWindowState | TokenBucketState>();
    const limiter = new RateLimiter(registry, store, () => 0);

    expect(limiter.check("user-1", "test-policy").allowed).toBe(true);
    expect(limiter.check("user-2", "test-policy").allowed).toBe(true);
  });

  it("throws PolicyNotFoundError for an unknown policy", () => {
    const registry = new PolicyRegistry();
    const store = new Store<SlidingWindowState | TokenBucketState>();
    const limiter = new RateLimiter(registry, store, () => 0);

    expect(() => limiter.check("user-1", "missing")).toThrow(PolicyNotFoundError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/rate-limiter.test.ts`
Expected: FAIL — cannot find module `./rate-limiter.js`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/rate-limiter.ts
import type { Clock } from "./clock.js";
import { Store } from "./store.js";
import { PolicyRegistry, PolicyNotFoundError } from "./policies/registry.js";
import { checkSlidingWindow } from "./strategies/sliding-window.js";
import { checkTokenBucket } from "./strategies/token-bucket.js";
import type { CheckResult, SlidingWindowState, TokenBucketState } from "./strategies/types.js";

export class RateLimiter {
  constructor(
    private registry: PolicyRegistry,
    private store: Store<SlidingWindowState | TokenBucketState>,
    private now: Clock
  ) {}

  check(key: string, policyName: string): CheckResult {
    const config = this.registry.get(policyName);
    if (!config) {
      throw new PolicyNotFoundError(policyName);
    }

    const state = this.store.get(key, policyName);

    if (config.strategy === "sliding-window") {
      const { result, nextState } = checkSlidingWindow(state as SlidingWindowState | undefined, config, this.now);
      this.store.set(key, policyName, nextState);
      return result;
    }

    const { result, nextState } = checkTokenBucket(state as TokenBucketState | undefined, config, this.now);
    this.store.set(key, policyName, nextState);
    return result;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/rate-limiter.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/rate-limiter.ts src/rate-limiter.test.ts
git commit -m "feat: add RateLimiter orchestrator dispatching to strategies"
```

---

### Task 9: POST /check route

**Files:**
- Create: `src/routes/check.ts`
- Test: `src/routes/check.test.ts`

**Interfaces:**
- Consumes: `RateLimiter.check(key, policy): CheckResult` (Task 8, throws `PolicyNotFoundError`), `CheckEventBus.emit(event)` (Task 7).
- Produces: `registerCheckRoute(app: FastifyInstance, deps: { rateLimiter: RateLimiter; eventBus: CheckEventBus }): void` — mounts `POST /check`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/routes/check.test.ts
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

  it("returns 429 with Retry-After when denied", async () => {
    const rateLimiter = {
      check: vi.fn().mockReturnValue({ allowed: false, remaining: 0, resetAt: Date.now() + 5000, limit: 5 }),
    } as unknown as RateLimiter;
    const { app } = buildTestApp(rateLimiter);

    const response = await app.inject({
      method: "POST",
      url: "/check",
      payload: { key: "user-1", policy: "strict" },
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBeDefined();
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/routes/check.test.ts`
Expected: FAIL — cannot find module `./check.js`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/routes/check.ts
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

    reply.header("X-RateLimit-Limit", result.limit);
    reply.header("X-RateLimit-Remaining", result.remaining);
    reply.header("X-RateLimit-Reset", result.resetAt);

    if (!result.allowed) {
      reply.header("Retry-After", Math.max(0, Math.ceil((result.resetAt - Date.now()) / 1000)));
      return reply.status(429).send({ allowed: false, retryAfter: result.resetAt });
    }

    return reply.status(200).send({ allowed: true, remaining: result.remaining, resetAt: result.resetAt });
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/routes/check.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/routes/check.ts src/routes/check.test.ts
git commit -m "feat: add POST /check route"
```

---

### Task 10: Policy admin routes

**Files:**
- Create: `src/routes/policies.ts`
- Test: `src/routes/policies.test.ts`

**Interfaces:**
- Consumes: `PolicyRegistry` methods, `PolicyAlreadyExistsError`, `PolicyNotFoundError` (Task 6).
- Produces: `registerPoliciesRoutes(app: FastifyInstance, deps: { registry: PolicyRegistry; adminApiKey: string }): void` — mounts `GET/POST /policies`, `PUT/DELETE /policies/:name`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/routes/policies.test.ts
import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { registerPoliciesRoutes } from "./policies.js";
import { PolicyRegistry } from "../policies/registry.js";

const ADMIN_KEY = "test-admin-key";

function buildTestApp() {
  const app = Fastify();
  const registry = new PolicyRegistry();
  registerPoliciesRoutes(app, { registry, adminApiKey: ADMIN_KEY });
  return { app, registry };
}

describe("/policies", () => {
  it("GET lists policies without requiring auth", async () => {
    const { app, registry } = buildTestApp();
    registry.create("strict", { strategy: "sliding-window", limit: 1, windowMs: 1000 });

    const response = await app.inject({ method: "GET", url: "/policies" });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).policies).toHaveLength(1);
  });

  it("POST rejects requests without a valid admin key", async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: "POST",
      url: "/policies",
      payload: { name: "strict", strategy: "sliding-window", limit: 1, windowMs: 1000 },
    });

    expect(response.statusCode).toBe(401);
  });

  it("POST creates a policy with a valid admin key", async () => {
    const { app, registry } = buildTestApp();

    const response = await app.inject({
      method: "POST",
      url: "/policies",
      headers: { "x-admin-key": ADMIN_KEY },
      payload: { name: "strict", strategy: "sliding-window", limit: 1, windowMs: 1000 },
    });

    expect(response.statusCode).toBe(201);
    expect(registry.get("strict")).toEqual({ strategy: "sliding-window", limit: 1, windowMs: 1000 });
  });

  it("POST returns 409 for a duplicate policy name", async () => {
    const { app, registry } = buildTestApp();
    registry.create("strict", { strategy: "sliding-window", limit: 1, windowMs: 1000 });

    const response = await app.inject({
      method: "POST",
      url: "/policies",
      headers: { "x-admin-key": ADMIN_KEY },
      payload: { name: "strict", strategy: "sliding-window", limit: 1, windowMs: 1000 },
    });

    expect(response.statusCode).toBe(409);
  });

  it("PUT updates an existing policy", async () => {
    const { app, registry } = buildTestApp();
    registry.create("strict", { strategy: "sliding-window", limit: 1, windowMs: 1000 });

    const response = await app.inject({
      method: "PUT",
      url: "/policies/strict",
      headers: { "x-admin-key": ADMIN_KEY },
      payload: { strategy: "sliding-window", limit: 2, windowMs: 1000 },
    });

    expect(response.statusCode).toBe(200);
    expect(registry.get("strict")).toEqual({ strategy: "sliding-window", limit: 2, windowMs: 1000 });
  });

  it("PUT returns 404 for an unknown policy", async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: "PUT",
      url: "/policies/missing",
      headers: { "x-admin-key": ADMIN_KEY },
      payload: { strategy: "sliding-window", limit: 2, windowMs: 1000 },
    });

    expect(response.statusCode).toBe(404);
  });

  it("DELETE removes an existing policy", async () => {
    const { app, registry } = buildTestApp();
    registry.create("strict", { strategy: "sliding-window", limit: 1, windowMs: 1000 });

    const response = await app.inject({
      method: "DELETE",
      url: "/policies/strict",
      headers: { "x-admin-key": ADMIN_KEY },
    });

    expect(response.statusCode).toBe(204);
    expect(registry.get("strict")).toBeUndefined();
  });

  it("DELETE returns 404 for an unknown policy", async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: "DELETE",
      url: "/policies/missing",
      headers: { "x-admin-key": ADMIN_KEY },
    });

    expect(response.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/routes/policies.test.ts`
Expected: FAIL — cannot find module `./policies.js`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/routes/policies.ts
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { PolicyRegistry, PolicyAlreadyExistsError, PolicyNotFoundError } from "../policies/registry.js";
import type { PolicyConfig } from "../strategies/types.js";

interface PoliciesRouteDeps {
  registry: PolicyRegistry;
  adminApiKey: string;
}

function requireAdminKey(deps: PoliciesRouteDeps) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const key = request.headers["x-admin-key"];
    if (key !== deps.adminApiKey) {
      return reply.status(401).send({ error: "invalid or missing admin key" });
    }
  };
}

export function registerPoliciesRoutes(app: FastifyInstance, deps: PoliciesRouteDeps): void {
  app.get("/policies", async () => {
    return { policies: deps.registry.list() };
  });

  app.post<{ Body: { name: string } & PolicyConfig }>(
    "/policies",
    { preHandler: requireAdminKey(deps) },
    async (request, reply) => {
      const { name, ...config } = request.body ?? ({} as { name: string } & PolicyConfig);
      if (typeof name !== "string" || !name) {
        return reply.status(400).send({ error: "name is required" });
      }
      try {
        deps.registry.create(name, config as PolicyConfig);
      } catch (err) {
        if (err instanceof PolicyAlreadyExistsError) {
          return reply.status(409).send({ error: `policy already exists: ${name}` });
        }
        throw err;
      }
      return reply.status(201).send({ name, config });
    }
  );

  app.put<{ Params: { name: string }; Body: PolicyConfig }>(
    "/policies/:name",
    { preHandler: requireAdminKey(deps) },
    async (request, reply) => {
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/routes/policies.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/routes/policies.ts src/routes/policies.test.ts
git commit -m "feat: add admin-keyed policy CRUD routes"
```

---

### Task 11: SSE stats stream route

**Files:**
- Create: `src/routes/stats-stream.ts`
- Test: `src/routes/stats-stream.test.ts`

**Interfaces:**
- Consumes: `CheckEventBus.subscribe(listener): () => void` (Task 7).
- Produces: `registerStatsStreamRoute(app: FastifyInstance, deps: { eventBus: CheckEventBus }): void` — mounts `GET /stats/stream`.

- [ ] **Step 1: Write the failing test**

```ts
// src/routes/stats-stream.test.ts
import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import Fastify, { FastifyInstance } from "fastify";
import { registerStatsStreamRoute } from "./stats-stream.js";
import { CheckEventBus } from "../events.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("GET /stats/stream", () => {
  it("streams check events to connected clients as SSE", async () => {
    const eventBus = new CheckEventBus();
    app = Fastify();
    registerStatsStreamRoute(app, { eventBus });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });

    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = http.get(`${address}/stats/stream`, resolve);
      request.on("error", reject);
    });

    const dataPromise = new Promise<string>((resolve) => {
      response.on("data", (chunk) => resolve(chunk.toString()));
    });

    eventBus.emit({ key: "user-1", policy: "strict", allowed: true, timestamp: 123 });

    const chunk = await dataPromise;
    expect(chunk.startsWith("data: ")).toBe(true);
    expect(chunk).toContain('"key":"user-1"');

    response.destroy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/routes/stats-stream.test.ts`
Expected: FAIL — cannot find module `./stats-stream.js`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/routes/stats-stream.ts
import type { FastifyInstance } from "fastify";
import type { CheckEvent, CheckEventBus } from "../events.js";

interface StatsStreamDeps {
  eventBus: CheckEventBus;
}

export function registerStatsStreamRoute(app: FastifyInstance, deps: StatsStreamDeps): void {
  app.get("/stats/stream", async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const send = (event: CheckEvent) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const unsubscribe = deps.eventBus.subscribe(send);

    request.raw.on("close", () => {
      unsubscribe();
      reply.raw.end();
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/routes/stats-stream.test.ts`
Expected: PASS

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/routes/stats-stream.ts src/routes/stats-stream.test.ts
git commit -m "feat: add SSE /stats/stream route"
```

---

### Task 12: buildApp + entrypoint

**Files:**
- Create: `src/server.ts`
- Test: `src/server.test.ts`
- Create: `src/index.ts`

**Interfaces:**
- Consumes: `registerCheckRoute` (Task 9), `registerPoliciesRoutes` (Task 10), `registerStatsStreamRoute` (Task 11), `PolicyRegistry` (Task 6), `Store` (Task 3), `RateLimiter` (Task 8), `CheckEventBus` (Task 7), `Clock`/`systemClock` (Task 2).
- Produces: `interface BuildAppOptions { clock?: Clock; adminApiKey: string }`, `function buildApp(options: BuildAppOptions): FastifyInstance`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/server.test.ts
import { describe, it, expect } from "vitest";
import { buildApp } from "./server.js";

const ADMIN_KEY = "test-admin-key";

describe("buildApp integration", () => {
  it("enforces a sliding-window policy end to end", async () => {
    const app = buildApp({ adminApiKey: ADMIN_KEY, clock: () => 0 });

    await app.inject({
      method: "POST",
      url: "/policies",
      headers: { "x-admin-key": ADMIN_KEY },
      payload: { name: "strict", strategy: "sliding-window", limit: 1, windowMs: 1000 },
    });

    const first = await app.inject({ method: "POST", url: "/check", payload: { key: "user-1", policy: "strict" } });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({ method: "POST", url: "/check", payload: { key: "user-1", policy: "strict" } });
    expect(second.statusCode).toBe(429);

    await app.close();
  });

  it("returns 404 from /check for an unknown policy", async () => {
    const app = buildApp({ adminApiKey: ADMIN_KEY });

    const response = await app.inject({ method: "POST", url: "/check", payload: { key: "user-1", policy: "missing" } });

    expect(response.statusCode).toBe(404);

    await app.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/server.test.ts`
Expected: FAIL — cannot find module `./server.js`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/server.ts
import Fastify, { FastifyInstance } from "fastify";
import { PolicyRegistry } from "./policies/registry.js";
import { Store } from "./store.js";
import { RateLimiter } from "./rate-limiter.js";
import { CheckEventBus } from "./events.js";
import type { Clock } from "./clock.js";
import { systemClock } from "./clock.js";
import type { SlidingWindowState, TokenBucketState } from "./strategies/types.js";
import { registerCheckRoute } from "./routes/check.js";
import { registerPoliciesRoutes } from "./routes/policies.js";
import { registerStatsStreamRoute } from "./routes/stats-stream.js";

export interface BuildAppOptions {
  clock?: Clock;
  adminApiKey: string;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const clock = options.clock ?? systemClock;
  const registry = new PolicyRegistry();
  const store = new Store<SlidingWindowState | TokenBucketState>();
  const rateLimiter = new RateLimiter(registry, store, clock);
  const eventBus = new CheckEventBus();

  const app = Fastify();

  registerCheckRoute(app, { rateLimiter, eventBus });
  registerPoliciesRoutes(app, { registry, adminApiKey: options.adminApiKey });
  registerStatsStreamRoute(app, { eventBus });

  return app;
}
```

```ts
// src/index.ts
import { buildApp } from "./server.js";

const adminApiKey = process.env.ADMIN_API_KEY;
if (!adminApiKey) {
  throw new Error("ADMIN_API_KEY environment variable is required");
}

const port = Number(process.env.PORT ?? 3000);

const app = buildApp({ adminApiKey });

app
  .listen({ port, host: "0.0.0.0" })
  .then(() => {
    app.log.info(`rate-limiter-service listening on port ${port}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
```

`src/index.ts` is pure bootstrap wiring (env parsing + `listen()`) with no branching logic beyond a required-env-var check already covered indirectly by `buildApp`'s tests — it's exempt from a dedicated test file per the same reasoning YAGNI applies to any file with no real logic.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/server.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: all tests across every file PASS, typecheck PASS

- [ ] **Step 6: Commit**

```bash
git add src/server.ts src/server.test.ts src/index.ts
git commit -m "feat: wire buildApp and add server entrypoint"
```

---

### Task 13: Open the PR

**Files:** none (repo/process step)

- [ ] **Step 1: Confirm a GitHub remote exists**

Run: `git remote -v`
If empty: create the GitHub repo and add the remote, e.g. `gh repo create rate-limiter-service --private --source=. --remote=origin` (adjust visibility as preferred).

- [ ] **Step 2: Push the feature branch**

```bash
git push -u origin feat/initial-implementation
```

- [ ] **Step 3: Open the PR**

```bash
gh pr create --title "Rate limiter service: initial implementation" --body "$(cat <<'EOF'
## Summary
- Sliding window + token bucket rate-limit strategies, in-memory store, admin-keyed policy CRUD, SSE live-stats stream.
- Strict TDD throughout — see commit history for the red/green cycle per component.

## Test plan
- [x] `npm run typecheck`
- [x] `npm test`
EOF
)"
```

- [ ] **Step 4: Run the code-review skill on the branch diff**

Invoke the `code-review` skill against this PR before merging — required by this repo's `CLAUDE.md`, no size exception.

- [ ] **Step 5: Address findings, then merge**

Fix anything the review surfaces (new commits on the same branch), then merge the PR once it's clean.

---

## Spec coverage check

- Store, strategies, policy registry, `/check`, `/policies` CRUD + admin auth, `/stats/stream` SSE — all covered (Tasks 2–12).
- Out-of-scope items from the spec (persistence, distributed limiting, fixed-window, broader auth) are deliberately not implemented anywhere in this plan.
