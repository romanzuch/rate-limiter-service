import type { PolicyConfig } from "../strategies/types.js";

export function isValidPolicyConfig(input: unknown): input is PolicyConfig {
    if (typeof input !== "object" || input === null) {
        return false;
    }
    
    const config = input as Record<string, unknown>;

    if (config.strategy === "sliding-window") {
        const { limit, windowMs } = config;
        return (
            typeof limit === "number" &&
            Number.isFinite(limit) &&
            limit >= 1 &&
            typeof windowMs === "number" &&
            Number.isFinite(windowMs) &&
            windowMs >= 1
        );
    }

    if (config.strategy === "token-bucket") {
        const { capacity, refillRatePerMs } = config;
        return (
            typeof capacity === "number" &&
            Number.isFinite(capacity) &&
            capacity >= 1 &&
            typeof refillRatePerMs === "number" &&
            Number.isFinite(refillRatePerMs) &&
            refillRatePerMs >= 0
        );
    }

    return false;
}