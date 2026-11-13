import path from 'node:path';
import { defineConfig } from 'vitest/config';

const root = import.meta.dirname;

/** Runs against a real, disposable Postgres given by TEST_DATABASE_URL. */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(root, 'src'),
      'server-only': path.resolve(root, 'tests/stubs/server-only.ts'),
    },
  },
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: [
        'src/server/{auth,rooms,lobby,moderation,users,admin,domains,superadmin,studio}/**/*.ts',
        'src/server/live/{service,youtube}.ts',
        'src/server/room-state.ts',
        'src/server/tenants/repo.ts',
        'src/server/audit.ts',
        'src/server/plans.ts',
      ],
      thresholds: { lines: 95, branches: 85 },
    },
  },
});
