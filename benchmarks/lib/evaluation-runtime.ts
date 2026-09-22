import { quote } from './runtime.ts';

/** A neutral, credential-free command boundary; never launches an actor model. */
export function evaluationRuntimeScript(
    image: string,
    work: string,
    project: string,
    hostDocker: boolean
): string {
    if (!/^sha256:[a-f0-9]{64}$/.test(image))
        throw new Error('Evaluation image must be immutable');
    return (
        '#!/bin/sh\nset -eu\n' +
        [
            `exec docker run --rm --init --network host --read-only --tmpfs /tmp:rw,nosuid,nodev,mode=1777 --user 0:0`,
            `-e TMPDIR=/tmp -e HOME=${quote(`${work}/evaluation-home`)} -v ${quote(`${project}:${project}`)} -v ${quote(`${work}/evaluation-home:${work}/evaluation-home`)} -w ${quote(project)}`,
            ...(hostDocker
                ? [
                      '-v /run/workbenchmark/docker.sock:/var/run/docker.sock -e DOCKER_HOST=unix:///var/run/docker.sock',
                  ]
                : []),
            `${quote(image)} "$@"`,
        ].join(' ') +
        '\n'
    );
}
