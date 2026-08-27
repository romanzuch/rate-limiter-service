import Fastify, { FastifyInstance } from "fastify";
import { PolicyRegistry } from "./policies/registry.js";
import { Store } from "./store.js";
import { RateLimiter } from "./rate-limiter.js";
import { CheckEventBus } from "./events.js";
import type { Clock } from "./clock.js";
import { systemClock } from "./clock.js";
import type { SlidingWindowState, TokenBucketState } from "./strategies/types.js";
import { registerCheckRoute } from "./routes/check.js";
import { registerPoliciesRoutes } from "./routes/policies.js";
import { registerStatsStreamRoute } from "./routes/stats-stream.js";

export interface BuildAppOptions {
    clock?: Clock;
    adminApiKey: string;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
    const clock = options.clock ?? systemClock;
    const registry = new PolicyRegistry();
    const store = new Store<SlidingWindowState | TokenBucketState>();
    const rateLimiter = new RateLimiter(registry, store, clock);
    const eventBus = new CheckEventBus();

    const app = Fastify();

    registerCheckRoute(app, { rateLimiter, eventBus });
    registerPoliciesRoutes(app, { registry, adminApiKey: options.adminApiKey });
    registerStatsStreamRoute(app, { eventBus });

    return app;
}