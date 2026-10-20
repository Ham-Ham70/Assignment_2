// Hit /api/demo/hit many times and watch count(demo_requests_total) in Prometheus.
//
// With label (expect ~100 series):
//   $env:ENABLE_CARDINALITY_LABEL="1"; docker compose up -d --build app
//   node scripts/experiment-cardinality.js
//
// Without label (expect ~1 series):
//   $env:ENABLE_CARDINALITY_LABEL="0"; docker compose up -d --build app
//   node scripts/experiment-cardinality.js --safe

const BASE = process.env.APP_URL || "http://localhost:8000";
const PROM = process.env.PROM_URL || "http://localhost:9090";
const HITS = Math.min(100, Number(process.env.HITS || 100));
const safeMode = process.argv.includes("--safe");

async function seriesCount() {
  const url = `${PROM}/api/v1/query?query=${encodeURIComponent("count(demo_requests_total)")}`;
  const res = await fetch(url);
  const data = await res.json();
  const results = data?.data?.result || [];
  return results.length ? Number(results[0].value[1]) : 0;
}

async function main() {
  const status = await (await fetch(`${BASE}/chaos/status`)).json();
  console.log("Cardinality experiment");
  console.log("status:", status);

  if (!safeMode && !status.cardinality_label_enabled) {
    console.error(
      'Rebuild with the label first:\n  $env:ENABLE_CARDINALITY_LABEL="1"; docker compose up -d --build app'
    );
    process.exit(1);
  }
  if (safeMode && status.cardinality_label_enabled) {
    console.error(
      'Rebuild without the label first:\n  $env:ENABLE_CARDINALITY_LABEL="0"; docker compose up -d --build app'
    );
    process.exit(1);
  }

  console.log(`\ncount(demo_requests_total) before = ${await seriesCount()}`);
  console.log(`Sending ${HITS} unique X-Request-ID hits...`);

  let ok = 0;
  let capped = 0;
  for (let i = 0; i < HITS; i++) {
    const id = `card-${String(i).padStart(3, "0")}`;
    const res = await fetch(`${BASE}/api/demo/hit`, {
      method: "POST",
      headers: { "X-Request-ID": id },
    });
    if (res.status === 200) ok++;
    else if (res.status === 429) capped++;
  }
  console.log(`  ok=${ok}, capped=${capped}`);

  console.log("Waiting for Prometheus scrapes...");
  await new Promise((r) => setTimeout(r, 8000));
  console.log(`count(demo_requests_total) after  = ${await seriesCount()}`);

  if (!safeMode) {
    console.log("\nShould be close to 100. Next: rebuild without the label and run with --safe.");
  } else {
    console.log("\nShould stay near 1. Older labeled series can still show up in past time ranges.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
