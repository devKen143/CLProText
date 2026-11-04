import {build} from 'esbuild';
import {mkdir} from 'node:fs/promises';
await mkdir('.sites-runtime',{recursive:true});
await build({entryPoints:['scripts/test-recovery.ts'],outfile:'.sites-runtime/test-recovery.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
await import('../.sites-runtime/test-recovery.mjs');
