import type { Config } from 'jest';

// The explicit `.ts` extension is required: Jest loads a TypeScript config
// through Node's ESM resolver, which does not add extensions.
import { HEAVY_SPEC_PATHS } from './jest.unit.config.ts';

/**
 * Everything that boots a Nest container, a pg-mem database, or a real
 * PostgreSQL: `*.integration-spec.ts` plus the legacy `*.spec.ts` files listed
 * in `HEAVY_SPEC_PATHS`.
 *
 * This project is meant to be run serially (`--runInBand`). Several suites point
 * at the same throwaway database through `TEST_DATABASE_URL` and would otherwise
 * race each other's schema resets.
 */
const config: Config = {
  displayName: 'integration',
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  testMatch: ['<rootDir>/test/**/*.integration-spec.ts', ...HEAVY_SPEC_PATHS],
  testPathIgnorePatterns: ['/node_modules/', '/test/support/'],
  transform: {
    // Same rationale and the same caveat as jest.unit.config.ts: transpile only,
    // type-check in `npm run typecheck`.
    '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: 'tsconfig.json', isolatedModules: true, diagnostics: false }],
  },
  collectCoverageFrom: ['src/**/*.ts'],
};

export default config;
