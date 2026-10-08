// Versions of a release look like 1.2.3. A version of a laptop copy or a preview has a suffix, for example 0.0.0-dev.
// The comparison reads the three numbers and ignores the suffix. The pipeline compares versions the same way
// (actions/preflight in lab-workflows), so a floor means the same thing in both places.

const VERSION = /^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-[0-9A-Za-z.-]+)?$/;

export function isVersion(text: unknown): text is string {
  return typeof text === 'string' && VERSION.test(text);
}

function numbers(text: string): readonly [number, number, number] {
  const match = VERSION.exec(text);
  if (!match) throw new Error(`"${text}" is not a version of the form 1.2.3`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

// -1 if a is older than b, 0 if they are equal, 1 if a is newer.
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const left = numbers(a);
  const right = numbers(b);
  for (let index = 0; index < 3; index += 1) {
    const x = left[index] ?? 0;
    const y = right[index] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

// The newest of one or more versions.
export function maxVersion(first: string, ...others: readonly string[]): string {
  return others.reduce((best, candidate) => (compareVersions(candidate, best) > 0 ? candidate : best), first);
}
