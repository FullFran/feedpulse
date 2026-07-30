/**
 * Narrows an optional value to a defined one, throwing with a readable message
 * when it is not.
 *
 * This exists because `noUncheckedIndexedAccess` types every indexed read as
 * `T | undefined`, and a test that reads `rows[0]` needs a value, not a maybe.
 * The obvious alternative — a `!` non-null assertion — has two problems:
 *
 *  1. It is invisible to `@typescript-eslint/no-unnecessary-type-assertion`
 *     only while the compiler flag is on. With the flag off the same assertion
 *     becomes a lint error, so `!` couples every test file to one exact
 *     `tsconfig.json` state and there is no intermediate state where both the
 *     type check and the lint pass.
 *  2. When the value really is missing, `!` produces
 *     `TypeError: Cannot read properties of undefined`, pointing at the
 *     property rather than at the empty collection that caused it.
 *
 * A plain function call has neither problem: it type checks and lints
 * identically with the flag on or off, and it fails with the reason.
 */
export function expectDefined<T>(value: T | undefined, what = 'value'): T {
  if (value === undefined) {
    throw new Error(`Expected ${what} to be defined, got undefined`);
  }

  return value;
}
