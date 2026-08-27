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
            payload: { key: "user-1", policy: "strict" }
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
})