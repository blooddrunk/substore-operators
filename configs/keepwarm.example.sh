#!/bin/sh
# Keep the Sub-Store download cache warm on the VPS.
#
# daed updates subscriptions every 6 hours with a hard-coded 5s timeout, and
# openresty serves /download/ from proxy_cache (see openresty-substore-cache.conf).
# This cron refreshes every entry before it expires, so daed (and the Sub-Store
# probe caches behind it) never meet a cold production.
#
# Setup (keepwarm.sh is gitignored — keep your real copy out of the repo):
#   1. cp keepwarm.example.sh keepwarm.sh
#   2. Fill in BASE (your Sub-Store frontend path token) and the download
#      paths of your subscriptions/collections.
#   3. Install on the VPS:
#        cp keepwarm.sh /usr/local/bin/substore-keepwarm.sh && chmod +x /usr/local/bin/substore-keepwarm.sh
#        crontab -e
#        */5 * * * * /usr/local/bin/substore-keepwarm.sh >/dev/null 2>&1

BASE="https://substore.example.com/PATH_TOKEN/download"

for u in \
  'collection/MyCollection?$options=filterType%3Dreality%26profile%3Dmain' \
  'collection/MyCollection?$options=filterType%3Dhy2' \
  'my-sub-1' \
  'my-sub-2'
do
  curl -fsS -o /dev/null --max-time 120 "$BASE/$u" 2>/dev/null &
done

wait
