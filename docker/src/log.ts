/**
 * Timestamped logging helpers shared by every module.
 * All output goes to stderr so stdout stays free for machine-readable
 * results (see the `count` command in cli.ts).
 */

function timestamp(): string {
  return new Date().toISOString();
}

export function log(message: string): void {
  process.stderr.write(`${timestamp()} ${message}\n`);
}

export function logError(message: string): void {
  process.stderr.write(`${timestamp()} ERROR: ${message}\n`);
}
