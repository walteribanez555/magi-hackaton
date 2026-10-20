const esbuild = require('esbuild');

const isProduction = process.argv.includes('--prod');
const target = process.argv.find((a) => a.startsWith('--target='))?.split('=')[1];

// El runtime de Lambda (Node 22+) ya trae el AWS SDK v3: se externaliza para no inflar el bundle.
// `pg-native` es un require opcional de `pg` que no usamos.
const awsSdkExternalPlugin = {
  name: 'aws-sdk-external',
  setup(build) {
    build.onResolve({ filter: /^(aws-sdk|@aws-sdk)(\/|$)/ }, (args) => ({ path: args.path, external: true }));
  },
};

const baseConfig = {
  bundle: true,
  minify: isProduction,
  sourcemap: !isProduction,
  target: 'node22',
  platform: 'node',
  format: 'cjs',
  external: ['pg-native'],
  logLevel: 'info',
};

const lambda = { ...baseConfig, plugins: [awsSdkExternalPlugin] };

const builds = {
  // API HTTP (Hono) detrás de API Gateway v2
  lambda: { ...lambda, entryPoints: ['src/index.ts'], outfile: 'dist/index.js' },
  // DynamoDB Streams → PostgreSQL (réplica analítica)
  projector: { ...lambda, entryPoints: ['src/projector.ts'], outfile: 'dist/projector.js' },
  // Migraciones SQL (CDK Trigger en cada deploy)
  migrator: { ...lambda, entryPoints: ['src/migrator.ts'], outfile: 'dist/migrator.js' },
  // Servidor local (@hono/node-server): aquí no hay SDK en el runtime → se bundlea todo
  main: { ...baseConfig, entryPoints: ['src/main.ts'], outfile: 'dist/main.js' },
};

const build = async () => {
  const targets = target ? [target] : Object.keys(builds);
  for (const t of targets) {
    if (!builds[t]) {
      console.error(`✗ Unknown target: ${t}. Available: ${Object.keys(builds).join(', ')}`);
      process.exit(1);
    }
    await esbuild.build(builds[t]);
    console.log(`✓ Built ${t}: ${builds[t].outfile}`);
  }
  console.log(`  Environment: ${isProduction ? 'production (minified)' : 'development (sourcemap)'}`);
};

build().catch((error) => {
  console.error('✗ Build failed:', error);
  process.exit(1);
});

module.exports = { builds, build };
