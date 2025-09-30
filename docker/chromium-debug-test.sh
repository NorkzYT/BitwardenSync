# give Chrome a clean profile (required since Chrome 136+)
USER_DATA_DIR=/tmp/chrome-pptr-debug

xvfb-run -a -s "-screen 0 1920x1080x24" \
  /snap/bin/chromium \
  --no-sandbox \
  --disable-dev-shm-usage \
  --user-data-dir="$USER_DATA_DIR" \
  --remote-debugging-address=127.0.0.1 \
  --remote-allow-origins=* \
  --auto-open-devtools-for-tabs \
  --remote-debugging-port=9222
