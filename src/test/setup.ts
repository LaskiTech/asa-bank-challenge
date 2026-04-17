// Runs before any test file is loaded — sets env vars so config.ts reads them correctly.
process.env['SHARED_SECRET'] = 'test-secret';
process.env['DATABASE_PATH'] = ':memory:';
process.env['TIMESTAMP_MAX_AGE_SEC'] = '300';
process.env['EXTERNAL_API_TIMEOUT_MS'] = '5000';
process.env['RETRY_MAX_ATTEMPTS'] = '3';
process.env['RETRY_BASE_DELAY_MS'] = '1000';
process.env['CIRCUIT_BREAKER_THRESHOLD'] = '5';
process.env['CIRCUIT_BREAKER_TIMEOUT_MS'] = '30000';
process.env['BULKHEAD_MAX_CONCURRENT'] = '10';
