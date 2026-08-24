import packageMetadata from '../package.json' with { type: 'json' };

export const WORKBENCH_USER_AGENT = `workbench/${packageMetadata.version}`;
