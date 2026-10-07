export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

export interface LogFields {
  readonly service: string;
  readonly version: string;
  readonly requestId: string;
  readonly route: string;
  readonly status: number;
  readonly durationMs: number;
  // The X-Ray trace of the request. It links a log line to its trace.
  readonly traceId?: string | undefined;
  readonly error?: string | undefined;
}

export function levelForStatus(status: number): LogLevel {
  if (status >= 500) return 'ERROR';
  if (status >= 400) return 'WARN';
  return 'INFO';
}

// Three decimals are enough for a duration in milliseconds.
export function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

// One request is one line of JSON. CloudWatch Logs Insights then finds each field with no parse rule.
// The line has no request body, no header and no query string, so it holds no personal data.
export function formatLogLine(fields: LogFields, now: Date = new Date()): string {
  const { traceId, error, durationMs, ...rest } = fields;
  return JSON.stringify({
    timestamp: now.toISOString(),
    level: levelForStatus(fields.status),
    ...rest,
    durationMs: roundMs(durationMs),
    ...(traceId === undefined ? {} : { traceId }),
    ...(error === undefined ? {} : { error }),
  });
}
