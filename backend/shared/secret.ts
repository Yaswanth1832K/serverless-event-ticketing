import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

// Loads the QR signing secret from SSM Parameter Store (SecureString). The value is cached in
// memory for a few minutes per warm container, so most requests make no SSM call. It is never
// logged, returned in a response, or stored in an environment variable.
const ssm = new SSMClient({});
const CACHE_MS = 5 * 60 * 1000;
let cached: { value: string; at: number } | undefined;

export async function getQrSecret(): Promise<string> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const name = process.env.QR_SECRET_PARAM;
  if (!name) throw new Error('QR_SECRET_PARAM is not set');
  const res = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const value = res.Parameter?.Value;
  if (!value || value.length < 32) throw new Error('QR signing secret is missing or too short');
  cached = { value, at: Date.now() };
  return value;
}
