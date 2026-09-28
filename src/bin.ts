#!/usr/bin/env node
import { generatorHandler } from '@prisma/generator-helper';
import { generateClient } from './generator';

generatorHandler({
    onManifest() {
        return {
            defaultOutput: '../generated/lean-client',
            prettyName: 'Prisma Lean Client',
            requiresGenerators: [],
        };
    },
    async onGenerate(options) {
        await generateClient(options);
    },
});
