# substore-operators

**English** | [简体中文](./README.zh-CN.md)

Personal [Sub-Store](https://github.com/sub-store-org/Sub-Store) remote operators for proxy subscription processing.

The repository separates static policy from dynamic probing: classify nodes into user-defined pools first, then let sing-box / daed / Xray urltest or load balancing compete only inside the selected pool.

This prevents a low-RTT but poor China-route node from defeating a better route purely because latency is lower.

## Operators

### `protocol-filter.js`

Filters the original subscription to VLESS / Hysteria2 and, before DNS Resolve replaces `server` with an IP:

1. preserves the Hysteria2 TLS hostname when needed;
2. stores the original hostname in temporary `_originServer` metadata for later node classification.

Remote script:

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

---

## `node-profile-filter.js`

This is the route/policy classification operator.

Remote script:

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/node-profile-filter.js
```

### Mental model

Remember three lines:

```text
rules / rulesUrl = define what each node is
profile / route / traffic / ... = filter using that metadata
urltest = choose the current winner only among surviving nodes
```

The operator contains **no built-in node, provider, or route data**.

### 1. What are `rules`?

`rules` are your node-profile database.

Each rule has two explicit parts:

```json
{
  "match": {
    "host": "node-a.example.com"
  },
  "set": {
    "provider": "provider-a",
    "route": "optimized",
    "traffic": "high",
    "profile": "main"
  }
}
```

Meaning:

```text
if original hostname == node-a.example.com
then assign:
  provider = provider-a
  route    = optimized
  traffic  = high
  profile  = main
```

`match` identifies a node. `set` assigns metadata.

Supported match fields:

```text
host
hostRegex
name
nameRegex
subName
subNameRegex
```

`host` is recommended because `protocol-filter.js` preserves the original hostname in `_originServer` before DNS Resolve changes `server` to an IP.

Supported set fields:

```text
provider
route
traffic
profile
region
asn
```

Country, ASN, and latency are never used to infer route quality.

### 2. What is `profile`?

`profile` is simply a **user-defined business/policy label**.

For example:

```text
main      primary pool
premium   high-quality but limited/expensive pool
backup    standard-route fallback pool
```

Assign it explicitly in your rule:

```json
"profile": "main"
```

There is **no automatic derivation**.

Therefore:

```text
route=optimized
```

does not automatically imply:

```text
profile=main
```

`route`, `traffic`, and `profile` are independent dimensions.

You may also use arbitrary profile names such as:

```text
home
work
streaming
```

### 3. Why keep `route`, `traffic`, and `profile` separate?

They describe different facts.

Example:

```json
{
  "route": "optimized",
  "traffic": "low",
  "profile": "premium"
}
```

means an optimized China route with limited/expensive traffic assigned to the `premium` pool.

Another node might be:

```json
{
  "route": "standard",
  "traffic": "high",
  "profile": "backup"
}
```

This allows both direct pool selection:

```text
profile=main
```

and ad-hoc filtering:

```text
route=optimized&region=JP
```

### 4. Recommended way to predefine all nodes: `rulesUrl`

For more than a couple of nodes, keep profile definitions in a separate JSON file such as:

```text
node-profile-rules.json
```

Example:

```json
[
  {
    "match": {
      "host": "node-a.example.com"
    },
    "set": {
      "provider": "provider-a",
      "route": "optimized",
      "traffic": "high",
      "profile": "main",
      "region": "JP"
    }
  },
  {
    "match": {
      "host": "node-b.example.com"
    },
    "set": {
      "provider": "provider-b",
      "route": "optimized",
      "traffic": "low",
      "profile": "premium",
      "region": "JP"
    }
  },
  {
    "match": {
      "host": "node-c.example.com"
    },
    "set": {
      "provider": "provider-c",
      "route": "standard",
      "traffic": "high",
      "profile": "backup",
      "region": "US"
    }
  }
]
```

A generic template is included at:

```text
examples/node-profile-rules.example.json
```

Host your own JSON at an HTTP(S) URL that Sub-Store can reach, then use:

```text
node-profile-filter.js#rulesUrl=<URL-encoded-JSON-URL>&profile=main
```

Conceptually:

```text
rulesUrl=https://example.com/node-profile-rules.json
profile=main
```

The operator loads the JSON, classifies the nodes, then keeps only `profile=main`.

If `rulesUrl` cannot be fetched, the operator fails instead of silently running with empty rules.

### 5. Inline `rules`

For quick tests or one/two nodes, pass rules directly:

```json
[
  {
    "match": {
      "host": "node-a.example.com"
    },
    "set": {
      "route": "optimized",
      "profile": "main"
    }
  }
]
```

URL-encode the JSON and pass it as:

```text
rules=<encoded JSON>
```

`rulesUrl` and `rules` can be combined. Remote rules are applied first and inline rules last, so inline rules can override remote configuration.

Legacy flat rules remain accepted for compatibility:

```json
{
  "host": "node-a.example.com",
  "route": "optimized"
}
```

but the explicit `match` / `set` form is recommended.

### 6. Filters

| Parameter | Example | Meaning |
| --- | --- | --- |
| `profile` | `main,premium` | User-defined policy pool |
| `route` | `optimized` | Route class |
| `traffic` | `high` | Traffic/cost tier |
| `region` | `JP,US` | Server region |
| `provider` | `provider-a` | Provider |
| `asn` | `12345,AS67890` | ASN |
| `host` | `node-a.example.com` | Original hostname |

Values within one field use OR:

```text
profile=main,premium
```

means `main OR premium`.

Different fields use AND:

```text
route=optimized&region=JP,SG
```

means:

```text
route=optimized
AND
(region=JP OR region=SG)
```

### 7. Common examples

Primary pool:

```text
.../node-profile-filter.js#rulesUrl=<encoded-url>&profile=main
```

Premium pool:

```text
.../node-profile-filter.js#rulesUrl=<encoded-url>&profile=premium
```

Backup pool:

```text
.../node-profile-filter.js#rulesUrl=<encoded-url>&profile=backup
```

All optimized routes regardless of profile:

```text
.../node-profile-filter.js#rulesUrl=<encoded-url>&route=optimized
```

Optimized Japan nodes:

```text
.../node-profile-filter.js#rulesUrl=<encoded-url>&route=optimized&region=JP
```

### 8. MMDB is optional

If your rules already define `region`, and you do not need automatic ASN lookup, no MMDB configuration is required.

If configured via:

```text
SUB_STORE_MMDB_COUNTRY_PATH
SUB_STORE_MMDB_ASN_PATH
```

or script parameters, MMDB can enrich the DNS-resolved server IP with:

```text
region
asn
aso
```

Rule-supplied `region/asn` values take precedence. Country/ASN are never used to infer `route`.

### 9. Diagnostics

Enable:

```text
metadata=true
```

to temporarily keep:

```text
_nodeProfile.host
_nodeProfile.provider
_nodeProfile.route
_nodeProfile.traffic
_nodeProfile.profile
_nodeProfile.region
_nodeProfile.asn
_nodeProfile.aso
```

The final Google filter removes `_nodeProfile` and `_originServer` defensively.

---

### `http-meta-geo.js`

Forked from xream's `http_meta_geo.js`. Hysteria2 `ports` is removed only from the temporary HTTP META probe copy so the primary `port` is used for probing; the final subscription keeps port hopping intact.

Use this when you need real proxy-egress Country/ASN. `node-profile-filter.js` MMDB enrichment instead describes the DNS-resolved server IP itself.

### `google-region-probe.js`

Google-region probe using HTTP META / Mihomo and YouTube Premium. Results are:

```text
clean | cn | unknown
```

and stored in `_googleStatus`.

### `google-region-check.js`

Filters `_googleStatus`:

| `googleStatus` | Result |
| --- | --- |
| `all` | Keep all |
| `clean` / `ok` | Confirmed clean only |
| `non-cn` | Keep `clean + unknown` |
| `cn` / `china` | Confirmed CN only |
| `unknown` | Indeterminate only |

It removes `_geo`, `_googleStatus`, `_originServer`, and `_nodeProfile` before final output.

## Recommended pipeline

```text
original subscription
        │
        ▼
protocol-filter.js
  protocol filter + preserve SNI / _originServer
        │
        ▼
DNS Resolve
  hostname -> IP
        │
        ▼
node-profile-filter.js
  rules/rulesUrl define metadata
  profile/route/... select a candidate pool
        │
        ▼
google-region-probe.js
  probe surviving nodes only
        │
        ▼
google-region-check.js
  Google filter + metadata cleanup
        │
        ▼
sing-box / daed / Xray
        │
        ▼
urltest / load balance
inside the selected pool only
```

Core principle:

```text
You decide which pool a node belongs to.
URLTest only decides which node wins inside that pool now.
```

## Repository layout

```text
.
├── README.md
├── README.zh-CN.md
├── examples/
│   └── node-profile-rules.example.json
└── operators/
    ├── protocol-filter.js
    ├── node-profile-filter.js
    ├── http-meta-geo.js
    ├── google-region-probe.js
    └── google-region-check.js
```

## Maintenance principles

- Operator source contains no personal node, provider, or route built-ins.
- Do not infer China-route quality from RTT.
- Do not infer “optimized” from Country/ASN.
- `profile` is explicit user-defined policy metadata, not derived from `route/traffic`.
- Leave unknown route attributes unknown.
- Keep an explicit `unknown` state for dynamic probes.
- Remove temporary metadata before final output.
