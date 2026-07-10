import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
// npm dependencies stay external (shipped via node_modules in the release zip);
// relative imports and @shared/* are bundled into dist/index.js.
const external = Object.keys(pkg.dependencies ?? {});

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  outfile: 'dist/index.js',
  external,
  sourcemap: true,
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});

console.log('server built -> dist/index.js');
