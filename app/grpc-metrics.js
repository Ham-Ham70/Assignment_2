// Separate registry so HTTP /metrics and gRPC :9091 do not share series.
const http = require("http");
const client = require("prom-client");

const grpcRegistry = new client.Registry();

client.collectDefaultMetrics({ register: grpcRegistry, prefix: "grpc_runtime_" });

const grpcHandledTotal = new client.Counter({
  name: "grpc_server_handled_total",
  help: "Total RPC calls completed by method and status code",
  labelNames: ["grpc_service", "grpc_method", "grpc_code"],
  registers: [grpcRegistry],
});

// Seed zeros so Grafana rate() does not go blank before the first real call.
const methods = ["GetCharacters", "StartGame", "MakeGuess", "GetGameStatus"];
const codes = ["OK", "INVALID_ARGUMENT", "NOT_FOUND", "ALREADY_EXISTS", "FAILED_PRECONDITION", "INTERNAL"];
for (const m of methods) {
  for (const c of codes) {
    grpcHandledTotal.inc({ grpc_service: "SecretIdentityService", grpc_method: m, grpc_code: c }, 0);
  }
}

const grpcHandlingSeconds = new client.Histogram({
  name: "grpc_server_handling_seconds",
  help: "Response latency distribution for gRPC method executions in seconds",
  labelNames: ["grpc_service", "grpc_method"],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [grpcRegistry],
});

// How many RPCs are inside the process right now.
const grpcInFlight = new client.Gauge({
  name: "grpc_server_in_flight_requests",
  help: "Number of concurrent gRPC requests currently being processed",
  labelNames: ["grpc_service", "grpc_method"],
  registers: [grpcRegistry],
});

const grpcMsgReceivedBytes = new client.Histogram({
  name: "grpc_server_msg_received_bytes",
  help: "Size of received protobuf request payloads in bytes",
  labelNames: ["grpc_service", "grpc_method"],
  buckets: [32, 64, 128, 256, 512, 1024, 2048, 4096],
  registers: [grpcRegistry],
});

const grpcMsgSentBytes = new client.Histogram({
  name: "grpc_server_msg_sent_bytes",
  help: "Size of sent protobuf response payloads in bytes",
  labelNames: ["grpc_service", "grpc_method"],
  buckets: [32, 64, 128, 256, 512, 1024, 2048, 4096],
  registers: [grpcRegistry],
});

const grpcIdempotencyHits = new client.Counter({
  name: "grpc_idempotency_hits_total",
  help: "StartGame / MakeGuess replies served from the replay cache",
  labelNames: ["grpc_service", "grpc_method"],
  registers: [grpcRegistry],
});

function startMetricsServer(port = process.env.GRPC_METRICS_PORT || 9091) {
  const server = http.createServer(async (req, res) => {
    if (req.url === "/metrics" || req.url === "/") {
      res.setHeader("Content-Type", grpcRegistry.contentType);
      res.end(await grpcRegistry.metrics());
    } else {
      res.statusCode = 404;
      res.end("Not Found");
    }
  });

  server.listen(port, () => {
    console.log(`[gRPC] Prometheus metrics endpoint listening on http://0.0.0.0:${port}/metrics`);
  });

  return server;
}

module.exports = {
  grpcRegistry,
  grpcHandledTotal,
  grpcHandlingSeconds,
  grpcInFlight,
  grpcMsgReceivedBytes,
  grpcMsgSentBytes,
  grpcIdempotencyHits,
  startMetricsServer,
};
