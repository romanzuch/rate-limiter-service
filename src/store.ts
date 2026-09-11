export class Store<T> {
    private state = new Map<string, Map<string, T>>();

    get(key: string, policy: string): T | undefined {
        return this.state.get(policy)?.get(key);
    }

    set(key: string, policy: string, value: T): void {
        let inner = this.state.get(policy);
        if (inner === undefined) {
            inner = new Map<string, T>();
            this.state.set(policy, inner);
        }
        inner.set(key, value);
    }
}