import { PolicyRegistry, PolicyNotFoundError } from "./policies/registry.js";
import { Store } from "./store.js";
import { checkSlidingWindow } from "./strategies/sliding-window.js";
import { checkTokenBucket } from "./strategies/token-bucket.js";
import type { Clock } from "./clock.js";
import type { CheckResult, SlidingWindowState, TokenBucketState } from "./strategies/types.js";

export class RateLimiter {
    constructor(
        private registry: PolicyRegistry, 
        private store: Store<SlidingWindowState | TokenBucketState>,
        private now: Clock
    ) {}

    check(key: string, policyName: string): CheckResult {
        const config = this.registry.get(policyName);
        if (!config) {
            throw new PolicyNotFoundError(policyName);
        }

        const state = this.store.get(key, policyName);

        if (config.strategy === "sliding-window") {
            const { result, nextState } = checkSlidingWindow(state as SlidingWindowState | undefined, config, this.now);
            this.store.set(key, policyName, nextState);
            return result;
        }

        const { result, nextState } = checkTokenBucket(state as TokenBucketState | undefined, config, this.now);
        this.store.set(key, policyName, nextState);
        return result;
    }
}