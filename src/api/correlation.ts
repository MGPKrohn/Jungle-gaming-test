type Headers = Record<string, string | string[] | undefined>;

function first(headers: Headers, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** correlationId: trace-id do `traceparent` (W3C) > X-Correlation-Id > novo UUID. */
export function extractCorrelationId(headers: Headers, generate: () => string): string {
  const traceparent = first(headers, 'traceparent');
  const match = traceparent?.match(/^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/i);
  if (match?.[1] && match[1] !== '0'.repeat(32)) return match[1];
  const explicit = first(headers, 'x-correlation-id');
  if (explicit && explicit.length <= 128) return explicit;
  return generate();
}
