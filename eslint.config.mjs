// @ts-check
import js from '@eslint/js';
import importPlugin from 'eslint-plugin-import-x';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Flat ESLint config for FeedPulse.
 *
 * Layout mirrors the way the tree is actually compiled:
 *  - `src/**` and `test/**` are covered by `tsconfig.json`, so they get the
 *    full type-aware ruleset (the rules that catch real bugs: floating
 *    promises, misused promises, non-awaited thenables).
 *  - `scripts/**` and the `jest*.config.ts` files are outside the tsconfig
 *    `include`, so they get the syntactic ruleset only. Promote them to the
 *    type-aware block once they are added to `tsconfig.json#include`.
 *  - `eslint-config-prettier` is applied LAST so formatting is owned by
 *    Prettier alone and never argued about by ESLint.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'artifacts/**',
      // Agent/skill scaffolding and templates: not project source.
      '.agents/**',
      '.atl/**',
      // Browser bundle shipped as-is; not part of the TypeScript build.
      'public/dashboard/app.js',
    ],
  },

  js.configs.recommended,

  // --- Type-aware core: everything the TypeScript build knows about --------
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: globals.node,
    },
    plugins: { 'import-x': importPlugin },
    rules: {
      // Bug-catching rules. These are the reason type-aware linting is worth
      // its runtime cost, so they stay at `error`.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-array-delete': 'error',
      '@typescript-eslint/no-for-in-array': 'error',
      '@typescript-eslint/no-implied-eval': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/unbound-method': 'error',

      // Keeps `import type` explicit so the CommonJS emit never accidentally
      // requires a module that only exists for its types.
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'separate-type-imports' }],

      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],

      // `any` is a smell, not a build break: the raw-`pg` repositories hand
      // back `any` rows by design and NestJS decorator metadata leaks it too.
      '@typescript-eslint/no-explicit-any': 'warn',

      // Null-object adapters (e.g. the no-op notifier) legitimately implement
      // a Promise-returning port without awaiting anything, so this is a
      // review hint rather than a build break.
      '@typescript-eslint/require-await': 'warn',

      // The `pg` driver types every row as `any`, so the `no-unsafe-*` family
      // fires on essentially every repository read. Downgraded to `warn`
      // deliberately: at `error` it would be silenced with hundreds of
      // disable-comments, which certifies nothing. Ratchet back to `error`
      // per-module as repositories gain row types.
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/restrict-template-expressions': 'warn',

      // Import hygiene. `no-extraneous-dependencies` is the one that matters
      // for the runtime image: `npm install --omit=dev` in the Dockerfile only
      // installs declared dependencies, so an undeclared import that resolves
      // locally through npm hoisting is a production-only crash.
      'import-x/no-extraneous-dependencies': [
        'error',
        {
          devDependencies: [
            'test/**',
            'scripts/**',
            'jest.config.ts',
            'jest.*.config.ts',
            'eslint.config.mjs',
            '**/*.spec.ts',
            '**/*.integration-spec.ts',
          ],
          optionalDependencies: false,
          peerDependencies: false,
        },
      ],
      'import-x/no-duplicates': 'error',
      'import-x/no-mutable-exports': 'error',
      'import-x/order': [
        'warn',
        {
          groups: [['builtin', 'external'], 'parent', 'sibling', 'index'],
          'newlines-between': 'never',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      // TypeScript itself resolves modules; the plugin's resolver has no
      // knowledge of `tsconfig` and would report false positives.
      'import-x/no-unresolved': 'off',

      // General correctness rules that the codebase already satisfies.
      eqeqeq: ['error', 'smart'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-return-await': 'off',
      '@typescript-eslint/return-await': ['error', 'in-try-catch'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  // --- Tests: same rules, minus the ones that fight test ergonomics -------
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/unbound-method': 'off',
      'no-console': 'off',
      // Test doubles implement async ports synchronously on purpose; off here
      // rather than 71 disable-comments that would hide nothing useful.
      '@typescript-eslint/require-await': 'off',

      // The `no-unsafe-*` family is off for tests ONLY, and only because the
      // HTTP suites are built on supertest: `app.getHttpServer()` is typed
      // `any` by Nest and `response.body` is typed `any` by supertest, so
      // every `expect(res.body.data[0].title)` trips three of these rules at
      // once. That accounted for 255 of the repo's warnings across 13 files —
      // none of them a real defect, all of them in code that cannot fail in
      // production.
      //
      // This is a deliberate trade, not blanket permission to be sloppy:
      //  - It is scoped to `test/**`. `src/**` keeps the full unsafe family,
      //    so an untyped `pg` row reaching production code still warns.
      //  - The bug-catching rules stay ON here (`no-floating-promises`,
      //    `no-misused-promises`, `await-thenable`, `no-unnecessary-type-
      //    assertion`), which are the ones that actually catch broken tests.
      //  - `no-explicit-any` stays ON, so a test cannot reintroduce the
      //    unsafety by hand-writing `as any`.
      // New assertions should prefer the typed readers in `test/support/http.ts`,
      // which give `res.body` a real type at the point of use.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },

  // --- Operator CLI entry points -------------------------------------------
  // `src/scripts/**` holds one-shot terminal commands (`npm run migrate`,
  // `npm run apikey:create`). They live under `src/` only so `tsc` emits them
  // into `dist/` for the image's migrate step — they are not request-path code
  // and they never boot a Nest app, so there is no pino logger to route to.
  // Printing to stdout IS their output contract: `apikey:create` prints a
  // plaintext key for a human to copy, and wrapping that in structured JSON
  // would make it strictly harder to use. Same classification the top-level
  // `scripts/**` block already gets; every type-aware rule stays on.
  {
    files: ['src/scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },

  // --- Tooling scripts: syntactic rules only (outside tsconfig include) ----
  {
    files: ['scripts/**/*.ts', 'jest.config.ts', 'jest.*.config.ts'],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      parserOptions: { project: false },
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  // --- Plain CommonJS helper scripts --------------------------------------
  {
    files: ['**/*.js', '**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.commonjs },
    },
    rules: {
      'no-console': 'off',
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  // --- This config file itself --------------------------------------------
  {
    files: ['eslint.config.mjs'],
    languageOptions: { sourceType: 'module', globals: globals.node },
  },

  prettierConfig,
);
