// Fake players for dashboards and Kibana.
//
//   node scripts/load.js [--url http://localhost:8000] [--duration 60]
//                        [--players 2] [--think 400] [--seed 1]
//
// Rough RPS ≈ players * 1000 / think  (defaults ~5 req/s).

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]]);
    return acc;
  }, [])
);
const BASE = args.url || "http://localhost:8000";
const DURATION_S = Number(args.duration || 60);
const PLAYERS = Number(args.players || 2);
const THINK_MS = Number(args.think || 400);
const SEED = Number(args.seed || 1);

// Small seeded random number generator (mulberry32) so runs can be repeated.
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = makeRng(SEED);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stats = { requests: 0, failed: 0, games: 0, won: 0, lost: 0, abandoned: 0, latencies: [] };

async function call(method, path, body) {
  const start = performance.now();
  stats.requests++;
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    stats.latencies.push(performance.now() - start);
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } catch (err) {
    stats.failed++;
    return { status: 0, data: {} };
  }
}

async function player(names, deadline) {
  while (Date.now() < deadline) {
    const started = await call("POST", "/api/games");
    if (started.status !== 200 && started.status !== 201) { await sleep(1000); continue; }
    stats.games++;
    const gameId = started.data.game_id;
    const pool = [...names].sort(() => rng() - 0.5);

    // 10% of players walk away mid-game, which keeps games_active above zero
    const abandonAfter = rng() < 0.1 ? 1 + Math.floor(rng() * 3) : Infinity;
    let guesses = 0;

    while (Date.now() < deadline) {
      await sleep(THINK_MS * (0.5 + rng())); // 0.5x to 1.5x think time

      if (rng() < 0.05) { // occasional typo -> a 400 response
        await call("POST", `/api/games/${gameId}/guesses`, { name: "Nobody" });
        continue;
      }
      const result = await call("POST", `/api/games/${gameId}/guesses`, { name: pool.pop() });
      if (result.status !== 200) break;
      guesses++;
      if (result.data.status === "won") { stats.won++; break; }
      if (result.data.status === "lost") { stats.lost++; break; }
      if (guesses >= abandonAfter) { stats.abandoned++; break; }
    }
  }
}

function pct(sorted, p) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;
}

async function main() {
  const listed = await call("GET", "/api/characters");
  if (listed.status !== 200) {
    console.error(`Cannot reach ${BASE}. Is the app running?`);
    process.exit(1);
  }
  const names = listed.data;
  console.log(`Load test: ${PLAYERS} players, think ${THINK_MS} ms, ${DURATION_S}s, seed ${SEED}, target ${BASE}`);
  const startedAt = Date.now();
  const deadline = startedAt + DURATION_S * 1000;

  const ticker = setInterval(() => {
    const s = Math.round((Date.now() - startedAt) / 1000);
    console.log(`  ${s}s: ${stats.requests} requests, ${stats.games} games`);
  }, 10000);

  await Promise.all(Array.from({ length: PLAYERS }, () => player(names, deadline)));
  clearInterval(ticker);

  const sorted = stats.latencies.slice().sort((a, b) => a - b);
  const avg = sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1);
  const elapsed = (Date.now() - startedAt) / 1000;
  console.log("\nDone.");
  console.log(`  requests: ${stats.requests} (${(stats.requests / elapsed).toFixed(1)}/s), connection failures: ${stats.failed}`);
  console.log(`  games: ${stats.games} started, ${stats.won} won, ${stats.lost} lost, ${stats.abandoned} abandoned`);
  console.log(`  client-side latency: avg ${avg.toFixed(1)} ms, p95 ${pct(sorted, 0.95).toFixed(1)} ms, max ${(sorted[sorted.length - 1] || 0).toFixed(1)} ms`);
}

main();