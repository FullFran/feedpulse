import type { Config } from 'jest';

/**
 * Specs that carry an `.spec.ts` name but are not unit tests.
 *
 * Convention in this repository:
 *   *.spec.ts             -> pure unit test: no pg-mem, no Nest bootstrap, no database
 *   *.integration-spec.ts -> pg-mem, a Nest TestingModule, or a real PostgreSQL
 *
 * These files predate the convention. They bootstrap a full Nest container or a
 * pg-mem database, which is what makes the difference between a unit run that
 * finishes in a couple of seconds and one that does not, and the database-backed
 * ones must not run in parallel with each other. Until they are renamed they are
 * routed to the integration project instead, so every test still runs exactly
 * once across the two projects.
 *
 * Do not add a new entry here: name a new heavy spec `*.integration-spec.ts`.
 */
export const HEAVY_SPEC_PATHS: readonly string[] = [
  '<rootDir>/test/api-key-auth.spec.ts',
  '<rootDir>/test/migrations-runner.spec.ts',
  '<rootDir>/test/persistence-readiness.spec.ts',
  '<rootDir>/test/release-stuck-feeds.spec.ts',
];

const config: Config = {
  displayName: 'unit',
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  // `.spec.ts` only. The negative lookbehind keeps `.integration-spec.ts` out.
  testRegex: '.*(?<!integration-)spec\\.ts$',
  testPathIgnorePatterns: [
    '/node_modules/',
    // Helpers, not suites: Jest would fail them as files without tests.
    '/test/support/',
    ...HEAVY_SPEC_PATHS,
  ],
  transform: {
    // `isolatedModules` puts ts-jest on `transpileModule` instead of the language
    // service, and `diagnostics: false` drops type checking from the test run.
    // Measured on this project with a cleared cache: 11.96s -> 3.78s wall.
    //
    // This is only safe because type errors are still caught, by `npm run
    // typecheck` and by CI. The two must stay together: drop the typecheck script
    // and type errors reach main.
    //
    // ts-jest deprecates this option in favour of the compiler flag of the same
    // name, and prints a warning on every run because of it. Do NOT migrate it:
    // `isolatedModules` in tsconfig.json is incompatible with this codebase's
    // `emitDecoratorMetadata` (measured: 60+ TS1272 errors), and the `import
    // type` rewrite it demands would erase the runtime metadata Nest's DI reads.
    '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: 'tsconfig.json', isolatedModules: true, diagnostics: false }],
  },
  collectCoverageFrom: ['src/**/*.ts'],
};

export default config;
