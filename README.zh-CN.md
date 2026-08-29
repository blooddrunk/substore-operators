# substore-operators

[English](./README.md) | **简体中文**

用于代理订阅处理的个人 [Sub-Store](https://github.com/sub-store-org/Sub-Store) 远程 Operator 脚本集合。

这个仓库把“静态策略”和“动态探测”分开：先按照你自己维护的线路信息把节点分池，再让 sing-box / daed / Xray 的 urltest 或负载均衡在同一候选池内部竞争。

这样可以避免“RTT 更低但中国方向线路更差”的节点，仅因为延迟更低而压过实际体验更好的线路。

## Operators

### `protocol-filter.js`

用于处理 3x-ui 原始订阅，只保留当前使用的节点协议，并在后续 DNS Resolve 将 `server` 从域名替换为 IP 前：

1. 为没有显式 SNI 的 Hysteria2 节点保存正确 TLS 主机名。
2. 把原始 `server` 域名保存到临时字段 `_originServer`，供后续 `node-profile-filter.js` 识别节点。

远程脚本：

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/protocol-filter.js
```

支持：

| `filterType` | 输出 |
| --- | --- |
| `all` | VLESS + Hysteria2（默认） |
| `vless` | 仅 VLESS |
| `reality` | `vless` 的别名 |
| `hysteria2` | 仅 Hysteria2 |
| `hy2` | `hysteria2` 的别名 |

---

## `node-profile-filter.js`

这是线路分组的核心脚本。

远程脚本：

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/node-profile-filter.js
```

### 先理解三个概念

只需要记住下面三句话：

```text
rules / rulesUrl = 定义“这个节点是什么”
profile / route / traffic / ... = 按已定义的信息筛选节点
urltest = 只在筛选后的节点之间选择当前最优
```

脚本本身 **不包含任何 built-in 节点、供应商或线路信息**。

### 1. `rules` 是干什么的？

`rules` 是你的“节点画像数据库”。

每条 rule 分成两部分：

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

含义是：

```text
如果原始主机名是 node-a.example.com
那么给这个节点记录：
  provider = provider-a
  route    = optimized
  traffic  = high
  profile  = main
```

`match` 负责“识别哪个节点”，`set` 负责“给它写入什么属性”。

#### `match` 支持哪些字段？

推荐优先使用 `host`：

```json
"match": {
  "host": "node-a.example.com"
}
```

因为 `protocol-filter.js` 会在 DNS Resolve 前保存 `_originServer`，所以后面即使：

```text
node-a.example.com -> 203.0.113.10
```

profile filter 仍然知道它原本是 `node-a.example.com`。

还支持：

```text
host
hostRegex
name
nameRegex
subName
subNameRegex
```

例如按节点名匹配：

```json
{
  "match": {
    "nameRegex": "^JP-"
  },
  "set": {
    "region": "JP"
  }
}
```

#### `set` 支持哪些属性？

```text
provider   主机/线路提供方
route      线路属性，例如 optimized / standard
traffic    流量或成本等级，例如 high / low
profile    你自己定义的业务分组
region     地区，例如 JP / US / SG
asn        ASN，例如 12345 或 AS12345
```

这些值都是你维护的静态/半静态事实。

脚本不会通过 RTT、Country 或 ASN 自动猜 `route=optimized`。

### 2. `profile` 到底是什么？

`profile` 现在只是一个 **你自己命名的业务标签**。

例如你希望最终有三个候选池：

```text
main      主力节点
premium   流量较贵、按需使用的优质节点
backup    普通线路或备用节点
```

那么直接在规则里给节点写：

```json
"profile": "main"
```

或者：

```json
"profile": "premium"
```

或者：

```json
"profile": "backup"
```

**没有任何自动推导。**

也就是说：

```text
route=optimized
```

不会自动变成：

```text
profile=main
```

`route` 和 `profile` 是两个独立维度。

你甚至可以不用 `main/premium/backup`，改成：

```text
profile=home
profile=work
profile=streaming
```

脚本不会限制 profile 的名字。

### 3. `route`、`traffic` 和 `profile` 为什么要分开？

因为它们描述的是不同事情。

例如：

```json
{
  "route": "optimized",
  "traffic": "low",
  "profile": "premium"
}
```

表示：

```text
线路：中国方向优化
流量：额度少 / 成本高
用途：放进 premium 候选池
```

而：

```json
{
  "route": "standard",
  "traffic": "high",
  "profile": "backup"
}
```

表示：

```text
线路：普通国际线路
流量：充足
用途：备用池
```

这样以后既可以按最终用途筛：

```text
profile=main
```

也可以临时做组合筛选：

```text
route=optimized&region=JP
```

### 4. 如何预先定义自己的所有节点？——推荐 `rulesUrl`

如果节点不止一两个，不推荐把整个 JSON 塞进 Sub-Store Action 参数。

推荐把节点定义单独放在一个 JSON 文件里，例如：

```text
node-profile-rules.json
```

格式：

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

仓库提供了一个无个人信息的模板：

```text
examples/node-profile-rules.example.json
```

你可以复制一份，改成自己的节点定义。

然后把这个 JSON 放在 Sub-Store 可以访问的 HTTP(S) 地址，例如 GitHub raw URL。

使用：

```text
node-profile-filter.js#rulesUrl=<URL编码后的JSON地址>&profile=main
```

例如逻辑上相当于：

```text
rulesUrl=https://example.com/node-profile-rules.json
profile=main
```

脚本先读取 JSON，给所有节点建立画像，然后只保留 `profile=main` 的节点。

> `rulesUrl` 获取失败时脚本会报错，而不是悄悄用空规则继续运行。这样可以避免配置源故障时错误地生成订阅。

### 5. 少量规则也可以直接用 `rules`

排查或者只有一两台机器时，可以直接传 JSON：

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

然后把 JSON URL encode 后作为：

```text
rules=<encoded JSON>
```

`rulesUrl` 和 `rules` 可以同时存在：

```text
rulesUrl 中的规则
        ↓
inline rules
```

后面的 inline `rules` 优先级更高，因此适合临时覆盖远程配置。

### 6. 如何筛选？

支持：

| 参数 | 示例 | 含义 |
| --- | --- | --- |
| `profile` | `main,premium` | 自定义业务分组 |
| `route` | `optimized` | 线路属性 |
| `traffic` | `high` | 流量/成本等级 |
| `region` | `JP,US` | 服务器地区 |
| `provider` | `provider-a` | 提供方 |
| `asn` | `12345,AS67890` | ASN |
| `host` | `node-a.example.com` | 原始主机名 |

同一字段多个值是 OR：

```text
profile=main,premium
```

表示：

```text
main OR premium
```

不同字段之间是 AND：

```text
route=optimized&region=JP,SG
```

表示：

```text
route=optimized
AND
(region=JP OR region=SG)
```

### 7. 常用用法

主力池：

```text
.../node-profile-filter.js#rulesUrl=<encoded-url>&profile=main
```

Premium 池：

```text
.../node-profile-filter.js#rulesUrl=<encoded-url>&profile=premium
```

备用池：

```text
.../node-profile-filter.js#rulesUrl=<encoded-url>&profile=backup
```

不管 profile，只要所有优化线路：

```text
.../node-profile-filter.js#rulesUrl=<encoded-url>&route=optimized
```

日本优化线路：

```text
.../node-profile-filter.js#rulesUrl=<encoded-url>&route=optimized&region=JP
```

指定提供方：

```text
.../node-profile-filter.js#rulesUrl=<encoded-url>&provider=provider-a
```

### 8. MMDB 是可选的

如果你的 rules 已经手动写了：

```json
"region": "JP"
```

而且不需要 ASN 自动识别，那么 **完全不需要配置 MMDB**。

如果配置了：

```text
SUB_STORE_MMDB_COUNTRY_PATH
SUB_STORE_MMDB_ASN_PATH
```

脚本可以在 DNS Resolve 后根据最终 `server` IP 自动补充：

```text
region
asn
aso
```

规则中已经手写的 `region/asn` 优先，MMDB 不会覆盖。

Country/ASN 永远不会被用于自动推断 `route`。

### 9. 调试节点画像

默认不会把画像元数据带到最终订阅。

排查时：

```text
metadata=true
```

节点会临时带上：

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

最终 `google-region-check.js` 会兜底清理 `_nodeProfile` 和 `_originServer`。

---

### `http-meta-geo.js`

Fork 自 xream 的 `http_meta_geo.js`。针对 Hysteria2，HTTP META 探测副本会临时删除 `ports`，强制使用主 `port`，原始节点的端口跳跃配置不会改变。

它适合查询“真实代理出口”的 Country/ASN；而 `node-profile-filter.js` 的 MMDB 查询描述的是 DNS Resolve 后的服务器 IP。

### `google-region-probe.js`

Google「送中」实际出站探测器。通过 HTTP META / Mihomo 为节点建立本地代理，并访问 YouTube Premium。

结果：

```text
clean | cn | unknown
```

写入 `_googleStatus`。

探测结果会缓存到 Sub-Store 存储，命中缓存的后续生产会完全跳过 HTTP META：`clean` / `cn` 缓存 `cache_ttl`（默认 15 分钟），`unknown` 缓存 `unknown_cache_ttl`（默认 10 分钟，设 `0` 恢复不缓存）。缓存 `unknown` 可以避免死节点/慢节点在每次生产时都付出完整探测超时——对 daed 这类订阅更新超时硬编码为 5 秒的客户端尤其重要。探测抛出异常时，会回退使用最近一次任意类型的缓存结果。

### `google-region-check.js`

根据 `_googleStatus` 过滤：

| `googleStatus` | 含义 |
| --- | --- |
| `all` | 保留全部 |
| `clean` / `ok` | 仅明确正常 |
| `non-cn` | 保留 `clean + unknown` |
| `cn` / `china` | 仅明确送中 |
| `unknown` | 仅无法可靠判断 |

最后清理 `_geo`、`_googleStatus`、`_originServer`、`_nodeProfile`。

## 推荐处理链路

```text
3x-ui 原始订阅
        │
        ▼
protocol-filter.js
  协议过滤 + 保存 SNI / _originServer
        │
        ▼
DNS Resolve
  server hostname -> IP
        │
        ▼
node-profile-filter.js
  rules/rulesUrl 定义节点画像
  profile/route/... 缩小候选池
        │
        ▼
google-region-probe.js
  只探测剩余节点
        │
        ▼
google-region-check.js
  Google 状态过滤 + 清理临时元数据
        │
        ▼
sing-box / daed / Xray
        │
        ▼
urltest / load balance
只在同一候选池中竞争
```

核心原则：

```text
你定义节点属于哪个池。
URLTest 只决定这个池里当前选谁。
```

## 仓库结构

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

## 维护原则

- Operator 源码不包含任何个人节点、供应商或线路 built-in 信息。
- 不通过 RTT 推断中国方向线路质量。
- 不通过 Country/ASN 自动推断“中国优化”。
- `profile` 是显式业务标签，不自动由 `route/traffic` 推导。
- 未确认的线路属性保持未知。
- 动态探测保留明确的 `unknown` 状态。
- 临时元数据在最终订阅输出前清理。
