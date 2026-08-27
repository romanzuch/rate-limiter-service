import { describe, it, expect } from "vitest";
import { systemClock } from "./clock.js";

describe("systemClock", () => {
  it("returns the current time in milliseconds", () => {
    const before = Date.now();
    const result = systemClock();
    const after = Date.now();

    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThanOrEqual(after);
  });
});