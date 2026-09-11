import { describe, it, expect, vi } from "vitest";
import { CheckEventBus } from "./events.js";

describe("CheckEventBus", () => {
    it("delivers emitted events to subscribers", () => {
        const bus = new CheckEventBus();
        const listener = vi.fn();
        bus.subscribe(listener);

        const event = { key: "user-1", policy: "strict", allowed: true, timestamp: 123 };
        bus.emit(event);

        expect(listener).toHaveBeenCalledWith(event);
    });

    it("stops delivering events after unsubscribe", () => {
        const bus = new CheckEventBus();
        const listener = vi.fn();
        const unsubscribe = bus.subscribe(listener);
        unsubscribe();

        bus.emit({ key: "user-1", policy: "strict", allowed: true, timestamp: 123 });

        expect(listener).not.toHaveBeenCalled();
    })

    it("supports multiple independent subscribes", () => {
        const bus = new CheckEventBus();
        const listenerA = vi.fn();
        const listenerB = vi.fn();
        bus.subscribe(listenerA);
        bus.subscribe(listenerB);

        bus.emit({ key: "user-1", policy: "strict", allowed: true, timestamp: 123 });

        expect(listenerA).toHaveBeenCalledTimes(1);
        expect(listenerB).toHaveBeenCalledTimes(1);
    })
})