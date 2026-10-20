# Kibana queries

## Setup (once)

1. Generate a log: play at http://localhost:8000 or `POST http://localhost:8000/api/games`
2. Kibana → Stack Management → Data Views → Create
3. Name: `Secret Identity Logs`
4. Index pattern: `secret-identity-logs-*`
5. Timestamp: `@timestamp`
6. Discover → select that data view

## Useful searches

```kql
service: "secret-identity"
```

```kql
container.name: "secret-identity-app"
```

```kql
level: error or level: warn
```

```kql
request_id: "PASTE-UUID-HERE"
```

```kql
message: "chaos delay injected"
```

```kql
duration_ms >= 400
```

```kql
message: "game started" or message: "guess made" or message: "game finished"
```

```kql
message: "guess rejected"
```

## Fields after Filebeat decode

| Field | From |
| --- | --- |
| `@timestamp`, `level`, `service`, `message` | App |
| `request_id` | App (per request) |
| `method`, `route`, `status_code`, `duration_ms` | App (`request completed`) |
| `game_id`, `character`, `result` | App (game events) |
| `container.name` | Filebeat |

## Example raw log line

```json
{"level":"info","service":"secret-identity","request_id":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","method":"POST","route":"/api/games","status_code":200,"duration_ms":3.2,"message":"request completed","@timestamp":"2026-09-23T11:00:00.000Z"}
```
