// Runtime configuration. The app fetches /config.json before it renders, so one build works for any
// deployment. The file only holds PUBLIC identifiers (API URL, Cognito pool and client ids). No
// secrets and no AWS credentials ever go into the frontend.
export interface AppConfig {
  apiUrl: string;
  region: string;
  userPoolId: string;
  userPoolClientId: string;
  currency: string;
}

let current: AppConfig | undefined;

export class ConfigError extends Error {}

const REQUIRED: (keyof AppConfig)[] = ['apiUrl', 'region', 'userPoolId', 'userPoolClientId'];

export async function loadConfig(url = '/config.json'): Promise<AppConfig> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch {
    throw new ConfigError("Can't load the app settings. Check your internet connection and reload the page.");
  }
  if (!res.ok) throw new ConfigError('The app settings file is missing. Ask whoever deployed the site to publish config.json.');
  let raw: Record<string, unknown>;
  try {
    raw = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new ConfigError('The app settings file is damaged. Ask whoever deployed the site to publish it again.');
  }
  for (const key of REQUIRED) {
    if (typeof raw[key] !== 'string' || !raw[key]) {
      throw new ConfigError(`The app settings are incomplete (missing "${key}").`);
    }
  }
  current = {
    apiUrl: String(raw.apiUrl).replace(/\/+$/, ''),
    region: String(raw.region),
    userPoolId: String(raw.userPoolId),
    userPoolClientId: String(raw.userPoolClientId),
    currency: typeof raw.currency === 'string' && raw.currency ? raw.currency : 'USD',
  };
  return current;
}

export function config(): AppConfig {
  if (!current) throw new ConfigError('The app has not finished loading its settings yet.');
  return current;
}

// For tests.
export function setConfigForTests(c: AppConfig | undefined): void {
  current = c;
}
