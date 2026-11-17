#!/bin/zsh
set -e
cd -- "${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if [[ -d "/Applications/Study Studio.app" ]]; then
  exec /usr/bin/open "/Applications/Study Studio.app"
fi
if /usr/bin/curl --fail --silent --max-time 2 http://127.0.0.1:4317/ >/dev/null; then
  /usr/bin/open http://127.0.0.1:4317/
  exit 0
fi
if [[ ! -d dist ]]; then
  npm run build
fi
( sleep 2; /usr/bin/open http://127.0.0.1:4317/ ) &
exec node server/index.mjs
