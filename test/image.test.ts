import { afterEach, describe, expect, test } from 'bun:test';

import { imageReference } from '../src/commands/image.js';
import { setRegistryApiUrl } from '../src/registry.js';

afterEach(() => setRegistryApiUrl(undefined));

describe('Workbench image references', () => {
    test('uses the production OCI registry host by default', () => {
        expect(imageReference('pompeii-labs', 'creator', '0.1.0')).toBe(
            'images.workbenches.dev/pompeii-labs/creator:0.1.0'
        );
    });

    test('uses the configured development registry host', () => {
        setRegistryApiUrl('https://pompeii.ngrok.app');
        expect(imageReference('pompeii-labs', 'creator', 'latest')).toBe(
            'pompeii.ngrok.app/pompeii-labs/creator:latest'
        );
    });

    test('rejects invalid image names and tags', () => {
        expect(() => imageReference('pompeii-labs', 'Bad Name', 'latest')).toThrow(
            'Invalid registry image name'
        );
        expect(() => imageReference('pompeii-labs', 'creator', 'bad tag')).toThrow(
            'Invalid registry image tag'
        );
    });
});
