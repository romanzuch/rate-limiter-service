import type { FastifyInstance } from "fastify";
import type { CheckEvent, CheckEventBus } from "../events.js";

interface StatsStreamDeps {
    eventBus: CheckEventBus;
}

export function registerStatsStreamRoute(app: FastifyInstance, deps: StatsStreamDeps): void {
    app.get("/stats/stream", async (request, reply) => {
        reply.hijack();
        reply.raw.writeHead(200, {
            "Content-Type": "text/event-stream", 
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        });

        reply.raw.flushHeaders();

        const send = (event: CheckEvent) => {
            reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        };

        const unsubscribe = deps.eventBus.subscribe(send);

        request.raw.on("close", () => {
            unsubscribe();
            reply.raw.end();
        });
    });
}