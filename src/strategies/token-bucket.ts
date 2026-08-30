import { Clock } from "../clock.js";
import { CheckResult, TokenBucketState } from "./types.js";

export interface TokenBucketConfig {
    capacity: number;
    refillRatePerMs: number;
}

export function checkTokenBucket(
    state: TokenBucketState | undefined,
    config: TokenBucketConfig,
    now: Clock
): { result: CheckResult; nextState: TokenBucketState } {
    const currentTime = now();
    const previous = state ?? { tokens: config.capacity, lastRefillAt: currentTime };

    const elapsedMs = Math.max(0, currentTime - previous.lastRefillAt);
    const refilled = Math.min(config.capacity, previous.tokens + elapsedMs * config.refillRatePerMs);

    const allowed = refilled >= 1;
    const tokens = allowed ? refilled - 1 : refilled;

    const deficit = Math.max(0, 1 - tokens);
    const resetAt = config.refillRatePerMs > 0 ? currentTime + deficit / config.refillRatePerMs : currentTime;

    return {
        result: { allowed, remaining: Math.floor(tokens), resetAt, limit: config.capacity },
        nextState: { tokens, lastRefillAt: currentTime },
    };
}