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