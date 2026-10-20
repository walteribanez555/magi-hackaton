const esbuild = require('esbuild');

const isProduction = process.argv.includes('--prod');

// Lambda: el runtime trae el AWS SDK v3 (solo se usa si MOCK_TABLE_NAME está definido).
const awsSdkExternalPlugin = {
  name: 'aws-sdk-external',
  setup(build) {
    build.onResolve({ filter: /^(aws-sdk|@aws-sdk)(\/|$)/ }, (args) => ({ path: args.path, external: true }));
  },
};

const base = {
  bundle: true,
  minify: isProduction,
  sourcemap: !isProduction,
  target: 'node22',
  platform: 'node',
  format: 'cjs',
  logLevel: 'info',
};

const builds = [
  { ...base, plugins: [awsSdkExternalPlugin], entryPoints: ['src/index.ts'], outfile: 'dist/index.js' },
  { ...base, entryPoints: ['src/main.ts'], outfile: 'dist/main.js' },
];

(async () => {
  for (const b of builds) {
    await esbuild.build(b);
    console.log(`✓ Built ${b.outfile}`);
  }
})().catch((err) => {
  console.error('✗ Build failed:', err);
  process.exit(1);
});
