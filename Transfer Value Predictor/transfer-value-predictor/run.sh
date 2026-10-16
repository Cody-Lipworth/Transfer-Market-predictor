#!/usr/bin/env bash
# Starts the Transfer Value Predictor backend (FastAPI/uvicorn) and frontend
# (static file server) together, waits until both are actually ready, then
# prints one clear link to open. Ctrl+C stops both cleanly.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR"
FRONTEND_DIR="$SCRIPT_DIR/frontend"
BACKEND_PY="$BACKEND_DIR/.venv/bin/python3"

BACKEND_PORT=8000
FRONTEND_PORT=8081
BACKEND_HEALTH_URL="http://localhost:$BACKEND_PORT/health"
FRONTEND_URL="http://localhost:$FRONTEND_PORT/transfer-value-predictor.dc.html"
READY_TIMEOUT=90

LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/tvp-run.XXXXXX")"
BACKEND_LOG="$LOG_DIR/backend.log"
FRONTEND_LOG="$LOG_DIR/frontend.log"

BOLD="$(tput bold 2>/dev/null || true)"
GREEN="$(tput setaf 2 2>/dev/null || true)"
RED="$(tput setaf 1 2>/dev/null || true)"
RESET="$(tput sgr0 2>/dev/null || true)"

BACKEND_PID=""
FRONTEND_PID=""
TAIL_BACKEND_PID=""
TAIL_FRONTEND_PID=""

cleanup() {
    echo ""
    echo "Shutting down..."
    for pid in "$TAIL_BACKEND_PID" "$TAIL_FRONTEND_PID" "$BACKEND_PID" "$FRONTEND_PID"; do
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null
        fi
    done
    for pid in "$BACKEND_PID" "$FRONTEND_PID"; do
        [ -n "$pid" ] && wait "$pid" 2>/dev/null
    done
    rm -rf "$LOG_DIR"
    exit "${1:-0}"
}
trap 'cleanup 0' INT TERM

fail() {
    echo ""
    echo "${RED}${BOLD}ERROR:${RESET} $1"
    cleanup 1
}

port_in_use() {
    lsof -i ":$1" -sTCP:LISTEN >/dev/null 2>&1
}

# --- Preflight ---------------------------------------------------------

if [ ! -x "$BACKEND_PY" ]; then
    fail "Backend venv not found at $BACKEND_DIR/.venv
  Set it up first:
    cd \"$BACKEND_DIR\" && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt"
fi

if ! command -v python3 >/dev/null 2>&1; then
    fail "python3 not found on PATH (needed for the frontend's static file server)."
fi

if [ ! -f "$FRONTEND_DIR/transfer-value-predictor.dc.html" ]; then
    fail "Frontend file not found at $FRONTEND_DIR/transfer-value-predictor.dc.html"
fi

if port_in_use "$BACKEND_PORT"; then
    fail "Port $BACKEND_PORT is already in use (backend).
  Stop whatever's using it:  lsof -ti:$BACKEND_PORT | xargs kill
  Or it may already be running - check http://localhost:$BACKEND_PORT/health"
fi

if port_in_use "$FRONTEND_PORT"; then
    fail "Port $FRONTEND_PORT is already in use (frontend).
  Stop whatever's using it:  lsof -ti:$FRONTEND_PORT | xargs kill"
fi

# --- Launch (in parallel) ----------------------------------------------

echo "Starting backend  (uvicorn, port $BACKEND_PORT)..."
(
    cd "$BACKEND_DIR" && exec "$BACKEND_PY" -u -m uvicorn api.app:app --port "$BACKEND_PORT"
) >"$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!

echo "Starting frontend (static server, port $FRONTEND_PORT)..."
(
    cd "$FRONTEND_DIR" && exec python3 -u -m http.server "$FRONTEND_PORT"
) >"$FRONTEND_LOG" 2>&1 &
FRONTEND_PID=$!

# --- Wait for both to be ready -------------------------------------------

wait_ready() {
    local pid="$1" url="$2" name="$3" logfile="$4"
    local start
    start=$(date +%s)
    while true; do
        if ! kill -0 "$pid" 2>/dev/null; then
            echo ""
            echo "${RED}${BOLD}ERROR:${RESET} $name exited before it became ready. Last log lines:"
            tail -n 20 "$logfile"
            return 1
        fi
        if curl -sf -o /dev/null "$url" 2>/dev/null; then
            return 0
        fi
        if [ $(( $(date +%s) - start )) -ge "$READY_TIMEOUT" ]; then
            echo ""
            echo "${RED}${BOLD}ERROR:${RESET} $name did not become ready within ${READY_TIMEOUT}s. Last log lines:"
            tail -n 20 "$logfile"
            if [ ! -s "$logfile" ]; then
                echo "  (log is empty - the process is alive but has printed nothing yet, most likely"
                echo "   still importing pandas/scikit-learn for the first time. If this keeps"
                echo "   happening, raise READY_TIMEOUT near the top of run.sh.)"
            fi
            return 1
        fi
        sleep 0.3
    done
}

wait_ready "$BACKEND_PID" "$BACKEND_HEALTH_URL" "backend" "$BACKEND_LOG" || cleanup 1
wait_ready "$FRONTEND_PID" "$FRONTEND_URL" "frontend" "$FRONTEND_LOG" || cleanup 1

# --- Ready banner --------------------------------------------------------

echo ""
echo "${GREEN}---------------------------------------------${RESET}"
echo "${GREEN}${BOLD} App is running!${RESET}"
echo "${GREEN} Open this in your browser:${RESET}"
echo "${GREEN}${BOLD} $FRONTEND_URL${RESET}"
echo "${GREEN}"
echo " (backend running at http://localhost:$BACKEND_PORT)"
echo "${RESET}${GREEN}---------------------------------------------${RESET}"
echo ""
echo "Streaming logs below. Press Ctrl+C to stop both servers."
echo ""

# --- Stream logs, prefixed, until Ctrl+C ---------------------------------

tail -f -n +1 "$BACKEND_LOG" | awk '{ print "[backend] " $0; fflush() }' &
TAIL_BACKEND_PID=$!
tail -f -n +1 "$FRONTEND_LOG" | awk '{ print "[frontend] " $0; fflush() }' &
TAIL_FRONTEND_PID=$!

wait
