import { PolicyConfig } from "../strategies/types.js";

export interface Policy {
    name: string;
    config: PolicyConfig;
}

export class PolicyAlreadyExistsError extends Error {}
export class PolicyNotFoundError extends Error {}

export class PolicyRegistry {
    private policies = new Map<string, PolicyConfig>();

    list(): Policy[] {
        return [...this.policies.entries()].map(([name, config]) => ({ name, config}))
    }

    get(name: string): PolicyConfig | undefined {
        return this.policies.get(name);
    }

    create(name: string, config: PolicyConfig): void {
        if (this.policies.has(name)) {
            throw new PolicyAlreadyExistsError(name);
        }
        this.policies.set(name, config);
    }

    update(name: string, config: PolicyConfig): void {
        if (!this.policies.has(name)) {
            throw new PolicyNotFoundError(name);
        }
        this.policies.set(name, config);
    }

    delete(name: string): void {
        if (!this.policies.has(name)) {
            throw new PolicyNotFoundError(name);
        }
        this.policies.delete(name);
    }
}