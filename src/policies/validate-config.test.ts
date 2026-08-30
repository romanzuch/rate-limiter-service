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
})