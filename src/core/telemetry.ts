/**
 * OpenTelemetry SDK initialisation.
 *
 * Must be the very first import in index.ts (after dotenv) so that the SDK
 * patches Node's http/express modules before they are required anywhere else.
 *
 * Exporters:
 *   - OTEL_EXPORTER_OTLP_ENDPOINT set → sends spans to that OTLP endpoint.
 *     Point to Jaeger all-in-one (port 4318) for a local trace UI.
 *   - Not set → ConsoleSpanExporter (prints JSON spans to stdout, useful in dev).
 *
 * Service name:  OTEL_SERVICE_NAME  (default: "pos-transaction-api")
 * Disable OTel:  OTEL_SDK_DISABLED=true
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { SpanExporter } from '@opentelemetry/sdk-trace-base';

function buildExporter(): SpanExporter {
  const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  if (endpoint) {
    return new OTLPTraceExporter({ url: `${endpoint}/v1/traces` });
  }
  return new ConsoleSpanExporter();
}

const sdk = new NodeSDK({
  serviceName: process.env['OTEL_SERVICE_NAME'] ?? 'pos-transaction-api',
  traceExporter: buildExporter(),
  instrumentations: [
    getNodeAutoInstrumentations({
      // Disable fs instrumentation — it fires on every SQLite read and is too noisy
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
});

if (process.env['OTEL_SDK_DISABLED'] !== 'true') {
  sdk.start();
}

// Flush pending spans before process exits
process.on('SIGTERM', () => { sdk.shutdown().catch(() => {}); });
process.on('SIGINT',  () => { sdk.shutdown().catch(() => {}); });

export { sdk };
