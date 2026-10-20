// Secret Identity — Wordle-style guessing game for DC characters.
// The answer stays on the server; the client only gets clue feedback until the game ends.
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const client = require("prom-client");
const pino = require("pino");

const gameEngine = require("./game-engine");
const grpcServer = require("./grpc-server");
const grpcMetrics = require("./grpc-metrics");

const PORT = process.env.PORT || 8000;
const GRPC_PORT = process.env.GRPC_PORT || 50051;
const GRPC_METRICS_PORT = process.env.GRPC_METRICS_PORT || 9091;

// Guess route only: 5 calls per 10s, one bucket per client IP, in this process.
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 10000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 5);
const rateLimitStore = new Map(); // ip -> timestamps in the current window

// JSON logs on stdout → Docker → Filebeat → Elasticsearch → Kibana.
// Keep it safe: no IPs, no user-agents, and never the secret while a game is running.
const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  base: { service: "secret-identity" },
  messageKey: "message",
  timestamp: () => `,"@timestamp":"${new Date().toISOString()}"`,
  formatters: { level: (label) => ({ level: label }) },
});

// Local fault injection for the slow-request experiment.
const chaos = {
  delayEveryNth: 0,
  delayMs: 0,
  requestOrdinal: 0,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Cardinality demo counter. ENABLE_CARDINALITY_LABEL=1 adds a request_id label
// (capped at 100 unique values). Default build has no label → one series.
const ENABLE_CARDINALITY_LABEL = process.env.ENABLE_CARDINALITY_LABEL === "1";
const MAX_CARDINALITY_IDS = 100;
const seenDemoRequestIds = new Set();

const demoRequests = ENABLE_CARDINALITY_LABEL
  ? new client.Counter({
      name: "demo_requests_total",
      help: "Demo counter used to show why request_id must not be a metric label",
      labelNames: ["request_id"],
    })
  : new client.Counter({
      name: "demo_requests_total",
      help: "Demo counter without high-cardinality labels",
    });

// ---------- metrics ----------

client.collectDefaultMetrics();

const httpRequests = new client.Counter({
  name: "http_requests_total",
  help: "HTTP requests handled",
  labelNames: ["method", "route", "status_code"],
});

const httpDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route"],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
});

const gamesStarted = new client.Counter({
  name: "games_started_total",
  help: "Games started",
});

const gamesFinished = new client.Counter({
  name: "games_finished_total",
  help: "Games finished, by result",
  labelNames: ["result"],
});
// Seed both outcomes at zero so rate() has series from the first scrape.
gamesFinished.inc({ result: "won" }, 0);
gamesFinished.inc({ result: "lost" }, 0);

new client.Gauge({
  name: "games_active",
  help: "Games currently in progress",
  collect() {
    let n = 0;
    for (const g of gameEngine.games.values()) if (g.status === "in_progress") n++;
    this.set(n);
  },
});

const guessesPerGame = new client.Summary({
  name: "guesses_per_game",
  help: "Guesses used in finished games",
  labelNames: ["result"],
  percentiles: [0.5, 0.9, 0.99],
  maxAgeSeconds: 600, // roughly the last 10 minutes
  ageBuckets: 5,
});

// Extra business metric: which characters get guessed most (label set = roster size).
const characterGuesses = new client.Counter({
  name: "guesses_by_character_total",
  help: "Guesses made, by character name",
  labelNames: ["character"],
});

const httpRateLimitHits = new client.Counter({
  name: "http_rate_limit_hits_total",
  help: "Guess requests rejected with HTTP 429",
  labelNames: ["route"],
});

const httpIdempotencyHits = new client.Counter({
  name: "http_idempotency_hits_total",
  help: "Start-game / guess calls served from the replay cache",
  labelNames: ["route"],
});

const app = express();

