// Shared judging + in-memory games. HTTP and gRPC both call this.

const crypto = require("crypto");
const CHARACTERS = require("./characters.json");

const MAX_GUESSES = 8;
const GAME_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const BY_NAME = new Map(CHARACTERS.map((c) => [c.name.toLowerCase(), c]));

const games = new Map();
const idempotencyCache = new Map(); // start-game keys, 10 minute TTL
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;

const lettersOnly = (text) => (text || "").replace(/[^A-Za-z]/g, "");

const wordLengths = (name) => (name || "").split(/\s+/).map((w) => lettersOnly(w).length);

const compareExact = (guess, secret) => (guess === secret ? "match" : "miss");

const compareSets = (guess, secret) => {
  const g = new Set(guess || []);
  const s = new Set(secret || []);
  const overlap = [...g].filter((x) => s.has(x)).length;
  if (overlap === g.size && overlap === s.size) return "match";
  return overlap > 0 ? "partial" : "miss";
};

// "higher" / "lower" are from player's point of view of the secret
const compareNumber = (guess, secret) => {
  if (guess === secret) return "match";
  return secret > guess ? "higher" : "lower";
};

function judge(guess, secret) {
  const gLen = lettersOnly(guess.name).length;
  const sLen = lettersOnly(secret.name).length;
  return {
    alignment: { value: guess.alignment, status: compareExact(guess.alignment, secret.alignment) },
    city: { value: guess.city, status: compareExact(guess.city, secret.city) },
    species: { value: guess.species, status: compareExact(guess.species, secret.species) },
    gender: { value: guess.gender, status: compareExact(guess.gender, secret.gender) },
    affiliations: {
      value: (guess.affiliations || []).join(", "),
      status: compareSets(guess.affiliations, secret.affiliations),
    },
    debut: { value: String(guess.debut), status: compareNumber(guess.debut, secret.debut) },
    letters: { value: String(gLen), status: compareNumber(gLen, sLen) },
  };
}

function purgeOldGames() {
  const cutoff = Date.now() - GAME_TTL_MS;
  let removed = 0;
  for (const [id, game] of games) {
    if (game.created < cutoff) {
      games.delete(id);
      removed++;
    }
  }

  // Drop old start-game replay records too.
  const idemCutoff = Date.now() - IDEMPOTENCY_TTL_MS;
  for (const [key, record] of idempotencyCache) {
    if (record.timestamp < idemCutoff) {
      idempotencyCache.delete(key);
    }
  }

  return removed;
}

function startNewGame(idempotencyKey) {
  purgeOldGames();

  // Same key → same game_id, no second secret.
  if (idempotencyKey && idempotencyCache.has(`create:${idempotencyKey}`)) {
    const cached = idempotencyCache.get(`create:${idempotencyKey}`);
    return { ...cached.response, idempotent_replayed: true };
  }

  const secret = CHARACTERS[Math.floor(Math.random() * CHARACTERS.length)];
  const gameId = crypto.randomBytes(6).toString("hex");
  const gameRecord = {
    secret,
    guesses: [],
    guessHistory: [],
    status: "in_progress",
    created: Date.now(),
    idempotencyKeys: new Map(),
  };
  games.set(gameId, gameRecord);

  const response = {
    game_id: gameId,
    max_guesses: MAX_GUESSES,
    word_lengths: wordLengths(secret.name),
    idempotent_replayed: false,
  };

  if (idempotencyKey) {
    idempotencyCache.set(`create:${idempotencyKey}`, {
      response,
      statusCode: 201,
      timestamp: Date.now(),
    });
  }

  return response;
}

function makeGuess(gameId, rawCharacterName, idempotencyKey) {
  const game = games.get(gameId);
  if (!game) {
    return { error: "game_not_found", message: "Game not found. Start a new game.", status: 404 };
  }

  // Retry of the same key: give the old clues back, do not spend a turn.
  if (idempotencyKey && game.idempotencyKeys.has(idempotencyKey)) {
    const cached = game.idempotencyKeys.get(idempotencyKey);
    return { ...cached, idempotent_replayed: true };
  }

  if (game.status !== "in_progress") {
    return { error: "game_over", message: "This game is already over. Start a new game.", status: 409 };
  }

  const guess = typeof rawCharacterName === "string" ? BY_NAME.get(rawCharacterName.trim().toLowerCase()) : undefined;
  if (!guess) {
    return { error: "unknown_character", message: "Pick a character from the DC roster list.", status: 400 };
  }

  if (game.guesses.includes(guess.name)) {
    // Same name again in this session — replay, do not error the way A1 did.
    const priorFeedback = game.guessHistory.find((h) => h.name === guess.name);
    if (priorFeedback) {
      return {
        ...priorFeedback,
        message: "Same guess as before — clues replayed, no extra turn.",
        idempotent_replayed: true,
      };
    }
    return { error: "duplicate_guess", message: "You already guessed that character.", status: 400 };
  }

  game.guesses.push(guess.name);
  const feedback = judge(guess, game.secret);

  if (guess.name === game.secret.name) {
    game.status = "won";
  } else if (game.guesses.length >= MAX_GUESSES) {
    game.status = "lost";
  }

  const result = {
    name: guess.name,
    feedback,
    status: game.status,
    guesses_used: game.guesses.length,
    guesses_left: MAX_GUESSES - game.guesses.length,
    idempotent_replayed: false,
  };

  if (game.status !== "in_progress") {
    result.answer = game.secret.name;
  }

  game.guessHistory.push(result);

  if (idempotencyKey) {
    game.idempotencyKeys.set(idempotencyKey, result);
  }

  return result;
}

function getGame(gameId) {
  const game = games.get(gameId);
  if (!game) return null;
  return {
    game_id: gameId,
    status: game.status,
    guesses_used: game.guesses.length,
    guesses_left: MAX_GUESSES - game.guesses.length,
    guesses: [...game.guesses],
    created: game.created,
  };
}

function getCharacters(filter) {
  if (!filter) return [...CHARACTERS];
  const f = filter.toLowerCase();
  return CHARACTERS.filter((c) => c.alignment.toLowerCase() === f);
}

module.exports = {
  CHARACTERS,
  BY_NAME,
  MAX_GUESSES,
  games,
  judge,
  lettersOnly,
  wordLengths,
  purgeOldGames,
  startNewGame,
  makeGuess,
  getGame,
  getCharacters,
};
