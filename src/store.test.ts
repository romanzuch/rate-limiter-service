import { describe, it, expect } from "vitest";
import { Store } from "./store.js";

describe("Store", () => {
    it("returns undefined for a key that has no been set", () => {
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
        store.set("user-1", "policy-b", { count: 5 });

        expect(store.get("user-1", "policy-a")).toEqual({ count: 1 });
        expect(store.get("user-1", "policy-b")).toEqual({ count: 5 });
    });

    it("keeps state isolated when a policy or key contains the '::' delimiter", () => {
        const store = new Store<{ count: number }>();
        store.set("b::c", "a", { count: 1 });
        store.set("c", "a::b", { count: 2 });

        expect(store.get("b::c", "a")).toEqual({ count: 1 });
        expect(store.get("c", "a::b")).toEqual({ count: 2 });
    })
})