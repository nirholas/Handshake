import { pino } from 'pino'

/**
 * Structured JSON logger. Cloud Run ingests stdout JSON lines natively;
 * `severity` is mapped so log levels surface correctly in Cloud Logging.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'hood-alerts' },
  formatters: {
    level(label) {
      const severity =
        { trace: 'DEBUG', debug: 'DEBUG', info: 'INFO', warn: 'WARNING', error: 'ERROR', fatal: 'CRITICAL' }[
          label
        ] ?? 'DEFAULT'
      return { level: label, severity }
    },
  },
})
