const esbuild = require('esbuild');

const production = process.argv.includes('--production');

async function main() {
  await esbuild.build({
    entryPoints: ['mobile-app/server/index.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    target: 'node18',
    outfile: 'dist/server.js',
    external: [
      // Node.js built-ins
      'fs', 'path', 'os', 'http', 'crypto', 'events', 'stream', 'net', 'url',
      // Native modules that can't be bundled
      'pngjs',
    ],
    logLevel: 'info',
  });

  console.log('✓ Server bundled to dist/server.js');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
