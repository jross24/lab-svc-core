import { describe, expect, it } from 'vitest';
import { compareVersions, isVersion, maxVersion } from '../lib/migrations/version.ts';

describe('isVersion', () => {
  it.each(['0.0.0', '1.2.3', '10.20.30', '0.0.0-dev', '0.0.0-pr12.abc1234'])('accepts %j', (text) => {
    expect(isVersion(text)).toBe(true);
  });

  it.each(['', '1.2', '1.2.3.4', 'v1.2.3', '1.2.x', ' 1.2.3', '1.2.3 ', '-1.2.3', 12, null, undefined])(
    'rejects %j',
    (text) => {
      expect(isVersion(text)).toBe(false);
    },
  );
});

describe('compareVersions', () => {
  it('compares the numbers and not the text, so 0.10.0 is newer than 0.9.0', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
    expect(compareVersions('0.9.0', '0.10.0')).toBe(-1);
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
  });

  it('gives 0 for equal versions', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('ignores the suffix of a laptop copy', () => {
    expect(compareVersions('0.0.0-dev', '0.0.0')).toBe(0);
    expect(compareVersions('0.8.0', '0.0.0-dev')).toBe(1);
  });

  it('refuses a text that is not a version', () => {
    expect(() => compareVersions('1.2', '1.2.3')).toThrow(/not a version/);
  });
});

describe('maxVersion', () => {
  it('gives the newest version', () => {
    expect(maxVersion('0.1.0')).toBe('0.1.0');
    expect(maxVersion('0.1.0', '0.10.0', '0.9.0')).toBe('0.10.0');
  });
});
