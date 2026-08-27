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
})