// Bundles the optimizer for the browser into core.js (next to index.html). Expects an Idleon
// Toolbox checkout, with npm install done, in a folder named app next to this repo.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..', '..', 'app');
const esbuild = createRequire(join(appDir, 'package.json'))('esbuild');

const result = await esbuild.build({
  entryPoints: [join(here, 'web.js')],
  outfile: join(here, '..', 'core.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  minify: true,
  legalComments: 'none',
  tsconfig: join(appDir, 'tsconfig.json'),
  nodePaths: [join(appDir, 'node_modules')],
  loader: { '.js': 'jsx' },
  jsx: 'automatic',
  logLevel: 'warning',
  metafile: true
});
const bytes = Object.values(result.metafile.outputs)[0].bytes;
console.log(`Built core.js (${(bytes / 1e6).toFixed(1)} MB)`);
