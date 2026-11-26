#!/usr/bin/env bash
# Mac / Linux: double-click or run ./start.sh
cd "$(dirname "$0")/clubportal" || exit 1
PY=python3; command -v python3 >/dev/null 2>&1 || PY=python
[ -f portal.db ] || "$PY" seed.py
( sleep 1.5; (command -v open >/dev/null && open http://localhost:8770) || (command -v xdg-open >/dev/null && xdg-open http://localhost:8770) ) >/dev/null 2>&1 &
exec "$PY" app.py
