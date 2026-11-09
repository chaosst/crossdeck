/** 日志级别与前缀的对应关系。 */
const PREFIXES = {
  debug: '[DEBUG]',
  info: '[INFO]',
  warn: '[WARN]',
  error: '[ERROR]',
} as const;

export type LogLevel = keyof typeof PREFIXES;

/** 单个入参转字符串：字符串原样，Error 取消息，对象 JSON，其余 String()。 */
function formatArg(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value); // 循环引用等 stringify 失败时兜底
    }
  }
  return String(value);
}

/** 控制台日志二次封装：createLogger('App') → 输出带 [INFO] [App] 前缀，多入参用空格拼接后一次打印。 */
export function createLogger(scope?: string) {
  const tag = scope ? `[${scope}]` : '';
  const emit = (level: LogLevel, args: unknown[]) => {
    const text = [PREFIXES[level], tag, ...args.map(formatArg)].filter(Boolean).join(' ');
    (level === 'warn' ? console.warn : level === 'error' ? console.error : console.log)(text);
  };

  return {
    debug: (...args: unknown[]) => emit('debug', args),
    info: (...args: unknown[]) => emit('info', args),
    warn: (...args: unknown[]) => emit('warn', args),
    error: (...args: unknown[]) => emit('error', args),
  };
}

export type Logger = ReturnType<typeof createLogger>;

export const logger = createLogger('App');
