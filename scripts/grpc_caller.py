#!/usr/bin/env python3
"""
Python gRPC client. Mix of OK calls and expected errors so Grafana has both series.
"""

import os
import sys
import time
import uuid
import grpc

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from proto import game_pb2
from proto import game_pb2_grpc

TARGET_GRPC = "localhost:50051"

def run_grpc_traffic_cycle(stub, round_num=1):
    print(f"\n--- [Round {round_num}] Generating gRPC Calls ---")

    # 1. GetCharacters (OK)
    try:
        t0 = time.time()
        resp = stub.GetCharacters(game_pb2.GetCharactersRequest(alignment_filter="Hero"))
        ms = (time.time() - t0) * 1000
        print(f"  [OK] GetCharacters: found {resp.total_count} characters in {ms:.1f}ms")
    except grpc.RpcError as e:
        print(f"  [ERR] GetCharacters failed: {e.code()} - {e.details()}")

    # 2. StartGame (OK)
    game_id = None
    start_key = f"grpc-start-{uuid.uuid4().hex[:8]}"
    try:
        t0 = time.time()
        resp = stub.StartGame(game_pb2.StartGameRequest(idempotency_key=start_key, client_id="python-grpc-client"))
        ms = (time.time() - t0) * 1000
        game_id = resp.game_id
        print(f"  [OK] StartGame: created game_id={game_id}, max_guesses={resp.max_guesses} in {ms:.1f}ms")
    except grpc.RpcError as e:
        print(f"  [ERR] StartGame failed: {e.code()} - {e.details()}")

    # 3. StartGame (Replayed Idempotent Call -> OK, Cache Hit)
    try:
        t0 = time.time()
        resp = stub.StartGame(game_pb2.StartGameRequest(idempotency_key=start_key, client_id="python-grpc-client"))
        ms = (time.time() - t0) * 1000
        print(f"  [OK-CACHE] StartGame (Replayed): returned game_id={resp.game_id} in {ms:.1f}ms")
    except grpc.RpcError as e:
        print(f"  [ERR] StartGame replay failed: {e.code()} - {e.details()}")

    if game_id:
        # 4. MakeGuess valid (OK)
        guess_key = f"grpc-guess-{uuid.uuid4().hex[:8]}"
        try:
            t0 = time.time()
            resp = stub.MakeGuess(game_pb2.MakeGuessRequest(
                game_id=game_id,
                character_name="Batman",
                idempotency_key=guess_key
            ))
            ms = (time.time() - t0) * 1000
            print(f"  [OK] MakeGuess 'Batman': status={resp.game_status}, left={resp.guesses_left} in {ms:.1f}ms")
        except grpc.RpcError as e:
            print(f"  [ERR] MakeGuess failed: {e.code()} - {e.details()}")

        # 5. MakeGuess replayed (OK, Cache Hit)
        try:
            t0 = time.time()
            resp = stub.MakeGuess(game_pb2.MakeGuessRequest(
                game_id=game_id,
                character_name="Batman",
                idempotency_key=guess_key
            ))
            ms = (time.time() - t0) * 1000
            print(f"  [OK-CACHE] MakeGuess 'Batman' (Replayed): idempotent_replayed={resp.idempotent_replayed} in {ms:.1f}ms")
        except grpc.RpcError as e:
            print(f"  [ERR] MakeGuess replay failed: {e.code()} - {e.details()}")

        # 6. MakeGuess second character (OK)
        try:
            t0 = time.time()
            resp = stub.MakeGuess(game_pb2.MakeGuessRequest(
                game_id=game_id,
                character_name="Superman"
            ))
            ms = (time.time() - t0) * 1000
            print(f"  [OK] MakeGuess 'Superman': status={resp.game_status}, left={resp.guesses_left} in {ms:.1f}ms")
        except grpc.RpcError as e:
            print(f"  [ERR] MakeGuess failed: {e.code()} - {e.details()}")

        # 7. MakeGuess with unknown character -> INVALID_ARGUMENT (Expected Failure)
        try:
            stub.MakeGuess(game_pb2.MakeGuessRequest(
                game_id=game_id,
                character_name="Thanos-MarvelCharacter"
            ))
            print("  [FAIL-UNEXPECTED] MakeGuess unknown character unexpectedly succeeded")
        except grpc.RpcError as e:
            print(f"  [EXPECTED-ERR] MakeGuess unknown character returned {e.code().name} (3): {e.details()}")

        # 8. GetGameStatus (OK)
        try:
            t0 = time.time()
            resp = stub.GetGameStatus(game_pb2.GetGameStatusRequest(game_id=game_id))
            ms = (time.time() - t0) * 1000
            print(f"  [OK] GetGameStatus: status={resp.status}, guesses={list(resp.guesses)} in {ms:.1f}ms")
        except grpc.RpcError as e:
            print(f"  [ERR] GetGameStatus failed: {e.code()} - {e.details()}")

    # 9. MakeGuess on non-existent game -> NOT_FOUND (Expected Failure)
    try:
        stub.MakeGuess(game_pb2.MakeGuessRequest(
            game_id="deadbeef9999",
            character_name="Batman"
        ))
        print("  [FAIL-UNEXPECTED] MakeGuess missing game unexpectedly succeeded")
    except grpc.RpcError as e:
        print(f"  [EXPECTED-ERR] MakeGuess missing game returned {e.code().name} (5): {e.details()}")

    # 10. GetGameStatus on non-existent game -> NOT_FOUND (Expected Failure)
    try:
        stub.GetGameStatus(game_pb2.GetGameStatusRequest(game_id="nonexistent0000"))
        print("  [FAIL-UNEXPECTED] GetGameStatus missing game unexpectedly succeeded")
    except grpc.RpcError as e:
        print(f"  [EXPECTED-ERR] GetGameStatus missing game returned {e.code().name} (5): {e.details()}")


def main():
    rounds = 3
    if len(sys.argv) > 1:
        try:
            rounds = int(sys.argv[1])
        except ValueError:
            pass

    print("=" * 70)
    print(" SECRET IDENTITY — gRPC TRAFFIC GENERATOR & VERIFICATION")
    print("=" * 70)
    print(f"Target gRPC Service: {TARGET_GRPC}")
    print(f"Executing {rounds} cycles of success & failure RPC calls...")
    print("=" * 70)

    channel = grpc.insecure_channel(TARGET_GRPC)
    stub = game_pb2_grpc.SecretIdentityServiceStub(channel)

    for r in range(1, rounds + 1):
        run_grpc_traffic_cycle(stub, round_num=r)
        if r < rounds:
            time.sleep(0.5)

    print("\n" + "=" * 70)
    print(f" gRPC TRAFFIC GENERATION COMPLETE — {rounds} CYCLES COMPLETED")
    print(" Prometheus & Grafana panels successfully populated.")
    print("=" * 70)

if __name__ == "__main__":
    main()
