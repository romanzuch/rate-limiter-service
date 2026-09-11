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