import EventEmitter from "node:events";

export interface CheckEvent {
    key: string;
    policy: string;
    allowed: boolean; 
    timestamp: number;
}

export class CheckEventBus {
    private emitter = new EventEmitter();

    emit(event: CheckEvent): void {
        this.emitter.emit("check", event);
    }

    subscribe(listener: (event: CheckEvent) => void): () => void {
        this.emitter.on("check", listener);
        return () => this.emitter.off("check", listener);
    }
}