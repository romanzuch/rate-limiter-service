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
    })

    it("prunes timestamps outside the window, allowing requests again", () => {
        const config = { limit: 2, windowMs: 1000 };
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
    })
})