# Node profile configuration

This directory contains deployment-specific node metadata consumed by `operators/node-profile-filter.js` through `rulesUrl`.

## Keeping daed subscription updates under its 5s timeout

daed (dae-wing) updates subscriptions with a **hard-coded 5s timeout per attempt** — first direct, then via routing — with no configuration option (`graphql/service/subscription/mutation_utils.go` in dae-wing: `timeout := 10 * time.Second` split into two 5s attempts). A Sub-Store download that exceeds 5s fails with:

```text
Get "https://substore.../download/collection/MySub?...": context deadline exceeded
(Client.Timeout exceeded while awaiting headers) (direct); ... (route)
```

Observed production time for `collection/MySub` ranges from ~0.5s (probe caches warm) to 6s+ (probe cache expired, `http_meta_start_delay=3000`, dead-node probe timeouts), so cold cron updates regularly blow the budget. Three layers keep the response fast:

1. **Operator probes** (this repo): `probe_budget` (default 8s) bounds each probe group, `share_by_server=true` collapses same-server nodes into one probe, and `unknown` verdicts are now cached for `unknown_cache_ttl` (default 10 min) like `clean`/`cn` for `cache_ttl` (default 15 min), so dead nodes stop paying a full probe timeout on every production. Failed probe attempts also fall back to the most recent cached verdict of any kind.
2. **Reverse-proxy cache** (VPS): drop `openresty-substore-cache.conf` into the openresty config for `substore.example.com`. Once warmed, every download is answered from cache instantly (stale-while-revalidate), and upstream slowness or transient 500s never reaches daed.
3. **Keep-warm cron** (VPS): refresh the cache every 10 minutes so the 6-hourly daed cron (`10 */6 * * *`) never meets a cold entry:

```text
*/10 * * * * for u in 'collection/MySub?$options=filterType%3Dreality%26profile%3Dmain' 'collection/MySub?$options=filterType%3Dreality' 'collection/MySub?$options=filterType%3Dhy2' 'bwh' 'nosla' 'bitsflow' 'lightlayer'; do curl -fsS -o /dev/null --max-time 120 "https://substore.example.com/PATH_TOKEN/download/$u"; done
```

Recommended `google-region-probe.js` script arguments in Sub-Store (the current `http_meta_start_delay=3000` alone eats 60% of the daed budget on every cold production; `share_by_server=true` is worth keeping — several inbounds share one VPS egress):

```text
api=https%3A%2F%2Fwww.youtube.com%2Fpremium&concurrency=5&http_meta_start_delay=1500&share_by_server=true&timeout=10000
```

## Current node profiles

| Provider | Host | Route | Traffic | Profile | Region | City |
| --- | --- | --- | --- | --- | --- | --- |
| bwh | `bwh.example.com` | optimized | low | premium | US | LA |
| nosla | `nosla.example.com` | optimized | high | main | DE | FRA |
| lightlayer | `lightlayer.example.com` | optimized | medium | main | US | SJC |
| bitsflow | `bitsflow.example.com` | standard | medium | backup | JP | TYO |

Configuration file:

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/configs/node-profile-rules.json
```

## How it works

`node-profile-rules.json` defines node metadata. The operator then filters that metadata.

```text
rulesUrl -> classify nodes -> filter -> urltest/load balancing
```

`profile`, `route`, `traffic`, `region`, `city`, `provider`, `asn`, and `host` are independent filter dimensions.

Examples:

```text
profile=main
profile=premium
profile=backup
route=optimized
region=US
city=SJC
route=optimized&region=US
```

Values separated by commas inside one filter are OR; different filters are AND.

## Copy-ready Sub-Store script URLs

Rules URL, encoded:

```text
https%3A%2F%2Fraw.githubusercontent.com%2Fblooddrunk%2Fsubstore-operators%2Fmain%2Fconfigs%2Fnode-profile-rules.json
```

### Main

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/node-profile-filter.js#rulesUrl=https%3A%2F%2Fraw.githubusercontent.com%2Fblooddrunk%2Fsubstore-operators%2Fmain%2Fconfigs%2Fnode-profile-rules.json&profile=main
```

### Premium

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/node-profile-filter.js#rulesUrl=https%3A%2F%2Fraw.githubusercontent.com%2Fblooddrunk%2Fsubstore-operators%2Fmain%2Fconfigs%2Fnode-profile-rules.json&profile=premium
```

### Backup

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/node-profile-filter.js#rulesUrl=https%3A%2F%2Fraw.githubusercontent.com%2Fblooddrunk%2Fsubstore-operators%2Fmain%2Fconfigs%2Fnode-profile-rules.json&profile=backup
```

### All optimized routes

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/node-profile-filter.js#rulesUrl=https%3A%2F%2Fraw.githubusercontent.com%2Fblooddrunk%2Fsubstore-operators%2Fmain%2Fconfigs%2Fnode-profile-rules.json&route=optimized
```

### US optimized routes

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/node-profile-filter.js#rulesUrl=https%3A%2F%2Fraw.githubusercontent.com%2Fblooddrunk%2Fsubstore-operators%2Fmain%2Fconfigs%2Fnode-profile-rules.json&route=optimized&region=US
```
