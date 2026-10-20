// Slow-request experiment: baseline → delay every 5th request by 500ms → recover.
// Needs the stack on :8000 and :9090.
//
//   node scripts/experiment-delay.js

const BASE = process.env.APP_URL || "http://localhost:8000";
const PROM = process.env.PROM_URL || "http://localhost:9090";
const STAGE_S = Number(process.env.STAGE_S || 45);
const PLAYERS = 2;
const THINK_MS = 300;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(url, opts) {
  const res = await fetch(url, opts);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function promQuery(expr) {
  const url = `${PROM}/api/v1/query?query=${encodeURIComponent(expr)}`;
  const res = await fetch(url);
  const data = await res.json();
  const sample = data?.data?.result?.[0]?.value?.[1];
  return sample != null ? Number(sample) : null;
}

async function snapshot(label) {
  const p95 = await promQuery(
    'histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{route="/api/games"}[1m])) by (le))'
  );
  const avg = await promQuery(
    'sum(rate(http_request_duration_seconds_sum{route="/api/games"}[1m])) / sum(rate(http_request_duration_seconds_count{route="/api/games"}[1m]))'
  );
  const rps = await promQuery('sum(rate(http_requests_total{route="/api/games"}[1m]))');
  const fmt = (v, unit) => (v != null ? `${(v * (unit === "ms" ? 1000 : 1)).toFixed(unit === "ms" ? 0 : 2)}${unit === "ms" ? "ms" : ""}` : "n/a");
  console.log(
    `  [${label}] p95≈${fmt(p95, "ms")}  avg≈${fmt(avg, "ms")}  rps≈${rps != null ? rps.toFixed(2) : "n/a"}`
  );
}

async function loadFor(seconds) {
  const names = (await json(`${BASE}/api/characters`)).body;
  const deadline = Date.now() + seconds * 1000;

  async function player() {
    while (Date.now() < deadline) {
      const g = await json(`${BASE}/api/games`, { method: "POST" });
      if (g.status !== 200) {
        await sleep(500);
        continue;
      }
      const pick = names[Math.floor(Math.random() * names.length)];
      await json(`${BASE}/api/games/${g.body.game_id}/guess`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: pick }),
      });
      await sleep(THINK_MS);
    }
  }

  await Promise.all(Array.from({ length: PLAYERS }, () => player()));
}

async function setDelay(every, ms) {
  const r = await json(`${BASE}/chaos/delay?every=${every}&ms=${ms}`, { method: "POST" });
  console.log("  chaos/delay →", r.body);
}

async function main() {
  if ((await json(`${BASE}/api/health`)).status !== 200) {
    console.error(`App not reachable at ${BASE}`);
    process.exit(1);
  }

  console.log("Slow-request experiment");
  console.log(`Each stage ~${STAGE_S}s. Watch Grafana p95 and Kibana: message:\"chaos delay injected\"\n`);

  console.log("1) Baseline");
  await setDelay(0, 0);
  await loadFor(STAGE_S);
  await sleep(6000);
  await snapshot("baseline");

  console.log("\n2) Inject delay (every 5th request +500ms)");
  await setDelay(5, 500);
  await loadFor(STAGE_S);
  await sleep(6000);
  await snapshot("during-delay");

  console.log("\n3) Recover");
  await setDelay(0, 0);
  await loadFor(STAGE_S);
  await sleep(6000);
  await snapshot("after-recover");

  console.log("\nDone.");
  console.log("PromQL: histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[1m])) by (le))");
  console.log('Kibana: message:"chaos delay injected"');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
