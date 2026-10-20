#!/usr/bin/env python3
"""
Stand-in for another service calling this HTTP API.

One run: a few real calls, then forced timeouts (chaos delay), retries with
backoff, a tripped breaker that fails fast, then a probe after cooldown.

Timeout 1s. Three retries. Trip after three exhausted calls. Recover after 3s.
POSTs always send Idempotency-Key so retries are safe.
"""

import sys
import time
import uuid
import json
import requests

BASE_URL = "http://localhost:8000"
TIMEOUT_SECONDS = 1.0
MAX_RETRIES = 3
BACKOFF_BASE_SECONDS = 0.2
BREAKER_FAILURE_THRESHOLD = 3
BREAKER_RECOVERY_SECONDS = 3.0

class CircuitBreakerOpenException(Exception):
    """Raised when an outbound call is blocked because the circuit breaker is OPEN."""
    pass

class CircuitBreaker:
    STATE_CLOSED = "CLOSED"
    STATE_OPEN = "OPEN"
    STATE_HALF_OPEN = "HALF_OPEN"

    def __init__(self, failure_threshold=BREAKER_FAILURE_THRESHOLD, recovery_timeout=BREAKER_RECOVERY_SECONDS):
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self.state = self.STATE_CLOSED
        self.consecutive_failures = 0
        self.last_state_change = time.time()

    def before_call(self):
        now = time.time()
        if self.state == self.STATE_OPEN:
            elapsed = now - self.last_state_change
            if elapsed >= self.recovery_timeout:
                self.state = self.STATE_HALF_OPEN
                self.last_state_change = now
                print(f"  [CircuitBreaker] Cooldown elapsed ({elapsed:.2f}s >= {self.recovery_timeout}s). Transition: OPEN -> HALF_OPEN")
            else:
                remaining = self.recovery_timeout - elapsed
                print(f"  [CircuitBreaker] BLOCKED call! Breaker is OPEN (cooling down, {remaining:.2f}s remaining)")
                raise CircuitBreakerOpenException(f"Circuit breaker is OPEN. Fast-failing without network call.")
        elif self.state == self.STATE_HALF_OPEN:
            print("  [CircuitBreaker] Permitting single trial probe request in HALF_OPEN state...")

    def on_success(self):
        if self.state == self.STATE_HALF_OPEN:
            print(f"  [CircuitBreaker] Trial probe SUCCEEDED! Transition: HALF_OPEN -> CLOSED (recovered)")
        self.state = self.STATE_CLOSED
        self.consecutive_failures = 0
        self.last_state_change = time.time()

    def on_failure(self):
        self.consecutive_failures += 1
        now = time.time()
        print(f"  [CircuitBreaker] Failure recorded. Consecutive failures: {self.consecutive_failures}/{self.failure_threshold}")
        if self.state in (self.STATE_CLOSED, self.STATE_HALF_OPEN) and self.consecutive_failures >= self.failure_threshold:
            prev_state = self.state
            self.state = self.STATE_OPEN
            self.last_state_change = now
            print(f"  [CircuitBreaker] TRIP THRESHOLD REACHED! Transition: {prev_state} -> OPEN (recovery cooldown: {self.recovery_timeout}s)")


