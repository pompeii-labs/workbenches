/** The runtimes `wb connect` can prepare credentials for. */
export const connectionRuntimes = ['local', 'docker', 'e2b', 'daytona'] as const;

/** A runtime `wb connect` can prepare credentials for. */
export type ConnectionRuntime = (typeof connectionRuntimes)[number];

/** One way to authenticate a model provider through a runner. */
export interface ConnectionAuthenticationMethod {
    id: string;
    label: string;
    nativeProvider: string;
    nativeMethod?: string;
    authenticationMethod: 'api' | 'oauth' | 'native';
}
