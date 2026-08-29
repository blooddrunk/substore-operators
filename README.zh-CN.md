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

## VPS 部署与 daed 订阅超时（生产环境实录）

**本节是实际生产部署的完整记录，中文为主维护；英文 README 仅保留摘要。**

### 架构总览

```text
OpenWrt 路由器 (192.168.10.1)
  daed 2026.08.13，7 个订阅，cron 10 */6 * * *
        │  HTTPS（订阅更新，单次尝试硬编码 5s 超时）
        ▼
VPS 203.0.113.10（substore 与 bitsflow 节点同机）
  1Panel openresty 容器（host 网络，监听 80/443）
    └── substore.example.com 站点
        └── proxy_cache（本节部署的下载缓存，HIT ≈ 30ms）
              │ 未命中/过期时回源
              ▼
        sub-store 容器（xream/sub-store:http-meta，127.0.0.1:48238）
          ① protocol-filter.js ② DNS Resolve ③ node-profile-filter.js
          ④ google-region-probe.js（HTTP META + Mihomo，本仓库探测缓存）
          ⑤ google-region-check.js
              │ 拉取上游订阅
              ▼
        bwh / nosla / lightlayer / bitsflow 各 VPS 的订阅端点
```

### 为什么需要缓存层

dae-wing（daed 后端）更新订阅的源码 `graphql/service/subscription/mutation_utils.go`：

```go
timeout := 10 * time.Second
// 先直连 timeout/2 = 5s，失败再走路由 5s，均不可配置
return nil, fmt.Errorf("%v (direct); %w (route)", err, err2)
```

对应 daed 前端的报错：

```text
Get "https://substore.../download/collection/MySub?...": context deadline exceeded
(Client.Timeout exceeded while awaiting headers) (direct); ... (route)
```

实测 `collection/MySub` 生产耗时：探测缓存全命中时 ~0.5s；缓存过期（探测缓存 TTL 15 分钟，
而 daed 每 6 小时更新，每次必然冷启动）或配置了 `http_meta_start_delay=3000` 时 5~7s。
超过 5 秒 daed 必挂。修复共三层：

1. **Operator 层**（本仓库，已生效）：`unknown` 探测结果短 TTL 缓存（`unknown_cache_ttl`，
   默认 10 分钟，`0` 恢复旧行为）；探测异常回退最近一次任意类型缓存结果。
2. **openresty 层**（VPS，已部署）：`proxy_cache` + stale-while-revalidate，详见下节。
3. **保热 cron**（VPS，已部署）：每 5 分钟刷新缓存，daed 的 6 小时定时任务永远命中热缓存。

### openresty 下载缓存部署细节

配置模板：[configs/openresty-substore-cache.conf](./configs/openresty-substore-cache.conf)。
1Panel 的 openresty 容器为 host 网络（能直接访问宿主机 `127.0.0.1:48238`），两个文件：

```text
① /opt/1panel/www/conf.d/substore-cache.conf
   （→ 容器 conf.d，随 nginx.conf http{} include 生效）
   proxy_cache_path /www/cache/substore ... keys_zone=substore_cache

② /opt/1panel/www/sites/substore.example.com/proxy/download.conf
   （→ 站点 server{} include 的 proxy/*.conf）
   location ^~ /PATH_TOKEN/download/ { proxy_cache ... }
```

要点：

- 缓存目录放 `/www/cache/substore`（宿主机 `/opt/1panel/www/cache/substore`），随 1Panel
  数据卷持久化；openresty 容器被 watchtower 重建后目录仍在，避免 nginx 因缺目录启动失败。
- `proxy_cache_key "$scheme$proxy_host$request_uri"`：不同 `$options` 变体独立缓存。
- `proxy_cache_lock on`：收拢 daed 同一秒并发更新 7 个订阅造成的回源风暴。
- `proxy_cache_background_update on` + `proxy_cache_use_stale ... updating http_500 ...`：
  过期先回旧值再后台刷新；上游慢或瞬时 500 永不透传给 daed。
- `location ^~ /PATH_TOKEN...` 最长前缀优先，覆盖原有 `root.conf` 的 `location ^~ /`，
  其余路径（Sub-Store 管理界面等）仍走原配置。

生效与验证：

```bash
docker exec openresty-container nginx -t
docker exec openresty-container nginx -s reload

# 首次 MISS（可能 5~6s，被 openresty 吸收），之后 HIT ≈ 30ms
curl -sI 'https://substore.example.com/PATH_TOKEN/download/bwh' | grep -i x-cache-status
```

`X-Cache-Status` 含义：`MISS` 回源 / `HIT` 命中 / `STALE` 旧值后台刷新中 /
`UPDATING` 后台刷新期间 / `BYPASS` 未走缓存（路径不匹配时检查 location）。

### 保热 cron

脚本：[configs/keepwarm.sh](./configs/keepwarm.sh)。

```bash
cp configs/keepwarm.sh /usr/local/bin/substore-keepwarm.sh && chmod +x /usr/local/bin/substore-keepwarm.sh
( crontab -l; echo '*/5 * * * * /usr/local/bin/substore-keepwarm.sh >/dev/null 2>&1' ) | crontab -
```

### Sub-Store 中 google-region-probe.js 的推荐参数

`http_meta_start_delay=3000` 一项就占掉 daed 5s 预算的 60%，建议 1500（默认值）：

```text
api=https%3A%2F%2Fwww.youtube.com%2Fpremium&concurrency=5&http_meta_start_delay=1500&share_by_server=true&timeout=10000
```

`share_by_server=true` 建议保留：同一 VPS 的多个入站共享同一出站路径，可合并探测。

### 证书与面板访问（bitsflow VPS 实录）

- 3x-ui 面板 `:28339`（路径 `/PATH_TOKEN/`）、订阅服务 `:2096`（路径 `/PATH_TOKEN/`）
  均使用 `/root/cert/bitsflow.example.com/` 的 Let's Encrypt 证书（含 `*.bitsflow.example.com` 泛域名 SAN）。
- 续期由 VPS 上的 acme.sh cron（`12 2,8,14,20 * * *`，Cloudflare DNS-01）全自动完成，
  与 1Panel 各管各的证书目录，互不冲突；DNS-01 也不需要抢占 80 端口。
- **必须用域名访问**：`https://bitsflow.example.com:28339/...`。若用 IP 访问
  （`https://203.0.113.10:28339`），证书 SAN 只有域名，Chrome 报
  `ERR_CERT_COMMON_NAME_INVALID`——证书本身没有问题。
- `https://bitsflow.example.com/`（443 端口）会被 openresty 以 `unrecognized name` 拒绝：
  443 上只有 substore / panel3 / hs-bitsflow 三个站点，没有 bitsflow 裸域名的站点。

## 仓库结构

```text
.
├── README.md
├── README.zh-CN.md
├── configs/
│   ├── README.md（节点档案与部署说明）
│   ├── node-profile-rules.json
│   ├── openresty-substore-cache.conf（VPS 下载缓存模板）
│   └── keepwarm.sh（VPS 保热脚本）
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
