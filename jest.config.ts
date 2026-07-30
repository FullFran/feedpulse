import type { Config } from 'jest';

// The explicit `.ts` extension is required: Jest loads a TypeScript config
// through Node's ESM resolver, which does not add extensions.
import integrationConfig from './jest.integration.config.ts';
import unitConfig from './jest.unit.config.ts';

/**
 * Root Jest config: the union of the two projects.
 *
 *   npm test              -> both projects, serially (this file)
 *   npm run test:unit     -> jest.unit.config.ts, in parallel workers (~3s)
 *   npm run test:integration -> jest.integration.config.ts, serially
 *
 * The two projects partition the suite exactly: every spec runs once and only
 * once across them. See jest.unit.config.ts for the naming convention that
 * decides which project a file lands in.
 *
 * `coverageThreshold` only takes effect in the ROOT config when `projects` is
 * used, which is why it lives here rather than in either project.
 */
const config: Config = {
  rootDir: '.',
  projects: [unitConfig, integrationConfig],
  collectCoverageFrom: ['src/**/*.ts'],
  // A ratchet, never a target. The floor is the run WITHOUT TEST_DATABASE_URL,
  // because that is the weakest run anyone can perform: the database-gated
  // suites skip and coverage drops. Both runs re-measured on 2026-07-30 after
  // the bulk format + autofix commit:
  //
  //   no database  : statements 79.28  branches 67.05  functions 70.28  lines 78.70
  //   with database: statements 85.70  branches 71.74  functions 81.15  lines 85.26
  //
  // Thresholds sit ~1 point under the DB-less numbers so `npm run test:cov` is
  // green locally and in CI. Raise them when coverage rises; never lower them
  // to get a build green.
  coverageThreshold: {
    global: { statements: 78, branches: 66, functions: 69, lines: 77 },
  },
};

export default config;
