import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
      '@ui': fileURLToPath(new URL('./src/ui', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    // Tiered suites. VITEST_TIER selects which files run so that day to day development
    // uses the fast tier and the long world simulations run separately.
    //   fast   unit tests only
    //   flow   unit tests plus the player flow suite, the pre-commit suite in practice
    //   normal unit plus integration
    //   all    everything including multi year world simulation
    include:
      process.env.VITEST_TIER === 'fast'
        ? ['src/**/*.unit.test.ts']
        : process.env.VITEST_TIER === 'flow'
          ? ['src/**/*.unit.test.ts', 'src/core/playerflow.int.test.ts', 'src/core/careerflow.int.test.ts', 'src/core/release.int.test.ts']
          : process.env.VITEST_TIER === 'world'
            ? ['src/**/*.world.test.ts']
            : process.env.VITEST_TIER === 'all'
              ? ['src/**/*.test.ts']
              : ['src/**/*.unit.test.ts', 'src/**/*.int.test.ts'],
    testTimeout: 120000,
    hookTimeout: 120000,
  },
});
