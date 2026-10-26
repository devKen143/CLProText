// Read-only, offline comparison. Inputs contain metadata only; no tokens or bodies.
import {readFileSync} from 'node:fs';
const [rowsPath,objectsPath] = process.argv.slice(2);
if (!rowsPath || !objectsPath) throw new Error('Usage: node scripts/audit-vault-orphans.mjs rows.json objects.json');
const rows = JSON.parse(readFileSync(rowsPath,'utf8'));
const objects = JSON.parse(readFileSync(objectsPath,'utf8'));
if (!Array.isArray(rows) || !Array.isArray(objects) || rows.some(r=>typeof r.blob_key !== 'string') || objects.some(o=>typeof o.key !== 'string')) throw new Error('Expected rows [{blob_key}] and objects [{key}]. Supply all pagination pages.');
const referenced = new Set(rows.map(r=>r.blob_key));
const stored = new Set(objects.map(o=>o.key));
console.log(JSON.stringify({unreferencedObjects:objects.filter(o=>!referenced.has(o.key)).map(o=>o.key),missingObjects:rows.filter(r=>!stored.has(r.blob_key)).map(r=>r.blob_key)},null,2));
