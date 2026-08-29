# substore-operators

**English** | [简体中文](./README.zh-CN.md)

Personal [Sub-Store](https://github.com/sub-store-org/Sub-Store) remote operators for proxy subscription processing.

This repository keeps reusable Sub-Store scripts in Git so they can be versioned, reviewed, reused, and loaded directly as remote scripts.

## Design goal

The repository separates policy from runtime probing:

- protocol, route quality, traffic/cost tier, region, and provider are static or semi-static policy;
- Google region status is a dynamic probe;
- sing-box / daed / Xray urltest or load balancing should only compare nodes that already belong to the same policy pool.

This prevents a low-RTT but poor China-route node from defeating a better optimized route purely because its latency is lower.

## Operators

### `protocol-filter.js`

Filters a 3x-ui subscription to the proxy types used by this setup and, before DNS Resolve replaces `server` with an IP address:

1. preserves the original Hysteria2 TLS hostname when no explicit SNI exists;
2. stores the original hostname in temporary `_originServer` metadata so later policy filters can still identify the node reliably.

Remote script URL:

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/protocol-filter.js
```

Supported `filterType` values:

| Value | Result |
| --- | --- |
| `all` | VLESS + Hysteria2 (default) |
| `vless` | VLESS only |
| `reality` | Alias of `vless` |
| `hysteria2` | Hysteria2 only |
| `hy2` | Alias of `hysteria2` |

### `node-profile-filter.js`

Filters nodes into policy pools before urltest / load balancing.

Remote script URL:

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/node-profile-filter.js
```

Supported filters:

| Parameter | Example | Meaning |
| --- | --- | --- |
| `profile` | `main,premium` | Policy pool |
| `route` | `optimized` | China-route class |
| `traffic` | `high` | Traffic/cost tier |
| `region` | `JP,US` | Server region |
| `provider` | `nosla,bitsflow` | Host/route provider |
| `asn` | `12345,AS67890` | Server ASN |
| `host` | `nosla.haoqi90.top` | Original hostname |

Values inside one field use OR; different fields use AND. Example:

```text
route=optimized&region=JP,SG
```

means “optimized China route AND located in Japan or Singapore”.

Default profile derivation:

```text
main     = optimized + high traffic
premium  = optimized + low traffic
backup   = standard
optimized = route=optimized
standard  = route=standard
```

Only explicitly established route facts are built in:

```text
nosla.haoqi90.top    -> provider=nosla, route=optimized
bitsflow.haoqi90.top -> provider=bitsflow, route=standard
```

Unknown route/traffic properties remain unknown; ASN, country, and latency are never used to guess “China optimized”.

#### Custom rules

Pass a JSON array through `rules`. Later rules override earlier rules, and user rules run after built-ins.

Supported match fields:

```text
host
hostRegex
name
nameRegex
subName
subNameRegex
```

Supported profile fields:

```text
provider
route
traffic
region
asn
profile
```

Example:

```json
[
  {
    "host": "nosla.haoqi90.top",
    "traffic": "low"
  },
  {
    "host": "lightlayer.haoqi90.top",
    "provider": "lightlayer",
    "route": "optimized",
    "traffic": "high"
  }
]
```

URL-encode the JSON when passing it in a remote-script fragment.

#### MMDB server geography / ASN

Node.js Sub-Store can use local MMDB files:

```yaml
services:
  sub-store:
    environment:
      SUB_STORE_MMDB_CRON: 0 15 * * *
      SUB_STORE_MMDB_COUNTRY_URL: https://github.com/xream/geoip/releases/latest/download/ipinfo.country.mmdb
      SUB_STORE_MMDB_COUNTRY_PATH: /opt/app/data/GeoLite2-Country.mmdb
      SUB_STORE_MMDB_ASN_URL: https://github.com/xream/geoip/releases/latest/download/ipinfo.asn.mmdb
      SUB_STORE_MMDB_ASN_PATH: /opt/app/data/GeoLite2-ASN.mmdb
    volumes:
      - ./data:/opt/app/data
```

> A fresh install with no MMDB file does not automatically download one immediately; prepare the file first or wait for the configured cron run.

After DNS Resolve, `node-profile-filter.js` queries the final `proxy.server` IP directly with local MMDB:

```text
server IP -> Country / ASN / AS Organization
```

No HTTP META instance is required for this server-side classification. Paths can also be overridden with:

```text
mmdb_country_path=/path/to/country.mmdb
mmdb_asn_path=/path/to/asn.mmdb
```

Country/ASN are objective metadata only. They are not treated as proof of an optimized China route.

For diagnostics, enable:

```text
metadata=true
```

which temporarily attaches `_nodeProfile`. The final Google filter also removes `_nodeProfile` and `_originServer` defensively.

### `http-meta-geo.js`

Forked from xream's `http_meta_geo.js`. It preserves upstream behavior and removes Hysteria2 `ports` only from the temporary probe copy so HTTP META uses the primary `port`; the original node and final subscription keep port hopping intact.

It is appropriate when you need the real proxy egress Country/ASN. By contrast, `node-profile-filter.js` MMDB classification describes the DNS-resolved server IP itself.

### `google-region-probe.js`

The recommended Google-region probe. It creates a local HTTP META / Mihomo proxy per node and uses container `curl` to request YouTube Premium.

Results are classified as:

```text
clean | cn | unknown
```

and stored in `_googleStatus` for the next operator.

### `google-region-check.js`

Filters `_googleStatus` and keeps compatibility with the historical `_geo` + `www.google.cn` marker.

Supported values:

| Value | Result |
| --- | --- |
| `all` | Keep all nodes |
| `clean` | Keep only confirmed clean nodes |
| `ok` | Alias of `clean` |
| `non-cn` | Keep `clean + unknown` |
| `cn` | Keep only confirmed CN nodes |
| `china` | Alias of `cn` |
| `unknown` | Keep only indeterminate nodes |

It removes `_geo`, `_googleStatus`, `_originServer`, and `_nodeProfile` before final output.

## Recommended pipeline

```text
3x-ui original subscription
        │
        ▼
┌──────────────────────────────┐
│ 1 protocol-filter.js         │
│                              │
│ protocol filtering           │
│ preserve HY2 SNI             │
│ preserve _originServer       │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ 2 DNS Resolve Action         │
│                              │
│ hostname -> IPv4             │
│ TLS validation enabled       │
│ cache 300-600 s              │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ 3 node-profile-filter.js     │
│                              │
│ static: route / traffic      │
│         provider / profile   │
│ MMDB: region / ASN           │
│                              │
│ shrink the candidate pool    │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ 4 google-region-probe.js     │
│                              │
│ probe surviving nodes only   │
│ clean / cn / unknown         │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ 5 google-region-check.js     │
│                              │
│ Google status filter         │
│ clean temporary metadata     │
└──────────────┬───────────────┘
               │
               ▼
      sing-box / daed / Xray
               │
               ▼
       urltest / load balance
       within the same tier
```

Putting node-profile filtering before HTTP META also avoids probing nodes that cannot enter the requested policy pool anyway.

## Copy-ready examples

Optimized routes only:

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/node-profile-filter.js#profile=optimized
```

Standard/backup routes:

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/node-profile-filter.js#profile=backup
```

Optimized Japan nodes:

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/node-profile-filter.js#route=optimized&region=JP
```

Specific provider:

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/node-profile-filter.js#provider=nosla
```

Use `profile=main` / `profile=premium` after the relevant hosts have an explicit `traffic` tier.

The core rule is:

```text
Profile chooses the candidate pool.
URLTest chooses the current winner inside that pool.
```

## Repository layout

```text
.
├── README.md
├── README.zh-CN.md
└── operators/
    ├── protocol-filter.js
    ├── node-profile-filter.js
    ├── http-meta-geo.js
    ├── google-region-probe.js
    └── google-region-check.js
```

## Maintenance principles

- Do not infer China-route quality from RTT.
- Do not infer “optimized” from Country/ASN.
- Leave unknown route attributes unknown.
- User rules override built-ins.
- Dynamic network probes keep an explicit `unknown` state.
- Remove temporary metadata before final subscription output.
