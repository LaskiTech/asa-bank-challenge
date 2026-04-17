export const config = {
  // Server
  PORT: parseInt(process.env['PORT'] ?? '3000'),
  NODE_ENV: process.env['NODE_ENV'] ?? 'development',

  // Security
  SHARED_SECRET: process.env['SHARED_SECRET'] ?? 'dev-secret-key-change-in-production',
  TIMESTAMP_MAX_AGE_SEC: parseInt(process.env['TIMESTAMP_MAX_AGE_SEC'] ?? '300'),

  // Storage
  DATABASE_PATH: process.env['DATABASE_PATH'] ?? './data/transactions.db',

  // External API
  EXTERNAL_API_URL: process.env['EXTERNAL_API_URL'] ?? 'http://localhost:4000',
  EXTERNAL_API_TIMEOUT_MS: parseInt(process.env['EXTERNAL_API_TIMEOUT_MS'] ?? '5000'),

  // Resilience
  RETRY_MAX_ATTEMPTS: parseInt(process.env['RETRY_MAX_ATTEMPTS'] ?? '3'),
  RETRY_BASE_DELAY_MS: parseInt(process.env['RETRY_BASE_DELAY_MS'] ?? '1000'),
  CIRCUIT_BREAKER_THRESHOLD: parseInt(process.env['CIRCUIT_BREAKER_THRESHOLD'] ?? '5'),
  CIRCUIT_BREAKER_TIMEOUT_MS: parseInt(process.env['CIRCUIT_BREAKER_TIMEOUT_MS'] ?? '30000'),
  BULKHEAD_MAX_CONCURRENT: parseInt(process.env['BULKHEAD_MAX_CONCURRENT'] ?? '10'),

  // Observability (OpenTelemetry)
  // Unset → ConsoleSpanExporter (stdout).  Set → OTLP exporter (e.g. Jaeger).
  OTEL_SERVICE_NAME: process.env['OTEL_SERVICE_NAME'] ?? 'pos-transaction-api',
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? '',
};

export const isProduction = config.NODE_ENV === 'production';
export const isDevelopment = config.NODE_ENV === 'development';
