# substore-operators

**English** | [简体中文](./README.zh-CN.md)

Personal [Sub-Store](https://github.com/sub-store-org/Sub-Store) remote operators for proxy subscription processing.

This repository keeps reusable Sub-Store scripts in Git so they can be versioned, reviewed, reused, and loaded directly as remote scripts.

## Operators

### `protocol-filter.js`

Filters a 3x-ui subscription down to the proxy types used by this setup and protects the original Hysteria2 TLS hostname before a later DNS-resolve action replaces `server` with an IP address.

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

### `http-meta-geo.js`

Forked from xream's `http_meta_geo.js`. It uses HTTP META / Mihomo to access the probe URL through every node.

This fork has one behavior change: **for Hysteria2 probes, `ports` is removed only from the temporary probe copy, forcing HTTP META to use the primary `port`. The original node and final subscription keep the configured port-hopping range unchanged.**

Remote script URL:

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/http-meta-geo.js
```

Google-region probing uses:

```text
api=https://www.youtube.com/premium
geo=true
format={{proxy.name}}
```

The fork has been validated with both Reality and Hysteria2 nodes, including Hysteria2 nodes that retain `ports` in the actual subscription.

### `google-region-check.js`

Reads the `_geo` response produced by `http-meta-geo.js`, classifies the node into one of three states, and optionally filters the subscription.

Remote script URL:

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/google-region-check.js
```

Supported `googleStatus` values:

| Value | Result |
| --- | --- |
| `all` | Keep all nodes (default) |
| `clean` | Keep successful probes that do not contain `www.google.cn` |
| `ok` | Alias of `clean` |
| `cn` | Keep probes containing `www.google.cn` |
| `china` | Alias of `cn` |
| `unknown` | Keep nodes without a reliable probe result |

Classification:

```text
_geo missing / null / undefined / empty
    -> unknown

_geo contains www.google.cn
    -> cn

other non-empty _geo
    -> clean
```

After classification, `_geo` is removed so the complete YouTube Premium HTML response cannot bloat the final subscription.

> `www.google.cn` is a heuristic rather than an official Google API. It has been positively validated against a known affected node, but transport failures are deliberately kept as `unknown` rather than being treated as clean.

## Recommended Sub-Store pipeline

```text
3x-ui original subscription
        │
        ▼
┌──────────────────────────────┐
│ ① protocol-filter.js         │
│                              │
│ Filter VLESS / Hysteria2     │
│ Preserve Hysteria2 SNI       │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ ② http-meta-geo.js           │
│                              │
│ Probe through each node:     │
│ youtube.com/premium          │
│                              │
│ HY2 probe copy drops ports   │
│ geo=true -> attach _geo      │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ ③ google-region-check.js     │
│                              │
│ clean / cn / unknown         │
│ Recommended: clean           │
│ Remove probe-only _geo       │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ ④ DNS Resolve Action         │
│                              │
│ Resolver: Cloudflare         │
│ IP family: IPv4              │
│ Output: IP only              │
│ TLS verification: enabled    │
│ Cache: 300–600 s             │
└──────────────┬───────────────┘
               │
               ▼
        subscription output
```

The order matters: run the Google probe before DNS resolution so the original node configuration is tested; transform hostnames to IPs only after classification.

## Copy-ready configuration

### 1. Protocol filter

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/protocol-filter.js#filterType=all
```

### 2. Google probe

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/http-meta-geo.js#http_meta_protocol=http&http_meta_host=127.0.0.1&http_meta_port=9876&http_meta_start_delay=3000&http_meta_proxy_timeout=10000&api=https%3A%2F%2Fwww.youtube.com%2Fpremium&geo=true&format=%7B%7Bproxy.name%7D%7D&concurrency=1&timeout=10000&retries=0
```

Keep both of these parameters:

```text
geo=true
format={{proxy.name}}
```

`geo=true` exposes the response to the classifier as `_geo`; `format={{proxy.name}}` prevents the upstream script from renaming nodes.

### 3. Keep only clean Google nodes

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/google-region-check.js#googleStatus=clean
```

For diagnostics:

```text
googleStatus=cn
googleStatus=unknown
```

### 4. DNS resolution

Continue with the existing Cloudflare / IPv4 / IP-only / TLS-validation-enabled configuration and a 300–600 second DNS cache.

## Hysteria2 SNI and port hopping

These are handled at different stages:

- `protocol-filter.js` preserves SNI before DNS resolution replaces the hostname.
- `http-meta-geo.js` removes `ports` only from the HTTP META probe copy to work around probe-time port-hopping compatibility.

The final Hysteria2 node still keeps its real `port`, `ports`, and `sni` fields.

## Repository layout

```text
.
├── README.md
├── README.zh-CN.md
└── operators/
    ├── protocol-filter.js
    ├── http-meta-geo.js
    └── google-region-check.js
```

## Development conventions

- Keep remote scripts self-contained; do not require npm dependencies at runtime.
- Prefer explicit defaults and documented aliases.
- Preserve existing proxy fields unless a transformation is required.
- Treat network-based detection as fallible and retain an `unknown` state.
- Remove probe-only metadata before final subscription output.
- Keep stable filenames once they are referenced by Sub-Store remote-script URLs.

## Upstream

Sub-Store's Script Operator expects an `operator(proxies)` function and exposes `$arguments` / `$options` to the script runtime. This repository follows that model.
