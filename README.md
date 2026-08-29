# substore-operators

**English** | [简体中文](./README.zh-CN.md)

Personal [Sub-Store](https://github.com/sub-store-org/Sub-Store) remote operators for proxy subscription processing.

This repository keeps reusable Sub-Store scripts in Git so they can be versioned, reviewed, reused, and loaded directly as remote scripts.

## Operators

### `protocol-filter.js`

Filters a 3x-ui subscription down to the proxy types used by this setup and preserves the original Hysteria2 TLS hostname before a later DNS-resolve action replaces `server` with an IP address.

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

Forked from xream's `http_meta_geo.js`. It keeps the upstream general-purpose behavior and adds one compatibility change for this setup: **for Hysteria2 probes, `ports` is removed only from the temporary probe copy, forcing HTTP META to use the primary `port`. The original node and final subscription retain port hopping.**

Remote script URL:

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/http-meta-geo.js
```

### `google-region-probe.js`

The recommended Google-region probe for this repository.

It creates one local HTTP META / Mihomo proxy per node and then uses the container's `curl` binary to request:

```text
https://www.youtube.com/premium
```

Behavior:

- Reality and Hysteria2 traffic is sent through the actual node via HTTP META.
- Hysteria2 `ports` is removed only from the temporary probe copy.
- curl does not automatically follow redirects, avoiding YouTube consent redirect loops on European exits.
- A 2xx body containing `www.google.cn` is classified `cn`.
- An explicit non-CN consent region is classified `clean`.
- Network failures or responses that cannot be classified reliably are `unknown`.
- The result is attached as `_googleStatus=clean|cn|unknown` for the next operator.

Remote script URL:

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/google-region-probe.js
```

### `google-region-check.js`

Filters nodes using `_googleStatus` from `google-region-probe.js`. If `_googleStatus` is absent, it keeps compatibility with the historical `_geo` + `www.google.cn` classifier.

Remote script URL:

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/google-region-check.js
```

Supported `googleStatus` values:

| Value | Result |
| --- | --- |
| `all` | Keep all nodes (default) |
| `clean` | Keep only nodes explicitly classified clean |
| `ok` | Alias of `clean` |
| `non-cn` | Keep every node except those explicitly classified `cn` (`clean + unknown`) |
| `cn` | Keep only nodes explicitly classified `cn` |
| `china` | Alias of `cn` |
| `unknown` | Keep only nodes without a reliable probe result |

Two useful production policies:

```text
googleStatus=clean
```

Strict mode: only confirmed-clean nodes survive; transient probe failures are removed too.

```text
googleStatus=non-cn
```

Conservative exclusion mode: only confirmed `cn` nodes are removed, while `unknown` nodes survive transient probe failures.

After filtering, `_geo` and `_googleStatus` are removed so probe-only metadata does not leak into the final subscription.

> `www.google.cn` is a heuristic rather than an official Google API. Network failures must remain distinct from `cn`, so the `unknown` state is intentionally preserved.

## Recommended Sub-Store pipeline

```text
3x-ui original subscription
        │
        ▼
┌──────────────────────────────┐
│ ① protocol-filter.js         │
│                              │
│ Filter VLESS / Hysteria2     │
│ Preserve SNI before IP swap  │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ ② DNS Resolve Action         │
│                              │
│ Resolver: Cloudflare         │
│ IP family: IPv4              │
│ Output: IP only              │
│ TLS verification: enabled    │
│ Cache: 300–600 s             │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ ③ google-region-probe.js     │
│                              │
│ Probe the final server IP    │
│ clean / cn / unknown         │
│ HY2 probe copy drops ports   │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ ④ google-region-check.js     │
│                              │
│ Strict: clean                │
│ Conservative: non-cn        │
│ Remove probe metadata        │
└──────────────┬───────────────┘
               │
               ▼
        subscription output
```

### Why DNS resolution comes before the Google probe

For this repository's use case, this order better matches the final subscription. The final node already replaces `server` with a resolved IP, so the Google probe should validate the same connection configuration that will actually be emitted and used.

If the Google probe runs against the hostname first and DNS Resolve runs afterward, a hostname with multiple A records, changing DNS state, or cache differences could theoretically be probed through one ingress IP while the final subscription is pinned to another.

Recommended order:

```text
protocol filter / preserve SNI
    -> DNS Resolve
    -> Google probe
    -> Google filter
```

The important prerequisite is that **the TLS hostname must be preserved before DNS Resolve replaces `server` with an IP**. `protocol-filter.js` handles this for Hysteria2 nodes that do not already provide an explicit SNI. Existing Reality/VLESS TLS and Reality SNI fields are preserved as-is.

## Copy-ready configuration

### 1. Protocol filter

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/protocol-filter.js#filterType=all
```

### 2. DNS resolution

Continue with Cloudflare / IPv4 / IP-only / TLS-validation-enabled and a 300–600 second cache.

### 3. Google probe

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/google-region-probe.js#http_meta_protocol=http&http_meta_host=127.0.0.1&http_meta_port=9876&http_meta_start_delay=3000&http_meta_proxy_timeout=10000&api=https%3A%2F%2Fwww.youtube.com%2Fpremium&concurrency=1&timeout=10000
```

### 4. Google filter

Keep only explicitly clean nodes:

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/google-region-check.js#googleStatus=clean
```

Remove only explicitly `cn` nodes and keep `clean + unknown`:

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/google-region-check.js#googleStatus=non-cn
```

Diagnostics:

```text
googleStatus=cn
googleStatus=unknown
googleStatus=all
```

## Hysteria2 SNI and port hopping

These are handled at different stages:

- `protocol-filter.js` preserves SNI before DNS resolution replaces the hostname.
- `google-region-probe.js` / `http-meta-geo.js` removes `ports` only from the HTTP META probe copy to work around probe-time port-hopping compatibility.

The final Hysteria2 node still keeps its real `port`, `ports`, and `sni` fields.

## Repository layout

```text
.
├── README.md
├── README.zh-CN.md
└── operators/
    ├── protocol-filter.js
    ├── http-meta-geo.js
    ├── google-region-probe.js
    └── google-region-check.js
```

## Development conventions

- Keep remote scripts self-contained where practical; document any system-tool runtime requirement.
- Prefer explicit defaults and documented aliases.
- Preserve existing proxy fields unless a transformation is required.
- Treat network-based detection as fallible and retain an `unknown` state.
- Remove probe-only metadata before final subscription output.
- Keep stable filenames once they are referenced by Sub-Store remote-script URLs.

## Upstream

Sub-Store's Script Operator expects an `operator(proxies)` function and exposes `$arguments` / `$options` to the script runtime. This repository follows that model.
