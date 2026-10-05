// Structured JSON logger. CloudWatch Logs Insights can query these fields directly.
type Level = 'debug' | 'info' | 'warn' | 'error';

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel = (process.env.LOG_LEVEL as Level) || 'info';

function write(level: Level, message: string, fields?: Record<string, unknown>) {
  if (order[level] < order[minLevel]) return;
  // process.stdout.write keeps the line as real top-level JSON fields. console.log would be wrapped
  // by Lambda's JSON log format as an escaped string inside "message", which Logs Insights cannot query.
  process.stdout.write(JSON.stringify({ level, message, time: new Date().toISOString(), ...fields }) + '\n');
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => write('debug', m, f),
  info: (m: string, f?: Record<string, unknown>) => write('info', m, f),
  warn: (m: string, f?: Record<string, unknown>) => write('warn', m, f),
  error: (m: string, f?: Record<string, unknown>) => write('error', m, f),
};
