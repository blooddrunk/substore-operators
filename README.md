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

> `reality` is intentionally only an alias of `vless` at the moment. The script does **not** inspect VLESS Reality-specific fields. This matches the current subscription, where the VLESS nodes are Reality nodes.

Parameter priority:

```text
$options > $arguments > defaults
```

Default:

```text
filterType=all
```

## Recommended Sub-Store pipeline

```text
3x-ui original subscription
        │
        ▼
┌──────────────────────────────┐
│ ① protocol-filter.js         │
│                              │
│ Protocol filtering:          │
│   all   → VLESS + HY2        │
│   vless → VLESS              │
│   hy2   → Hysteria2          │
│                              │
│ Preserve Hysteria2 SNI       │
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
        subscription output
```

The order matters. For Hysteria2 nodes without explicit `sni` / `servername`, the operator copies the original hostname into `sni` **before** DNS resolution changes `server` to an IP. This keeps TLS certificate verification tied to the original hostname.

## Behavior and safety

- Only VLESS and Hysteria2 are retained when `filterType=all`; `all` does not mean every protocol.
- Existing `sni` or `servername` values are never overwritten.
- An SNI value is inferred only when `server` looks like a hostname rather than an IP address.
- The operator returns a new object only when it needs to add inferred SNI, avoiding unnecessary mutation of the original node.
- Unknown `filterType` values fail fast with a clear error instead of silently returning an unexpected subscription.

## Planned operators

### Google region / "送中" detection

The next operator can probe Google through each node and classify it before output/grouping. It should use **three states**, not a simple boolean:

- `clean` — Google behaves as expected / not redirected to mainland China handling.
- `cn` — confirmed mainland-China redirect or equivalent positive signal.
- `unknown` — timeout, TLS failure, transport failure, ambiguous HTTP response, or any other result that cannot safely be classified.

Keeping `unknown` separate is important: a broken node or transient Google failure should never be treated as either definitely clean or definitely "送中".

A future implementation can optionally add a prefix/suffix to node names or expose separate filtered outputs for these states.

## Repository layout

```text
.
├── README.md
├── README.zh-CN.md
└── operators/
    └── protocol-filter.js
```

## Development conventions

- Keep every remote script self-contained; do not require npm dependencies at runtime.
- Prefer explicit defaults and documented aliases.
- Preserve existing proxy fields unless a transformation is required.
- Treat network-based detection as fallible and retain an `unknown` state.
- Keep stable filenames once they are referenced by Sub-Store remote-script URLs.

## Upstream

Sub-Store's Script Operator expects an `operator(proxies)` function and exposes `$arguments` / `$options` to the script runtime. This repository follows that model.
