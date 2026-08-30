import type { FastifyInstance } from "fastify";
import type { RateLimiter } from "../rate-limiter.js";
import type { CheckEventBus } from "../events.js";
import { PolicyNotFoundError } from "../policies/registry.js";

interface CheckRouteDeps {
    rateLimiter: RateLimiter;
    eventBus: CheckEventBus;
}

interface CheckBody {
    key: string;
    policy: string;
}

export function registerCheckRoute(app: FastifyInstance, deps: CheckRouteDeps): void {
    app.post<{ Body: CheckBody }>("/check", async (request, reply) => {
        const body = request.body ?? ({} as CheckBody);
        const { key, policy } = body;

        if (typeof key !== "string" || typeof policy !== "string") {
            return reply.status(400).send({ error: "key and policy are required strings" });
        }

        let result;
        try {
            result = deps.rateLimiter.check(key, policy);
        } catch (err) {
            if (err instanceof PolicyNotFoundError) {
                return reply.status(404).send({ error: `unknown policy: ${policy}` });
            }
            throw err;
        }

        deps.eventBus.emit({ key, policy, allowed: result.allowed, timestamp: Date.now() });

        reply.header("X-RateLimit-Limit", result.limit);
        reply.header("X-RateLimit-Remaining", result.remaining);
        reply.header("X-RateLimit-Reset", result.resetAt);

        if (!result.allowed) {
            reply.header("Retry-After", Math.max(0, Math.ceil((result.resetAt - Date.now()) / 1000)));
            return reply.status(429).send({ allowed: false, retryAfter: result.resetAt });
        }

        return reply.status(200).send({ allowed: true, remaining: result.remaining, resetAt: result.resetAt });
    });
}