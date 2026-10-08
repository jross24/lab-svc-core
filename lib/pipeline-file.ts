import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isVersion } from './migrations/version.ts';

// Reads minRollbackVersion from pipeline.json at synth time. The value goes into the cloud assembly,
// so every environment gets the same value from the same build.
export function readDeclaredFloor(file = fileURLToPath(new URL('../pipeline.json', import.meta.url))): string {
  const pipeline = JSON.parse(readFileSync(file, 'utf8')) as { minRollbackVersion?: unknown };
  if (!isVersion(pipeline.minRollbackVersion)) {
    throw new Error(
      `pipeline.json needs "minRollbackVersion": the oldest version of core that can run against the data, for example "0.1.0". Got ${JSON.stringify(pipeline.minRollbackVersion)}.`,
    );
  }
  return pipeline.minRollbackVersion;
}
