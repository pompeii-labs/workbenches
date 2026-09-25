import type { LuxError } from '@luxdb/sdk';

export type PossibleErrors = {
    LuxError: LuxError;
    ZodError: object;
    CustomError: {
        message: string;
    };
};

export type CustomError<T extends keyof PossibleErrors = keyof PossibleErrors> = {
    [K in T]: {
        name: K;
    } & PossibleErrors[K];
}[T];

export type ErrorResult<T = CustomError> = {
    success: false;
    error: T;
};

export type SuccessResult<T> = {
    success: true;
    data: T;
};

export type Result<T> = SuccessResult<T> | ErrorResult;

export function buildSuccess<T>(data: T): SuccessResult<T> {
    return {
        success: true,
        data,
    };
}

export function buildError<T extends keyof PossibleErrors>(
    name: T,
    error: PossibleErrors[T]
): ErrorResult<CustomError<T>> {
    return {
        success: false,
        error: {
            name,
            ...error,
        } as CustomError<T>,
    };
}
