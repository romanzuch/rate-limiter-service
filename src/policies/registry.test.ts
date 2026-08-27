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