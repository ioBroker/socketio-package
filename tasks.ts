import { writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const req = createRequire(import.meta.url);
const _dirname = dirname(fileURLToPath(import.meta.url));

const socket = req.resolve('socket.io-client').replace(/\\/g, '/');
// node_modules/socket.io-client/build/cjs/index.js
const parts = socket.split('/');
parts.pop();
parts.pop();

// v2
writeFileSync(`${_dirname}/build/lib/socket.io.js`, readFileSync(`${parts.join('/')}/dist/socket.io.js`));