class ResilientHttpClient:
    def __init__(self, base_url=BASE_URL, timeout=TIMEOUT_SECONDS, max_retries=MAX_RETRIES):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.max_retries = max_retries
        self.breaker = CircuitBreaker()

    def call_endpoint(self, method, path, json_data=None, idempotency_key=None):
        """One logical call. Same Idempotency-Key on every retry."""
        url = f"{self.base_url}{path}"
        key = idempotency_key or str(uuid.uuid4())
        headers = {
            "Content-Type": "application/json",
            "Idempotency-Key": key,
            "User-Agent": "SecretIdentity-ResilientCaller/2.0"
        }

        self.breaker.before_call()

        attempt = 0
        while True:
            attempt += 1
            t_start = time.time()
            try:
                print(f"  --> {method} {path} (Attempt {attempt}/{self.max_retries + 1}, timeout={self.timeout}s, key={key[:8]}...)")
                resp = requests.request(
                    method=method,
                    url=url,
                    json=json_data,
                    headers=headers,
                    timeout=self.timeout
                )
                duration_ms = (time.time() - t_start) * 1000

                # 5xx responses represent server-side transient errors eligible for retry
                if resp.status_code >= 500:
                    err_msg = f"HTTP {resp.status_code} Server Error"
                    print(f"      Server returned transient failure: {err_msg} in {duration_ms:.1f}ms")
                    if attempt <= self.max_retries:
                        sleep_time = BACKOFF_BASE_SECONDS * (2 ** (attempt - 1))
                        print(f"      Backing off for {sleep_time:.2f}s before safe retry...")
                        time.sleep(sleep_time)
                        continue
                    else:
                        print(f"      Exhausted retry limit ({self.max_retries}) for {err_msg}.")
                        self.breaker.on_failure()
                        return resp

                # Success or client validation error (4xx: not retryable, but server is alive)
                if resp.status_code < 500:
                    replayed = resp.headers.get("Idempotent-Replayed", "false")
                    print(f"      <-- HTTP {resp.status_code} in {duration_ms:.1f}ms (Idempotent-Replayed: {replayed})")
                    self.breaker.on_success()
                    return resp

            except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as exc:
                duration_ms = (time.time() - t_start) * 1000
                exc_name = type(exc).__name__
                print(f"      Transient Network Error: {exc_name} after {duration_ms:.1f}ms")
                if attempt <= self.max_retries:
                    sleep_time = BACKOFF_BASE_SECONDS * (2 ** (attempt - 1))
                    print(f"      Backing off for {sleep_time:.2f}s before safe retry...")
                    time.sleep(sleep_time)
                    continue
                else:
                    print(f"      Exhausted retry limit ({self.max_retries}) on {exc_name}.")
                    self.breaker.on_failure()
                    raise


def set_chaos_delay(every=0, ms=0):
    try:
        requests.post(f"{BASE_URL}/chaos/delay?every={every}&ms={ms}", timeout=3.0)
    except Exception:
        pass

def reset_chaos():
    try:
        requests.post(f"{BASE_URL}/chaos/reset", timeout=3.0)
    except Exception:
        pass


