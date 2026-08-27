import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { registerPoliciesRoutes } from "./policies.js";
import { PolicyRegistry } from "../policies/registry.js";

const ADMIN_KEY = "test-admin-key"

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
            payload: { name: "strict", strategy: "slidin-window", limit: 1, windowMs: 1000 },
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
})