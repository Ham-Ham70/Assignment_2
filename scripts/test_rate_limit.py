#!/usr/bin/env python3
"""
Hammer POST /guesses until the 5/10s window returns 429 + Retry-After, then wait.
If a lucky guess ends the game (409), start another session and keep going.
"""

import sys
import time
import requests

BASE_URL = "http://localhost:8000"

def main():
    print("=" * 70)
    print(" SECRET IDENTITY — RATE LIMITING DEMONSTRATION")
    print("=" * 70)
    print("Endpoint Tested: POST /api/games/{gameId}/guesses")
    print("Configured Limit: 5 requests per 10-second sliding window")
    print("Quota Identity:   Per client IP address (shared across callers from same IP)")
    print("=" * 70)

    # 1. Create a game session
    print("\n[Step 1] Initializing a game session...")
    try:
        r = requests.post(f"{BASE_URL}/api/games", timeout=3.0)
        r.raise_for_status()
        game_id = r.json()["game_id"]
        print(f"  Game created successfully: game_id = {game_id}")
    except Exception as e:
        print(f"  Error connecting to server at {BASE_URL}: {e}")
        sys.exit(1)

    url = f"{BASE_URL}/api/games/{game_id}/guesses"
    headers = {"Content-Type": "application/json"}
    characters = ["Batman", "Superman", "Wonder Woman", "Flash", "Aquaman", "Cyborg", "Shazam"]

    # 2. Fire rapid requests to exhaust the quota
    print("\n[Step 2] Sending rapid requests in bursts to test quota exhaustion...")
    for i in range(1, 7):
        char = characters[i - 1]
        t0 = time.time()
        resp = requests.post(url, json={"name": char}, headers=headers, timeout=3.0)
        elapsed_ms = (time.time() - t0) * 1000

        print(f"\nRequest #{i}: Guessing '{char}'")
        print(f"  Status Code: HTTP {resp.status_code}")
        print(f"  X-RateLimit-Limit:     {resp.headers.get('X-RateLimit-Limit')}")
        print(f"  X-RateLimit-Remaining: {resp.headers.get('X-RateLimit-Remaining')}")
        print(f"  X-RateLimit-Reset:     {resp.headers.get('X-RateLimit-Reset')}")
        print(f"  Retry-After:           {resp.headers.get('Retry-After')}")
        print(f"  Response Body:         {resp.text[:120]}")

        if resp.status_code == 409:
            r = requests.post(f"{BASE_URL}/api/games", timeout=3.0)
            r.raise_for_status()
            game_id = r.json()["game_id"]
            url = f"{BASE_URL}/api/games/{game_id}/guesses"
            print(f"  Game ended early; continuing against new game_id = {game_id}")
            continue

        if resp.status_code == 429:
            print("\n  >>> RATE LIMIT TRIGGERED SUCCESSFULLY! <<<")
            retry_after = int(resp.headers.get("Retry-After", 1))
            print(f"  Server commanded Retry-After: {retry_after} seconds.")

            # 3. Wait for Retry-After and verify recovery
            wait_time = retry_after + 1.0
            print(f"\n[Step 3] Waiting for {wait_time:.1f}s for the rate-limiting window to reset...")
            time.sleep(wait_time)

            print("\n[Step 4] Submitting request after Retry-After cooldown...")
            char_recovery = characters[5]
            resp_recovery = requests.post(url, json={"name": char_recovery}, headers=headers, timeout=3.0)
            print(f"  Status Code: HTTP {resp_recovery.status_code}")
            print(f"  X-RateLimit-Limit:     {resp_recovery.headers.get('X-RateLimit-Limit')}")
            print(f"  X-RateLimit-Remaining: {resp_recovery.headers.get('X-RateLimit-Remaining')}")
            print(f"  Response Body:         {resp_recovery.text[:120]}")

            if resp_recovery.status_code == 200:
                print("\n  >>> RECOVERY VERIFIED! Window successfully reset. <<<")
            break

    print("\n" + "=" * 70)
    print(" RATE LIMITING DEMONSTRATION COMPLETE")
    print("=" * 70)

if __name__ == "__main__":
    main()
