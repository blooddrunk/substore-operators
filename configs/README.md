# Node profile configuration

This directory contains deployment-specific node metadata consumed by `operators/node-profile-filter.js` through `rulesUrl`.

## Current node profiles

| Provider | Host | Route | Traffic | Profile | Region | City |
| --- | --- | --- | --- | --- | --- | --- |
| bwh | `bwh.haoqi90.top` | optimized | low | premium | US | LA |
| nosla | `nosla.haoqi90.top` | optimized | high | main | DE | FRA |
| lightlayer | `lightlayer.haoqi90.top` | optimized | medium | main | US | SJC |
| bitsflow | `bitsflow.haoqi90.top` | standard | medium | backup | JP | TYO |

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
