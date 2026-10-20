// gRPC front door. Handlers call game-engine; the wrapper records metrics.
const path = require("path");
const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");
const gameEngine = require("./game-engine");
const metrics = require("./grpc-metrics");

const PROTO_PATH = path.join(__dirname, "..", "proto", "game.proto");
const GRPC_PORT = process.env.GRPC_PORT || 50051;
const SERVICE_NAME = "SecretIdentityService";

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});

const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
const gameProto = protoDescriptor.secretidentity;

function measureAndExecute(methodName, call, callback, executeFn) {
  metrics.grpcInFlight.inc({ grpc_service: SERVICE_NAME, grpc_method: methodName });
  const stopTimer = metrics.grpcHandlingSeconds.startTimer({
    grpc_service: SERVICE_NAME,
    grpc_method: methodName,
  });

  const reqSize = Buffer.byteLength(JSON.stringify(call.request || {}));
  metrics.grpcMsgReceivedBytes.observe(
    { grpc_service: SERVICE_NAME, grpc_method: methodName },
    reqSize
  );

  const done = (err, response, codeName = "OK") => {
    stopTimer();
    metrics.grpcInFlight.dec({ grpc_service: SERVICE_NAME, grpc_method: methodName });

    if (err) {
      metrics.grpcHandledTotal.inc({
        grpc_service: SERVICE_NAME,
        grpc_method: methodName,
        grpc_code: codeName,
      });
      return callback(err);
    }

    const respSize = Buffer.byteLength(JSON.stringify(response || {}));
    metrics.grpcMsgSentBytes.observe(
      { grpc_service: SERVICE_NAME, grpc_method: methodName },
      respSize
    );

    metrics.grpcHandledTotal.inc({
      grpc_service: SERVICE_NAME,
      grpc_method: methodName,
      grpc_code: "OK",
    });

    callback(null, response);
  };

  try {
    executeFn(done);
  } catch (err) {
    done(
      { code: grpc.status.INTERNAL, details: "Internal server error" },
      null,
      "INTERNAL"
    );
  }
}

const serviceImplementation = {
  getCharacters(call, callback) {
    measureAndExecute("GetCharacters", call, callback, (done) => {
      const filter = call.request.alignment_filter;
      const chars = gameEngine.getCharacters(filter);
      const characters = chars.map((c) => ({
        name: c.name,
        alignment: c.alignment,
        city: c.city,
        species: c.species,
        gender: c.gender,
        affiliations: c.affiliations,
        debut: c.debut,
      }));

      done(null, {
        characters,
        total_count: characters.length,
      });
    });
  },

  startGame(call, callback) {
    measureAndExecute("StartGame", call, callback, (done) => {
      const idempotencyKey = call.request.idempotency_key;
      const game = gameEngine.startNewGame(idempotencyKey);

      if (game.idempotent_replayed) {
        metrics.grpcIdempotencyHits.inc({
          grpc_service: SERVICE_NAME,
          grpc_method: "StartGame",
        });
      }

      done(null, {
        game_id: game.game_id,
        max_guesses: game.max_guesses,
        word_lengths: game.word_lengths,
      });
    });
  },

  makeGuess(call, callback) {
    measureAndExecute("MakeGuess", call, callback, (done) => {
      const { game_id, character_name, idempotency_key } = call.request;

      if (!game_id) {
        return done(
          { code: grpc.status.INVALID_ARGUMENT, details: "game_id is required" },
          null,
          "INVALID_ARGUMENT"
        );
      }
      if (!character_name || typeof character_name !== "string" || !character_name.trim()) {
        return done(
          { code: grpc.status.INVALID_ARGUMENT, details: "character_name must be a non-empty string" },
          null,
          "INVALID_ARGUMENT"
        );
      }

      const result = gameEngine.makeGuess(game_id, character_name, idempotency_key);

      if (result.error) {
        let code = grpc.status.INTERNAL;
        let codeName = "INTERNAL";

        if (result.error === "game_not_found") {
          code = grpc.status.NOT_FOUND;
          codeName = "NOT_FOUND";
        } else if (result.error === "game_over") {
          code = grpc.status.FAILED_PRECONDITION;
          codeName = "FAILED_PRECONDITION";
        } else if (result.error === "unknown_character") {
          code = grpc.status.INVALID_ARGUMENT;
          codeName = "INVALID_ARGUMENT";
        } else if (result.error === "duplicate_guess") {
          code = grpc.status.ALREADY_EXISTS;
          codeName = "ALREADY_EXISTS";
        }

        return done({ code, details: result.message }, null, codeName);
      }

      if (result.idempotent_replayed) {
        metrics.grpcIdempotencyHits.inc({
          grpc_service: SERVICE_NAME,
          grpc_method: "MakeGuess",
        });
      }

      done(null, {
        character_name: result.name,
        feedback: result.feedback,
        game_status: result.status,
        guesses_left: result.guesses_left,
        guesses_used: result.guesses_used,
        secret_answer: result.answer || "",
        idempotent_replayed: Boolean(result.idempotent_replayed),
      });
    });
  },

  getGameStatus(call, callback) {
    measureAndExecute("GetGameStatus", call, callback, (done) => {
      const { game_id } = call.request;
      if (!game_id) {
        return done(
          { code: grpc.status.INVALID_ARGUMENT, details: "game_id is required" },
          null,
          "INVALID_ARGUMENT"
        );
      }

      const game = gameEngine.getGame(game_id);
      if (!game) {
        return done(
          { code: grpc.status.NOT_FOUND, details: `Game '${game_id}' not found` },
          null,
          "NOT_FOUND"
        );
      }

      done(null, {
        game_id: game.game_id,
        status: game.status,
        guesses_used: game.guesses_used,
        guesses_left: game.guesses_left,
        guesses: game.guesses,
      });
    });
  },
};

function createGrpcServer() {
  const server = new grpc.Server();
  server.addService(gameProto.SecretIdentityService.service, serviceImplementation);
  return server;
}

function startGrpcServer(port = GRPC_PORT, callback) {
  const server = createGrpcServer();
  const bindAddress = `0.0.0.0:${port}`;

  server.bindAsync(bindAddress, grpc.ServerCredentials.createInsecure(), (err, boundPort) => {
    if (err) {
      console.error(`[gRPC] Failed to bind to ${bindAddress}:`, err);
      if (callback) callback(err);
      return;
    }
    console.log(`[gRPC] SecretIdentityService listening on ${bindAddress}`);
    if (callback) callback(null, server, boundPort);
  });

  return server;
}

if (require.main === module) {
  metrics.startMetricsServer();
  startGrpcServer();
}

module.exports = {
  createGrpcServer,
  startGrpcServer,
  serviceImplementation,
};
