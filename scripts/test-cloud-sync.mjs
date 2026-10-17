import {build} from 'esbuild';
import {mkdir} from 'node:fs/promises';
await mkdir('.sites-runtime',{recursive:true});
await build({entryPoints:['scripts/test-cloud-sync.ts'],outfile:'.sites-runtime/test-cloud-sync.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
await import('../.sites-runtime/test-cloud-sync.mjs?run='+Date.now());
