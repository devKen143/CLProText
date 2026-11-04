import {build} from 'esbuild';
import {mkdir} from 'node:fs/promises';
await mkdir('.sites-runtime',{recursive:true});
await build({entryPoints:['scripts/test-share.ts'],outfile:'.sites-runtime/test-share.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
await import('../.sites-runtime/test-share.mjs');
