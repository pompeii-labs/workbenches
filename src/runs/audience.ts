export class RunAudience {
    readonly #clients = new Set<string>();
    #waitingForFirstClient = false;

    initialize(interactive: boolean, hasInitialTask: boolean): void {
        this.#waitingForFirstClient = interactive && !hasInitialTask;
    }

    attach(clientId: string): void {
        this.#waitingForFirstClient = false;
        this.#clients.add(clientId);
    }

    detach(clientId: string): void {
        this.#waitingForFirstClient = false;
        this.#clients.delete(clientId);
    }

    get keepsRunOpen(): boolean {
        return this.#waitingForFirstClient || this.#clients.size > 0;
    }
}
