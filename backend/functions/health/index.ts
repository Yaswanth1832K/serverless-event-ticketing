import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { json, HttpError } from '../../shared/http';
import { getUser } from '../../shared/auth';
import { log } from '../../shared/logger';

// Skeleton handler: GET /health (public) and GET /me (needs a valid Cognito JWT).
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    if (event.resource === '/health') {
      return json(event, 200, { status: 'ok', time: new Date().toISOString() });
    }
    if (event.resource === '/me') {
      const user = getUser(event);
      return json(event, 200, user);
    }
    throw new HttpError(404, 'NOT_FOUND', 'Route not found');
  } catch (err) {
    if (err instanceof HttpError) {
      return json(event, err.statusCode, { error: err.code, message: err.message });
    }
    log.error('unhandled error', { error: String(err) });
    return json(event, 500, { error: 'INTERNAL', message: 'Internal server error' });
  }
}