// Attach a request id, optionally sleep (chaos), then record metrics + a log line.
app.use(async (req, res, next) => {
  const incoming = req.get("x-request-id");
  const requestId =
    incoming && /^[A-Za-z0-9._-]{1,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  req.log = logger.child({ request_id: requestId });
  res.set("X-Request-ID", requestId);

  // Prometheus scrapes often — don't inflate our own request metrics/logs.
  if (req.path === "/metrics" || req.path === "/metrics-grpc") return next();

  const stopTimer = httpDuration.startTimer();
  const started = process.hrtime.bigint();

  if (chaos.delayEveryNth > 0 && chaos.delayMs > 0) {
    chaos.requestOrdinal += 1;
    if (chaos.requestOrdinal % chaos.delayEveryNth === 0) {
      req.log.warn(
        { delay_ms: chaos.delayMs, every_nth: chaos.delayEveryNth, ordinal: chaos.requestOrdinal },
        "chaos delay injected"
      );
      await sleep(chaos.delayMs);
    }
  }

  res.on("finish", () => {
    // Prefer the route template over the raw URL so labels stay bounded.
    const route = req.route ? req.baseUrl + req.route.path : "unmatched";
    stopTimer({ method: req.method, route });
    httpRequests.inc({ method: req.method, route, status_code: res.statusCode });

    const durationMs = Math.round(Number(process.hrtime.bigint() - started) / 1e5) / 10;
    const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
    req.log[level](
      { method: req.method, route, status_code: res.statusCode, duration_ms: durationMs },
      "request completed"
    );
  });
  next();
});

app.use(express.json());

function checkRateLimit(req, res, next) {
  const clientKey = req.ip || req.connection.remoteAddress || "127.0.0.1";
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;

  let history = rateLimitStore.get(clientKey) || [];
  history = history.filter((ts) => ts > windowStart);

  if (history.length >= RATE_LIMIT_MAX) {
    const oldestTimestamp = history[0];
    const msUntilReset = oldestTimestamp + RATE_LIMIT_WINDOW_MS - now;
    const retryAfterSec = Math.max(1, Math.ceil(msUntilReset / 1000));

    res.set("Retry-After", String(retryAfterSec));
    res.set("X-RateLimit-Limit", String(RATE_LIMIT_MAX));
    res.set("X-RateLimit-Remaining", "0");
    res.set("X-RateLimit-Reset", String(Math.ceil((oldestTimestamp + RATE_LIMIT_WINDOW_MS) / 1000)));

    const route = req.route ? req.baseUrl + req.route.path : "guesses";
    httpRateLimitHits.inc({ route });

    req.log.warn({ retry_after: retryAfterSec, limit: RATE_LIMIT_MAX }, "rate limit exceeded");
    return res.status(429).json({
      detail: `Too Many Requests. Limit is ${RATE_LIMIT_MAX} requests per ${RATE_LIMIT_WINDOW_MS / 1000}s.`,
      retry_after: retryAfterSec,
    });
  }

  history.push(now);
  rateLimitStore.set(clientKey, history);

  res.set("X-RateLimit-Limit", String(RATE_LIMIT_MAX));
  res.set("X-RateLimit-Remaining", String(RATE_LIMIT_MAX - history.length));
  res.set("X-RateLimit-Reset", String(Math.ceil((history[0] + RATE_LIMIT_WINDOW_MS) / 1000)));

  next();
}

// ---------- API ----------

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/metrics", async (req, res) => {
  res.set("Content-Type", client.register.contentType);
  res.end(await client.register.metrics());
});

app.get("/metrics-grpc", async (req, res) => {
  res.set("Content-Type", grpcMetrics.grpcRegistry.contentType);
  res.end(await grpcMetrics.grpcRegistry.metrics());
});

const openApiPath = path.join(__dirname, "..", "openapi.yaml");
app.get(["/openapi.yaml", "/api/openapi.yaml"], (req, res) => {
  if (fs.existsSync(openApiPath)) {
    res.setHeader("Content-Type", "text/yaml; charset=utf-8");
    fs.createReadStream(openApiPath).pipe(res);
  } else {
    res.status(404).send("openapi.yaml not found");
  }
});

