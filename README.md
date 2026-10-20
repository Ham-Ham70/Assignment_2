# Secret Identity — Assignment 2

DC character guessing game from Assignment 1, plus an OpenAPI spec, safe retries, a small rate limiter, a Python HTTP caller with timeout / backoff / circuit breaker, a gRPC service, and HTTP vs gRPC Grafana panels.

No load test is required for this assignment.

## What you need

- Docker Compose v2
- Python 3.10+ for the callers and tests

```bash
pip install requests grpcio grpcio-tools
```

Node is only needed if you run the app outside Docker.

## Start

```bash
docker compose up -d --build
```

| Service | URL |
| --- | --- |
| Game | http://localhost:8000 |
| Swagger | http://localhost:8000/api/docs |
| OpenAPI file | http://localhost:8000/openapi.yaml |
| gRPC | `localhost:50051` |
| gRPC metrics | http://localhost:9091/metrics |
| Prometheus | http://localhost:9090/targets |
| Grafana | http://localhost:3000 (`admin` / `admin`) |

Comparison dashboard: **Secret Identity — HTTP vs gRPC**.

## Generate gRPC stubs (if you edit `proto/game.proto`)

```bash
python -m grpc_tools.protoc -I. --python_out=. --grpc_python_out=. proto/game.proto
```

## Tests and demos

```bash
py scripts/test_http_api.py      # valid, invalid, repeated (idempotent) HTTP calls
py scripts/test_rate_limit.py    # 5/10s window, then 429 + Retry-After
py scripts/http_caller.py        # timeout 1s, 3 retries, breaker 3 failures / 3s recovery
py scripts/grpc_caller.py 5      # success + expected RPC errors for Grafana
```

(`python` instead of `py` is fine if that is what your PATH uses.)

Optional background traffic (not required):

```bash
node scripts/load.js --duration 60 --players 2
```

Rebuild the HTML report after editing `REPORT_2.md`:

```bash
python scripts/generate_report_html.py
```

## Layout

```
app/                HTTP server, game engine, gRPC server + metrics
proto/game.proto    schema; generated Python stubs sit next to it
openapi.yaml
scripts/            HTTP/gRPC callers and tests
prometheus/         scrapes app:8000 and app:9091
grafana/dashboards/ A1 boards plus the HTTP vs gRPC board
report-assets/      screenshots used in REPORT_2.md
REPORT.md           Assignment 1 write-up
REPORT_2.md         Assignment 2 write-up
```

## Stop

```bash
docker compose down
```

`docker compose down -v` also drops volumes. Those data dirs are gitignored.

## Credit

Course labs (Midnight Launch / gRPC workshop), Nygard circuit breaker, RFC 6585 `429` + `Retry-After`.
