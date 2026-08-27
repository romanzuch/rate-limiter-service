export type PolicyConfig = 
    | { strategy: "sliding-window"; limit: number; windowMs: number }
    | { strategy: "token-bucket"; capacity: number; refillRatePerMs: number };

export interface CheckResult {
    allowed: boolean;
    remaining: number;
    resetAt: number;
    limit: number;
}

export interface SlidingWindowState {
    timestamps: number[];
}

export interface TokenBucketState {
    tokens: number;
    lastRefullAt: number;
}