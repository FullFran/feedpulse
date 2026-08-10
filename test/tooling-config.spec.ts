import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expectDefined } from './support/expect-defined';

/**
 * Guards the lint/format/version tooling against silent drift.
 *
 * These files are edited by hand, by editors and by CI templates, and nothing
 * else in the suite notices when they stop agreeing with each other. The
 * failure mode is quiet: an editor indents with 4 spaces because
 * `.editorconfig` says so while Prettier reflows to 2, or CI builds on a Node
 * major the Docker image never ships. Each assertion below pins one of those
 * agreements.
 */

const repoRoot = join(__dirname, '..');

const read = (relativePath: string): string => readFileSync(join(repoRoot, relativePath), 'utf8');

interface PrettierConfig {
  printWidth: number;
  tabWidth: number;
  useTabs: boolean;
  endOfLine: string;
  singleQuote: boolean;
  semi: boolean;
  trailingComma: string;
}

interface PackageJson {
  engines?: { node?: string };
}

const parseEditorConfig = (source: string): Map<string, string> => {
  const values = new Map<string, string>();
  let section = '';
  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1);
      continue;
    }
    const separator = line.indexOf('=');
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    values.set(section === '' ? key : `${section}.${key}`, value);
  }
  return values;
};

/** Reads the Node major that a `node:<major>` image reference pins. */
const nodeMajorFromImageReference = (source: string): string => {
  const match = /node:(\d+)[.\-@]/.exec(source);
  if (match === null) {
    throw new Error('No node:<major> image reference found');
  }
  return expectDefined(match[1]);
};

describe('tooling configuration', () => {
  const prettierConfig = JSON.parse(read('.prettierrc.json')) as PrettierConfig;
  const editorConfig = parseEditorConfig(read('.editorconfig'));
  const packageJson = JSON.parse(read('package.json')) as PackageJson;

  describe('.editorconfig agrees with .prettierrc.json', () => {
    it('declares itself the root so parent directories cannot override it', () => {
      expect(editorConfig.get('root')).toBe('true');
    });

    it('uses the same indentation as Prettier', () => {
      expect(prettierConfig.useTabs).toBe(false);
      expect(editorConfig.get('*.indent_style')).toBe('space');
      expect(editorConfig.get('*.indent_size')).toBe(String(prettierConfig.tabWidth));
    });

    it('uses the same line endings as Prettier', () => {
      expect(prettierConfig.endOfLine).toBe('lf');
      expect(editorConfig.get('*.end_of_line')).toBe('lf');
    });

    it('uses the same line length as Prettier', () => {
      expect(editorConfig.get('*.max_line_length')).toBe(String(prettierConfig.printWidth));
    });

    it('keeps trailing whitespace in Markdown, where it is a hard line break', () => {
      expect(editorConfig.get('*.trim_trailing_whitespace')).toBe('true');
      expect(editorConfig.get('*.md.trim_trailing_whitespace')).toBe('false');
    });
  });

  describe('.prettierignore', () => {
    const prettierIgnore = read('.prettierignore');

    it.each(['node_modules/', 'dist/', 'coverage/', 'package-lock.json'])('excludes %s', (entry) => {
      expect(prettierIgnore).toContain(entry);
    });
  });

  describe('eslint.config.mjs', () => {
    const eslintConfig = read('eslint.config.mjs');

    it.each(['dist/**', 'coverage/**', 'node_modules/**', 'public/dashboard/app.js'])(
      'ignores %s so linting never walks generated or vendored code',
      (entry) => {
        expect(eslintConfig).toContain(`'${entry}'`);
      },
    );

    // `import-x/`, not `import/`: eslint-plugin-import stopped at eslint ^9,
    // so the rules come from the maintained eslint-plugin-import-x fork. Same
    // rule, same guarantee, different prefix.
    it.each(['no-floating-promises', 'no-misused-promises', 'await-thenable', 'import-x/no-extraneous-dependencies'])(
      'keeps %s enabled',
      (rule) => {
        expect(eslintConfig).toContain(rule);
        expect(eslintConfig).not.toMatch(new RegExp(`${rule.replace(/[/-]/g, '\\$&')}'?\\s*:\\s*'off'`));
      },
    );

    it('applies eslint-config-prettier last so formatting is owned by Prettier alone', () => {
      const prettierIndex = eslintConfig.lastIndexOf('prettierConfig');
      const closingIndex = eslintConfig.lastIndexOf(');');
      expect(prettierIndex).toBeGreaterThan(-1);
      expect(prettierIndex).toBeLessThan(closingIndex);
    });
  });

  describe('Node version policy', () => {
    const nvmrc = read('.nvmrc').trim();

    it('pins a bare Node major in .nvmrc', () => {
      expect(nvmrc).toMatch(/^\d+$/);
    });

    it('pins the same Node major as the Docker image', () => {
      expect(nodeMajorFromImageReference(read('Dockerfile'))).toBe(nvmrc);
    });

    it('is at or above the engines floor when package.json declares one', () => {
      const declared = packageJson.engines?.node;
      if (declared === undefined) {
        // The floor is added by the packaging change; nothing to compare yet.
        return;
      }
      const floor = /(\d+)/.exec(declared);
      expect(floor).not.toBeNull();
      expect(Number(nvmrc)).toBeGreaterThanOrEqual(Number(floor?.[1]));
    });
  });
});
