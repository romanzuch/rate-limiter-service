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
    })
})