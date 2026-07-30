import type { INestApplicationContext } from '@nestjs/common';
import { Logger } from '@nestjs/common';

/**
 * Force-exit deadline armed on the first shutdown signal. Defaulted above the
 * worst-case job duration so an in-flight feed fetch can finish draining before
 * the runtime is killed.
 */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

interface ShutdownTimeoutSource {
  shutdownTimeoutMs?: number;
}

export interface ProcessGuardOptions {
  /** Logger context, e.g. `Api`, `Scheduler`, `Worker`. */
  context: string;
  shutdownTimeoutMs?: number;
  /** Escape hatch for tests; defaults to the real process. */
  process?: NodeJS.Process;
}

/**
 * Resolves the shutdown deadline from `AppConfigService` when the getter exists,
 * then from `SHUTDOWN_TIMEOUT_MS`, then from the built-in default.
 */
export function resolveShutdownTimeoutMs(source?: unknown, env: NodeJS.ProcessEnv = process.env): number {
  const configured = (source as ShutdownTimeoutSource | undefined)?.shutdownTimeoutMs;
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return configured;
  }

  const fromEnv = Number(env['SHUTDOWN_TIMEOUT_MS']);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }

  return DEFAULT_SHUTDOWN_TIMEOUT_MS;
}

/**
 * Logs a bootstrap failure and marks the process as failed.
 *
 * Without this every entrypoint's `void bootstrap()` turned a boot error into a
 * bare unhandled rejection: no log line, and exit code 0 to the orchestrator.
 */
export function handleBootstrapFailure(error: unknown, context: string, target: NodeJS.Process = process): void {
  const logger = new Logger(context);
  logger.fatal(
    `Bootstrap failed: ${error instanceof Error ? error.message : String(error)}`,
    error instanceof Error ? error.stack : undefined,
  );
  target.exitCode = 1;
}

/**
 * Installs process-level guards for a running Nest runtime:
 * fatal logging plus a best-effort `app.close()` on unhandled rejections and
 * uncaught exceptions, and a hard deadline armed on the first shutdown signal so
 * a stuck drain cannot leave the container hanging forever.
 *
 * Must only be called from entrypoints. Installing it inside `AppModule` would
 * swallow errors during tests.
 */
export function installProcessGuards(app: INestApplicationContext, options: ProcessGuardOptions): () => void {
  const target = options.process ?? process;
  const logger = new Logger(options.context);
  const shutdownTimeoutMs = resolveShutdownTimeoutMs({ shutdownTimeoutMs: options.shutdownTimeoutMs });

  let shuttingDown = false;

  const armShutdownDeadline = (): void => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    const deadline = setTimeout(() => {
      logger.fatal(`Shutdown exceeded ${shutdownTimeoutMs}ms, forcing exit`);
      target.exit(1);
    }, shutdownTimeoutMs);

    // Never keep the event loop alive just for the deadline itself.
    deadline.unref();
  };

  const closeAfterFatal = (reason: string, error: unknown): void => {
    logger.fatal(
      `${reason}: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? error.stack : undefined,
    );
    target.exitCode = 1;
    armShutdownDeadline();

    void app.close().catch((closeError: unknown) => {
      logger.error(
        `Failed to close the application context: ${closeError instanceof Error ? closeError.message : String(closeError)}`,
      );
      target.exit(1);
    });
  };

  const onUnhandledRejection = (reason: unknown): void => closeAfterFatal('Unhandled promise rejection', reason);
  const onUncaughtException = (error: unknown): void => closeAfterFatal('Uncaught exception', error);
  const onSignal = (): void => armShutdownDeadline();

  target.on('unhandledRejection', onUnhandledRejection);
  target.on('uncaughtException', onUncaughtException);
  for (const signal of SHUTDOWN_SIGNALS) {
    target.on(signal, onSignal);
  }

  return () => {
    target.removeListener('unhandledRejection', onUnhandledRejection);
    target.removeListener('uncaughtException', onUncaughtException);
    for (const signal of SHUTDOWN_SIGNALS) {
      target.removeListener(signal, onSignal);
    }
  };
}
