import path from 'node:path';
import { defineConfig } from 'vitest/config';

const root = import.meta.dirname;

/** Pure logic. Database-backed modules are covered by vitest.integration.config.ts. */
export default defineConfig({
  // Next keeps JSX as is; tests that render components need it compiled.
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: {
      '@': path.resolve(root, 'src'),
      'server-only': path.resolve(root, 'tests/stubs/server-only.ts'),
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: [
        'src/server/security/**/*.ts',
        'src/server/tenants/host.ts',
        'src/server/validation.ts',
        'src/server/livekit.ts',
        'src/server/http.ts',
        'src/server/config.ts',
        'src/server/plans.ts',
        'src/server/tools/http-tool.ts',
        'src/server/rooms/hand.ts',
        'src/lib/board-text.ts',
        'src/lib/models.ts',
        'src/server/integrations/voices.ts',
        'src/server/knowledge/text.ts',
      ],
      thresholds: { lines: 95, branches: 85 },
    },
  },
});
