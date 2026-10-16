#!/usr/bin/env bash
# Stops the Transfer Value Predictor backend and frontend, however they were
# started (via run.sh, or manually) - by port, so it works either way.
set -u

BACKEND_PORT=8000
FRONTEND_PORT=8081

RED="$(tput setaf 1 2>/dev/null || true)"
GREEN="$(tput setaf 2 2>/dev/null || true)"
RESET="$(tput sgr0 2>/dev/null || true)"

stopped_anything=0

stop_port() {
    local port="$1" label="$2"
    local pids
    pids="$(lsof -ti ":$port" -sTCP:LISTEN 2>/dev/null || true)"

    if [ -z "$pids" ]; then
        echo "$label (port $port): not running"
        return
    fi

    echo "Stopping $label (port $port, pid(s): $pids)..."
    kill -TERM $pids 2>/dev/null
    for i in $(seq 1 10); do
        pids="$(lsof -ti ":$port" -sTCP:LISTEN 2>/dev/null || true)"
        [ -z "$pids" ] && break
        sleep 0.3
    done

    pids="$(lsof -ti ":$port" -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "$pids" ]; then
        echo "  still up after SIGTERM, forcing (pid(s): $pids)..."
        kill -9 $pids 2>/dev/null
        sleep 0.3
    fi

    pids="$(lsof -ti ":$port" -sTCP:LISTEN 2>/dev/null || true)"
    if [ -z "$pids" ]; then
        echo "${GREEN}$label stopped.${RESET}"
        stopped_anything=1
    else
        echo "${RED}ERROR: could not stop $label - still listening on port $port.${RESET}"
    fi
}

# If run.sh's own process is alive, stop it directly too so its trap-based
# cleanup runs (it also owns the log-tailing processes, not just the servers).
run_sh_pid="$(pgrep -f '[r]un\.sh' 2>/dev/null || true)"
if [ -n "$run_sh_pid" ]; then
    echo "Stopping run.sh (pid $run_sh_pid)..."
    kill -TERM $run_sh_pid 2>/dev/null
    sleep 1
fi

stop_port "$BACKEND_PORT" "backend"
stop_port "$FRONTEND_PORT" "frontend"

if [ "$stopped_anything" -eq 0 ] && [ -z "$run_sh_pid" ]; then
    echo "Nothing was running."
fi
