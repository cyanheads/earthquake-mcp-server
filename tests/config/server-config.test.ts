/**
 * @fileoverview Exercises server environment normalization at the framework config boundary.
 * @module tests/config/server-config.test
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const variables = ['USGS_BASE_URL', 'EMSC_BASE_URL', 'DEFAULT_LIMIT', 'REQUEST_TIMEOUT_MS'];

beforeEach(() => {
  vi.resetModules();
  for (const variable of variables) vi.stubEnv(variable, undefined);
});

afterEach(() => vi.unstubAllEnvs());

it.each(['', `\${UNSET_OPTION}`])(
  'uses domain defaults for unset host values: %s',
  async (value) => {
    for (const variable of variables) vi.stubEnv(variable, value);
    const { getServerConfig } = await import('@/config/server-config.js');
    expect(getServerConfig()).toEqual({
      usgsBaseUrl: 'https://earthquake.usgs.gov',
      emscBaseUrl: 'https://www.seismicportal.eu',
      defaultLimit: 100,
      requestTimeoutMs: 10000,
    });
  },
);

it('preserves configured values and a URL containing a non-whole placeholder', async () => {
  vi.stubEnv('USGS_BASE_URL', `https://example.com/\${catalog}`);
  vi.stubEnv('DEFAULT_LIMIT', '25');
  vi.stubEnv('REQUEST_TIMEOUT_MS', '2000');
  const { getServerConfig } = await import('@/config/server-config.js');
  expect(getServerConfig()).toMatchObject({
    usgsBaseUrl: `https://example.com/\${catalog}`,
    defaultLimit: 25,
    requestTimeoutMs: 2000,
  });
});

it('still rejects a malformed nonblank numeric setting', async () => {
  vi.stubEnv('DEFAULT_LIMIT', 'not-a-number');
  const { getServerConfig } = await import('@/config/server-config.js');
  expect(() => getServerConfig()).toThrow(/DEFAULT_LIMIT/);
});
