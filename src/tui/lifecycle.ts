export async function holdRendererUntilShutdown(options: {
    mount: () => Promise<void>;
    shutdown: Promise<void>;
    destroy: () => void;
}): Promise<void> {
    try {
        await options.mount();
        await options.shutdown;
    } catch (error) {
        options.destroy();
        await options.shutdown;
        throw error;
    }
}