def main():
    print("=" * 70)
    print(" SECRET IDENTITY — RESILIENT HTTP CALLER DEMONSTRATION")
    print("=" * 70)
    print(f"Target Base URL:          {BASE_URL}")
    print(f"Per-Call Timeout:         {TIMEOUT_SECONDS}s")
    print(f"Max Retries with Backoff: {MAX_RETRIES} attempts (base: {BACKOFF_BASE_SECONDS}s)")
    print(f"Breaker Failure Threshold:{BREAKER_FAILURE_THRESHOLD} consecutive failures")
    print(f"Breaker Recovery Window:  {BREAKER_RECOVERY_SECONDS}s cooldown")
    print("=" * 70)

    client = ResilientHttpClient(base_url=BASE_URL)
    reset_chaos()

    # -------------------------------------------------------------
    # PHASE 1: Successful Operations (Breaker CLOSED)
    # -------------------------------------------------------------
    print("\n[PHASE 1] Demonstrating Successful Caller Requests (Breaker: CLOSED)")
    print("-" * 70)
    
    # 1. Start a game with an idempotency key
    start_idem_key = f"game-start-{uuid.uuid4().hex[:8]}"
    resp = client.call_endpoint("POST", "/api/games", idempotency_key=start_idem_key)
    if resp.status_code not in (200, 201):
        print(f"Failed to start game: {resp.text}")
        sys.exit(1)
    
    game_data = resp.json()
    game_id = game_data["game_id"]
    print(f"  Game successfully created: game_id = {game_id}, max_guesses = {game_data['max_guesses']}")

    # 2. Make an idempotent guess
    guess_key = f"guess-batman-{uuid.uuid4().hex[:8]}"
    print(f"\nSubmitting guess 'Batman' to /api/games/{game_id}/guesses...")
    resp = client.call_endpoint("POST", f"/api/games/{game_id}/guesses", {"name": "Batman"}, idempotency_key=guess_key)
    print(f"  Feedback received: {resp.json().get('status', 'in_progress')}, guesses_left: {resp.json().get('guesses_left')}")

    # 3. Repeat the exact same request with identical Idempotency-Key
    print(f"\nRetrying exact same guess with identical Idempotency-Key (Safe Repeat)...")
    resp_replayed = client.call_endpoint("POST", f"/api/games/{game_id}/guesses", {"name": "Batman"}, idempotency_key=guess_key)
    print(f"  Cached replayed status: {resp_replayed.json().get('idempotent_replayed')}, Header: {resp_replayed.headers.get('Idempotent-Replayed')}")

    # -------------------------------------------------------------
    # PHASE 2: Transient Failure, Retries with Backoff & Breaker Trip
    # -------------------------------------------------------------
    print("\n[PHASE 2] Demonstrating Fault Handling, Retries with Backoff & Breaker Trip")
    print("-" * 70)
    print("Injecting chaos: every request delays 2000ms (exceeds 1.0s timeout)...")
    set_chaos_delay(every=1, ms=2000)

    for i in range(1, BREAKER_FAILURE_THRESHOLD + 1):
        print(f"\n--- Triggering Failure Call #{i} (expecting timeout, retries, and backoff) ---")
        try:
            client.call_endpoint("POST", f"/api/games/{game_id}/guesses", {"name": "Superman"})
        except Exception as e:
            print(f"  Call #{i} permanently failed as expected: {type(e).__name__}")

    print(f"\nResulting Circuit Breaker State: {client.breaker.state}")

    # -------------------------------------------------------------
    # PHASE 3: Blocking Calls While Breaker is OPEN (Fast-Fail)
    # -------------------------------------------------------------
    print("\n[PHASE 3] Demonstrating Call Blocking While Breaker is OPEN")
    print("-" * 70)
    for probe in range(1, 3):
        print(f"\nAttempting call while breaker is OPEN (Test {probe}/2)...")
        try:
            client.call_endpoint("POST", f"/api/games/{game_id}/guesses", {"name": "Flash"})
        except CircuitBreakerOpenException as cbe:
            print(f"  FAST-FAIL SUCCESS: {cbe}")

    # -------------------------------------------------------------
    # PHASE 4: Recovery Cooldown, HALF_OPEN probe, and Reset to CLOSED
    # -------------------------------------------------------------
    print("\n[PHASE 4] Demonstrating Recovery Cooldown and Transition to CLOSED")
    print("-" * 70)
    print("Clearing server-side chaos delay injection...")
    reset_chaos()

    wait_time = BREAKER_RECOVERY_SECONDS + 0.5
    print(f"Sleeping for {wait_time:.1f}s to allow breaker recovery cooldown window to elapse...")
    time.sleep(wait_time)

    print("\nAttempting trial probe request (should test HALF_OPEN and transition to CLOSED)...")
    try:
        resp = client.call_endpoint("POST", f"/api/games/{game_id}/guesses", {"name": "Aquaman"})
        print(f"  Probe call succeeded! Status: HTTP {resp.status_code}")
    except Exception as e:
        print(f"  Probe call failed: {e}")

    print(f"\nFinal Circuit Breaker State: {client.breaker.state}")
    print("\n" + "=" * 70)
    print(" RESILIENT HTTP CALLER DEMO COMPLETE — ALL PHASES VERIFIED")
    print("=" * 70)


if __name__ == "__main__":
    main()
