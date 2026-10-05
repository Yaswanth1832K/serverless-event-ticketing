import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

// Comma-separated allowlist, set from the SAM template.
function allowedOrigins(): string[] {
  return (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

// Echo the Origin back only if it is on the allowlist. Otherwise send no CORS header.
export function corsHeaders(origin: string | undefined): Record<string, string> {
  if (origin && allowedOrigins().includes(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      Vary: 'Origin',
    };
  }
  return { Vary: 'Origin' };
}

export function originOf(event: Pick<APIGatewayProxyEvent, 'headers'>): string | undefined {
  const h = event.headers ?? {};
  return h.origin ?? h.Origin;
}

export function json(
  event: Pick<APIGatewayProxyEvent, 'headers'>,
  statusCode: number,
  body: unknown,
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...corsHeaders(originOf(event)),
    },
    body: JSON.stringify(body),
  };
}

// Errors with an HTTP status. Handlers throw these and the handler's catch block turns them into a response.
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
