#!/usr/bin/env python3
"""
HTTP checks: health, spec, a good start/guess, a replayed key, and bad input.
"""

import sys
import uuid
import requests

BASE_URL = "http://localhost:8000"

def test_http_api():
    passed = 0
    total = 0

    def check(name, condition, extra=""):
        nonlocal passed, total
        total += 1
        if condition:
            passed += 1
            print(f"  [PASS] {name} {extra}")
        else:
            print(f"  [FAIL] {name} {extra}")

    print("=" * 70)
    print(" SECRET IDENTITY — HTTP API AUTOMATED TEST SUITE")
    print("=" * 70)
    print(f"Testing API server at: {BASE_URL}\n")

    # Test 1: Health check
    try:
        r = requests.get(f"{BASE_URL}/api/health", timeout=3.0)
        check("Health check (GET /api/health)", r.status_code == 200 and r.json().get("status") == "ok")
    except Exception as e:
        print(f"Cannot reach server at {BASE_URL}: {e}")
        sys.exit(1)

    # Test 2: Character catalog
    r = requests.get(f"{BASE_URL}/api/characters", timeout=3.0)
    data = r.json()
    check("Character catalog (GET /api/characters)", r.status_code == 200 and isinstance(data, list) and "Batman" in data, f"({len(data)} characters)")

    # Test 3: OpenAPI document
    r = requests.get(f"{BASE_URL}/openapi.yaml", timeout=3.0)
    check("OpenAPI YAML specification (GET /openapi.yaml)", r.status_code == 200 and "openapi: 3.0" in r.text)

    # Test 4: Swagger UI docs
    r = requests.get(f"{BASE_URL}/api/docs", timeout=3.0)
    check("Interactive Swagger UI (GET /api/docs)", r.status_code == 200 and "SwaggerUIBundle" in r.text)

    # Test 5: Valid request - Start Game
    start_key = f"test-game-{uuid.uuid4().hex[:8]}"
    r = requests.post(f"{BASE_URL}/api/games", headers={"Idempotency-Key": start_key}, timeout=3.0)
    check("Start game valid request (POST /api/games)", r.status_code == 201 and "game_id" in r.json())
    game_id = r.json().get("game_id")

    # Test 6: Repeated request - Start Game with same Idempotency-Key
    r_repeat = requests.post(f"{BASE_URL}/api/games", headers={"Idempotency-Key": start_key}, timeout=3.0)
    is_idempotent = (
        r_repeat.status_code == 200 and
        r_repeat.json().get("game_id") == game_id and
        r_repeat.headers.get("Idempotent-Replayed") == "true" and
        r_repeat.json().get("idempotent_replayed") is True
    )
    check("Safe repeated start game (Idempotency-Key replay)", is_idempotent, f"(returned same game_id: {game_id})")

    # Test 7: Valid request - Make Guess
    guess_key = f"test-guess-{uuid.uuid4().hex[:8]}"
    r_guess = requests.post(
        f"{BASE_URL}/api/games/{game_id}/guesses",
        json={"name": "Batman"},
        headers={"Idempotency-Key": guess_key},
        timeout=3.0
    )
    guess_data = r_guess.json()
    check(
        "Valid guess request (POST /api/games/:id/guesses)",
        r_guess.status_code == 200 and guess_data.get("name") == "Batman" and "feedback" in guess_data,
        f"(guesses_left: {guess_data.get('guesses_left')})"
    )

    # Test 8: Repeated request - Make Guess with same Idempotency-Key
    r_guess_repeat = requests.post(
        f"{BASE_URL}/api/games/{game_id}/guesses",
        json={"name": "Batman"},
        headers={"Idempotency-Key": guess_key},
        timeout=3.0
    )
    guess_repeat_data = r_guess_repeat.json()
    is_guess_idempotent = (
        r_guess_repeat.status_code == 200 and
        guess_repeat_data.get("name") == "Batman" and
        r_guess_repeat.headers.get("Idempotent-Replayed") == "true" and
        guess_repeat_data.get("guesses_left") == guess_data.get("guesses_left")
    )
    check(
        "Safe repeated guess (Idempotency-Key replay, no turn penalty)",
        is_guess_idempotent,
        f"(guesses_left preserved: {guess_repeat_data.get('guesses_left')})"
    )

    # Test 9: Invalid input - Character not in DC catalog
    r_invalid_char = requests.post(
        f"{BASE_URL}/api/games/{game_id}/guesses",
        json={"name": "Thanos-Marvel"},
        timeout=3.0
    )
    check(
        "Invalid input - Unknown character (400 Bad Request)",
        r_invalid_char.status_code == 400 and "Pick a character from the DC roster list" in r_invalid_char.text
    )

    # Test 10: Invalid input - Missing/empty JSON body
    r_empty_body = requests.post(
        f"{BASE_URL}/api/games/{game_id}/guesses",
        json={},
        timeout=3.0
    )
    check(
        "Invalid input - Empty request body (400 Bad Request)",
        r_empty_body.status_code == 400 and "valid character name" in r_empty_body.text
    )

    # Test 11: Invalid input - Non-existent game ID
    r_missing_game = requests.post(
        f"{BASE_URL}/api/games/nonexistent000000/guesses",
        json={"name": "Batman"},
        timeout=3.0
    )
    check(
        "Invalid resource - Missing game ID (404 Not Found)",
        r_missing_game.status_code == 404 and "Game not found" in r_missing_game.text
    )

    # Test 12: Backward compatibility alias route
    # If previous rapid calls exhausted the 5 req/10s quota, respect Retry-After
    import time
    r_alias = requests.post(
        f"{BASE_URL}/api/games/{game_id}/guess",
        json={"name": "Superman"},
        timeout=3.0
    )
    if r_alias.status_code == 429:
        retry_wait = int(r_alias.headers.get("Retry-After", 2)) + 0.5
        print(f"  [Rate Limit] Waiting {retry_wait:.1f}s for quota reset before testing alias...")
        time.sleep(retry_wait)
        r_alias = requests.post(
            f"{BASE_URL}/api/games/{game_id}/guess",
            json={"name": "Superman"},
            timeout=3.0
        )

    check(
        "Legacy alias route compatibility (POST /api/games/:id/guess)",
        r_alias.status_code == 200 and r_alias.json().get("name") == "Superman"
    )

    print("\n" + "=" * 70)
    print(f" TEST RESULTS: {passed}/{total} TESTS PASSED")
    print("=" * 70)
    if passed == total:
        print(" ALL HTTP API TESTS PASSED SUCCESSFULLY!")
    else:
        print(f" WARNING: {total - passed} tests failed.")
        sys.exit(1)

if __name__ == "__main__":
    test_http_api()
