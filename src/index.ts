import { buildApp } from "./server.js";

const adminApiKey = process.env.ADMIN_API_KEY;
if (!adminApiKey) {
    throw new Error("ADMIN_API_KEY environment variable is required");
}

const port = Number(process.env.PORT ?? 3000);

const app = buildApp({ adminApiKey });

app
    .listen({ port, host: "0.0.0.0" })
    .then(() => {
        app.log.info(`rate-limiter-service listening on port ${port}`);
    })
    .catch((err) => {
        app.log.error(err);
        process.exit(1);
    });