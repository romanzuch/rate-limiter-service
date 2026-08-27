import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { PolicyRegistry, PolicyAlreadyExistsError, PolicyNotFoundError } from "../policies/registry.js";
import type { PolicyConfig } from "../strategies/types.js";

interface PoliciesRouteDeps {
    registry: PolicyRegistry;
    adminApiKey: string;
}

function requireAdminKey(deps: PoliciesRouteDeps) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        const key = request.headers["x-admin-key"];
        if (key != deps.adminApiKey) {
            return reply.status(401).send({ error: "invalid or missing admin key" });
        }
    };
}

export function registerPoliciesRoutes(app: FastifyInstance, deps: PoliciesRouteDeps): void {
    app.get("/policies", async () => {
        return { policies: deps.registry.list() };
    });

    app.post<{ Body: { name: string } & PolicyConfig }>(
        "/policies",
        { preHandler: requireAdminKey(deps) },
        async (request, reply) => {
            const { name, ...config } = request.body ?? ({} as { name: string } & PolicyConfig);
            if (typeof name !== "string" || !name) {
                return reply.status(400).send({ error: "name is required" });
            }
            try {
                deps.registry.create(name, config as PolicyConfig);
            } catch (err) {
                if (err instanceof PolicyAlreadyExistsError) {
                    return reply.status(409).send({ error: `policy already exists: ${name}` });
                }
                throw err;
            }
            return reply.status(201).send({ name, config });
        }
    );

    app.put<{ Params: { name: string }; Body: PolicyConfig }>(
        "/policies/:name",
        { preHandler: requireAdminKey(deps) },
        async (request, reply) => {
            try {
                deps.registry.update(request.params.name, request.body);
            } catch (err) {
                if (err instanceof PolicyNotFoundError) {
                    return reply.status(404).send({ error: `unknown policy: ${request.params.name}` });
                }
                throw err;
            }
            return reply.status(200).send({ name: request.params.name, config: request.body });
        }
    );

    app.delete<{ Params: { name: string } }>(
        "/policies/:name",
        { preHandler: requireAdminKey(deps) },
        async (request, reply) => {
            try {
            deps.registry.delete(request.params.name);
            } catch (err) {
            if (err instanceof PolicyNotFoundError) {
                return reply.status(404).send({ error: `unknown policy: ${request.params.name}` });
            }
            throw err;
            }
            return reply.status(204).send();
        }
    );
}