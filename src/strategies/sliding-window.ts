import { Clock } from "../clock.js";
import { CheckResult, SlidingWindowState } from "./types.js";

export interface SlidingWindowConfig {
    limit: number;
    windowMs: number;
}

export function checkSlidingWindow(
    state: SlidingWindowState | undefined,
    config: SlidingWindowConfig,
    now: Clock
): { result: CheckResult; nextState: SlidingWindowState } {
    const currentTime = now();
    const windowStart = currentTime - config.windowMs;
    const timestamps = (state?.timestamps ?? []).filter((t) => t > windowStart);

    const allowed = timestamps.length < config.limit;
    if (allowed) {
        timestamps.push(currentTime);
    }

    const remaining = Math.max(0, config.limit - timestamps.length);
    const resetAt = timestamps.length > 0 ? timestamps[0] + config.windowMs : currentTime + config.windowMs;

    return {
        result: { allowed, remaining, resetAt, limit: config.limit },
        nextState: { timestamps },
    };
}