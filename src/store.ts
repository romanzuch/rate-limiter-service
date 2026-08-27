export class Store<T> {
    private state = new Map<string, T>();

    private makeKey(key: string, policy: string): string {
        return `${policy}::${key}`
    }

    get(key: string, policy: string): T | undefined {
        return this.state.get(this.makeKey(key, policy));
    }

    set(key: string, policy: string, value: T): void {
        this.state.set(this.makeKey(key, policy), value);
    }
}