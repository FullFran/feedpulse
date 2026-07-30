import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Static guards for the container supply chain.
 *
 * These files are not exercised by any other suite, yet a regression in them is
 * expensive and silent: a re-introduced `npm install` makes builds
 * irreproducible, a dropped `.dockerignore` line ships a developer `.env` into a
 * published layer, and a missing compose healthcheck lets Traefik route traffic
 * at an api container that is still running migrations.
 */

const repoRoot = resolve(__dirname, '..');

function readRepoFile(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

/**
 * Extracts a single top-level service block out of a compose file, so an
 * assertion about `scheduler` cannot be satisfied by text belonging to `api`.
 */
function extractServiceBlock(composeYaml: string, serviceName: string): string {
  const lines = composeYaml.split('\n');
  const startIndex = lines.findIndex((line) => line === `  ${serviceName}:`);

  if (startIndex === -1) {
    throw new Error(`Service "${serviceName}" not found in compose file`);
  }

  const blockLines: string[] = [];
  for (const line of lines.slice(startIndex + 1)) {
    const isNextTopLevelKey = line.trim().length > 0 && !line.startsWith('    ');
    if (isNextTopLevelKey) {
      break;
    }
    blockLines.push(line);
  }

  return blockLines.join('\n');
}

/** Every source path that could plausibly reference a headless browser. */
function collectSourceFiles(): string[] {
  const roots = ['src', 'scripts', 'test', 'docs', '.github'];
  const collected: string[] = [];

  const walk = (absolutePath: string): void => {
    for (const entry of readdirSync(absolutePath)) {
      const child = join(absolutePath, entry);
      if (statSync(child).isDirectory()) {
        walk(child);
        continue;
      }
      collected.push(child);
    }
  };

  for (const root of roots) {
    const absoluteRoot = join(repoRoot, root);
    if (existsSync(absoluteRoot)) {
      walk(absoluteRoot);
    }
  }

  return collected;
}

describe('.dockerignore', () => {
  const dockerignore = readRepoFile('.dockerignore');
  const patterns = dockerignore
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  it('exists, because the build stage copies the whole working tree', () => {
    expect(patterns.length).toBeGreaterThan(0);
  });

  it.each(['node_modules/', 'dist/', '.git/', '.env', '.env.*', 'coverage/', 'test/', '*.tsbuildinfo'])(
    'excludes %s from the build context',
    (pattern) => {
      expect(patterns).toContain(pattern);
    },
  );

  it.each(['public/', 'public', 'db/', 'db', 'src/', 'src', 'package.json', 'tsconfig.json'])(
    'never excludes %s, which the image genuinely needs',
    (pattern) => {
      expect(patterns).not.toContain(pattern);
    },
  );
});

describe('Dockerfile', () => {
  const dockerfile = readRepoFile('Dockerfile');
  const instructions = dockerfile
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');

  it('pins the base image by digest so rebuilds are reproducible', () => {
    expect(instructions).toMatch(/^ARG NODE_IMAGE=node:[^\s@]+@sha256:[0-9a-f]{64}$/m);
    expect(instructions).not.toMatch(/^FROM node:(?!.*@sha256:)/m);
  });

  it('installs from the committed lockfile instead of resolving fresh ranges', () => {
    expect(instructions).not.toMatch(/npm install/);
    expect(instructions).toMatch(/npm ci/);
  });

  it('never runs dependency install scripts at build time', () => {
    const installCommands = instructions.match(/npm ci[^\n&]*/g) ?? [];

    expect(installCommands.length).toBeGreaterThan(0);
    for (const command of installCommands) {
      expect(command).toContain('--ignore-scripts');
    }
  });

  it('omits devDependencies from the runtime stage', () => {
    expect(instructions).toMatch(/npm ci --omit=dev/);
  });

  it('drops root before the runtime command', () => {
    const userIndex = instructions.indexOf('USER node');
    const cmdIndex = instructions.indexOf('CMD [');

    expect(userIndex).toBeGreaterThan(-1);
    expect(cmdIndex).toBeGreaterThan(userIndex);
  });

  it('declares a port-aware healthcheck against the public liveness endpoint', () => {
    expect(instructions).toMatch(/HEALTHCHECK/);
    expect(instructions).toContain('process.env.PORT');
    expect(instructions).toContain('/health');
  });
});

describe('compose healthchecks', () => {
  const composeFiles = ['docker-compose.yml', 'compose.dokploy.yml'] as const;

  describe.each(composeFiles)('%s', (composeFile) => {
    const composeYaml = readRepoFile(composeFile);

    it('probes api readiness rather than mere liveness', () => {
      const apiBlock = extractServiceBlock(composeYaml, 'api');

      expect(apiBlock).toContain('healthcheck:');
      expect(apiBlock).toContain('/ready');
      expect(apiBlock).toMatch(/start_period: \d+s/);
    });

    it('gives the api enough start_period to finish a migration run', () => {
      const apiBlock = extractServiceBlock(composeYaml, 'api');
      const startPeriod = /start_period: (\d+)s/.exec(apiBlock);

      expect(startPeriod).not.toBeNull();
      expect(Number(startPeriod?.[1])).toBeGreaterThanOrEqual(90);
    });

    it('disables the inherited image healthcheck for the scheduler, which has no HTTP surface', () => {
      const schedulerBlock = extractServiceBlock(composeYaml, 'scheduler');

      expect(schedulerBlock).toContain('healthcheck:');
      expect(schedulerBlock).toContain('disable: true');
    });

    it('probes the worker on its own metrics server', () => {
      const workerBlock = extractServiceBlock(composeYaml, 'worker');

      expect(workerBlock).toContain('healthcheck:');
      expect(workerBlock).toContain('WORKER_METRICS_PORT');
      expect(workerBlock).toContain('/health');
    });

    it('treats .env as optional so a fresh clone can boot the stack', () => {
      expect(composeYaml).toContain('required: false');
      expect(composeYaml).not.toMatch(/^\s+env_file:\n\s+- \.env\s*$/m);
    });
  });
});

describe('headless browser dead weight', () => {
  it('no longer ships the puppeteer chart scripts', () => {
    expect(existsSync(join(repoRoot, 'scripts/generate-chart-png.js'))).toBe(false);
    expect(existsSync(join(repoRoot, 'scripts/benchmark/generate-chart-png.ts'))).toBe(false);
  });

  it('keeps the chart sources that actually document the benchmark', () => {
    expect(existsSync(join(repoRoot, 'docs/benchmark-scaling-chart.html'))).toBe(true);
    expect(existsSync(join(repoRoot, 'docs/benchmark-scaling-chart.svg'))).toBe(true);
  });

  it('drops the 1.4 MB rendered PNG that the SVG already replaces', () => {
    expect(existsSync(join(repoRoot, 'docs/benchmark-scaling-chart.png'))).toBe(false);
  });

  it('has no remaining source, script, doc or workflow reference to puppeteer', () => {
    const offenders = collectSourceFiles().filter((file) => {
      if (file === __filename) {
        return false;
      }
      return /puppeteer/i.test(readFileSync(file, 'utf8'));
    });

    expect(offenders).toEqual([]);
  });
});