app.get("/api/docs", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Secret Identity API - Swagger UI</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui.css" />
  <style>
    body { margin: 0; background: #fafafa; font-family: sans-serif; }
    .topbar { background: #1b3b8f; padding: 12px 20px; color: #ffd21f; font-weight: bold; font-size: 1.2rem; }
  </style>
</head>
<body>
  <div class="topbar">⚡ Secret Identity — OpenAPI Specification Explorer</div>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui-bundle.js"></script>
  <script>
    window.onload = () => {
      window.ui = SwaggerUIBundle({
        url: '/api/openapi.yaml',
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [SwaggerUIBundle.presets.apis],
        layout: "BaseLayout"
      });
    };
  </script>
</body>
</html>`);
});

app.get("/chaos/status", (req, res) => {
  res.json({
    delay_every_nth: chaos.delayEveryNth,
    delay_ms: chaos.delayMs,
    request_ordinal: chaos.requestOrdinal,
    cardinality_label_enabled: ENABLE_CARDINALITY_LABEL,
    demo_request_ids_seen: seenDemoRequestIds.size,
    max_cardinality_ids: MAX_CARDINALITY_IDS,
  });
});

// POST /chaos/delay?every=5&ms=500  — every 5th request waits 500ms. every=0 turns it off.
app.post("/chaos/delay", (req, res) => {
  const every = Number(req.query.every ?? 0);
  const ms = Number(req.query.ms ?? 0);
  if (!Number.isFinite(every) || every < 0 || every > 1000) {
    return res.status(400).json({ detail: "every must be 0..1000" });
  }
  if (!Number.isFinite(ms) || ms < 0 || ms > 10000) {
    return res.status(400).json({ detail: "ms must be 0..10000" });
  }
  chaos.delayEveryNth = every;
  chaos.delayMs = ms;
  chaos.requestOrdinal = 0;
  logger.warn({ delay_every_nth: every, delay_ms: ms }, "chaos delay updated");
  res.json({ status: "ok", delay_every_nth: every, delay_ms: ms });
});

app.post("/chaos/reset", (req, res) => {
  chaos.delayEveryNth = 0;
  chaos.delayMs = 0;
  chaos.requestOrdinal = 0;
  logger.info("chaos reset");
  res.json({ status: "ok", message: "delay injection cleared" });
});

app.post("/api/demo/hit", (req, res) => {
  const incoming = req.get("x-request-id");
  const requestId =
    incoming && /^[A-Za-z0-9._-]{1,64}$/.test(incoming) ? incoming : crypto.randomUUID();

  if (ENABLE_CARDINALITY_LABEL) {
    if (seenDemoRequestIds.size >= MAX_CARDINALITY_IDS && !seenDemoRequestIds.has(requestId)) {
      req.log.warn(
        { seen: seenDemoRequestIds.size, max: MAX_CARDINALITY_IDS },
        "cardinality cap reached; not creating new series"
      );
      return res.status(429).json({
        detail: `Stopped at ${MAX_CARDINALITY_IDS} unique request_id values.`,
        series_seen: seenDemoRequestIds.size,
      });
    }
    seenDemoRequestIds.add(requestId);
    demoRequests.inc({ request_id: requestId });
    req.log.info({ request_id: requestId, series_seen: seenDemoRequestIds.size }, "demo hit (labeled)");
    return res.json({
      status: "ok",
      labeled: true,
      request_id: requestId,
      series_seen: seenDemoRequestIds.size,
    });
  }

  demoRequests.inc();
  req.log.info({ request_id: requestId }, "demo hit (unlabeled)");
  res.json({ status: "ok", labeled: false, request_id: requestId });
});

app.get("/api/characters", (req, res) => {
  res.json(gameEngine.CHARACTERS.map((c) => c.name).sort());
});

app.post("/api/games", (req, res) => {
  const idempotencyKey = req.get("Idempotency-Key");
  const result = gameEngine.startNewGame(idempotencyKey);

  if (result.idempotent_replayed) {
    httpIdempotencyHits.inc({ route: "/api/games" });
    res.set("Idempotent-Replayed", "true");
    req.log.info({ game_id: result.game_id, idempotency_key: idempotencyKey }, "game start replayed");
    return res.status(200).json(result);
  }

  gamesStarted.inc();
  req.log.info({ game_id: result.game_id }, "game started");
  res.status(201).json(result);
});

app.get("/api/games/:gameId", (req, res) => {
  const game = gameEngine.getGame(req.params.gameId);
  if (!game) {
    return res.status(404).json({ detail: "Game not found." });
  }
  res.json(game);
});

function handleGuessSubmission(req, res) {
  const gameId = String(req.params.gameId).slice(0, 40);
  const rawName = req.body && req.body.name;
  const idempotencyKey = req.get("Idempotency-Key");

  if (!rawName || typeof rawName !== "string") {
    return res.status(400).json({ detail: "Please provide a valid character name in JSON body." });
  }

  const result = gameEngine.makeGuess(gameId, rawName, idempotencyKey);

  if (result.error) {
    req.log.warn({ game_id: gameId, reason: result.error }, "guess rejected");
    return res.status(result.status || 400).json({ detail: result.message });
  }

  if (result.idempotent_replayed) {
    httpIdempotencyHits.inc({ route: req.route ? req.baseUrl + req.route.path : "/api/games/:gameId/guesses" });
    res.set("Idempotent-Replayed", "true");
    req.log.info(
      { game_id: gameId, character: result.name, idempotency_key: idempotencyKey },
      "guess replayed from idempotency cache"
    );
    return res.json(result);
  }

  characterGuesses.inc({ character: result.name });
  req.log.info(
    { game_id: gameId, character: result.name, guesses_used: result.guesses_used },
    "guess made"
  );

  if (result.status !== "in_progress") {
    gamesFinished.inc({ result: result.status });
    guessesPerGame.observe({ result: result.status }, result.guesses_used);
    req.log.info(
      { game_id: gameId, result: result.status, guesses_used: result.guesses_used },
      "game finished"
    );
  }

  res.json(result);
}

app.post("/api/games/:gameId/guesses", checkRateLimit, handleGuessSubmission);
app.post("/api/games/:gameId/guess", checkRateLimit, handleGuessSubmission); // A1 path, same handler

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "static", "index.html"));
});

app.use((err, req, res, next) => {
  const status = err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status >= 500) req.log.error({ err }, "unhandled error");
  res.status(status).json({ detail: status >= 500 ? "Internal server error." : "Invalid request." });
});

const httpServer = app.listen(PORT, () => {
  logger.info({ port: Number(PORT) }, "HTTP server started");
  console.log(`[HTTP] listening on ${PORT}  docs: http://localhost:${PORT}/api/docs`);
});

try {
  grpcMetrics.startMetricsServer(GRPC_METRICS_PORT);
  grpcServer.startGrpcServer(GRPC_PORT);
} catch (grpcErr) {
  logger.error({ err: grpcErr }, "failed to start gRPC services");
}

module.exports = { app, httpServer };
