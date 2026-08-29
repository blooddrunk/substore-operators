# substore-operators

[English](./README.md) | **简体中文**

用于代理订阅处理的个人 [Sub-Store](https://github.com/sub-store-org/Sub-Store) 远程 Operator 脚本集合。

这个仓库用于统一管理可复用的 Sub-Store 脚本，使这些脚本可以通过 Git 进行版本管理、审查和维护，并直接作为远程脚本加载到 Sub-Store 中。

## 设计目标

这个仓库把“静态策略”和“动态探测”分开：

- 协议、线路等级、流量额度、地区、主机提供商属于静态/半静态策略。
- Google 区域状态属于动态探测。
- sing-box / daed / Xray 的 urltest 或负载均衡只应在已经筛选好的同等级候选池内工作。

这样可以避免“低 RTT 但中国方向线路较差”的节点，因为延迟更低而压过实际体验更好的优化线路。

## Operators

### `protocol-filter.js`

用于处理 3x-ui 原始订阅，只保留当前使用的节点协议，并在后续 DNS Resolve 将 `server` 从域名替换为 IP 前：

1. 为没有显式 SNI 的 Hysteria2 节点保护原始 TLS 主机名。
2. 把原始 `server` 域名保存为临时字段 `_originServer`，供后续节点画像脚本稳定识别主机。

远程脚本地址：

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/protocol-filter.js
```

支持的 `filterType`：

| 参数 | 输出 |
| --- | --- |
| `all` | VLESS + Hysteria2（默认） |
| `vless` | 仅 VLESS |
| `reality` | `vless` 的别名 |
| `hysteria2` | 仅 Hysteria2 |
| `hy2` | `hysteria2` 的别名 |

> 当前 `reality` 只是 `vless` 的别名。脚本暂时不会进一步检查 VLESS 节点是否真的使用 Reality。

### `node-profile-filter.js`

用于在 urltest / 负载均衡之前，按线路策略把节点划入正确的候选池。

远程脚本地址：

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/node-profile-filter.js
```

支持的过滤维度：

| 参数 | 示例 | 含义 |
| --- | --- | --- |
| `profile` | `main,premium` | 策略分组 |
| `route` | `optimized` | 中国方向线路属性 |
| `traffic` | `high` | 流量/成本等级 |
| `region` | `JP,US` | 服务器地区 |
| `provider` | `nosla,bitsflow` | 主机/线路提供方 |
| `asn` | `12345,AS67890` | 服务器 ASN |
| `host` | `nosla.haoqi90.top` | 原始主机名 |

同一字段中的多个值按 OR 处理，不同字段之间按 AND 处理。例如：

```text
route=optimized&region=JP,SG
```

表示保留“中国方向优化，并且位于日本或新加坡”的节点。

#### Profile 规则

默认推导规则：

```text
main     = optimized + high traffic
premium  = optimized + low traffic
backup   = standard
```

同时提供两个方便的 profile：

```text
optimized = route=optimized
standard  = route=standard
```

因此推荐让 `profile` 表达业务候选池，让 `route/traffic/region/provider/asn/host` 表达更细粒度筛选条件。

#### 当前内置线路事实

脚本只内置已经明确确认过的事实，不通过延迟、ASN 或国家自动猜线路质量：

```text
nosla.haoqi90.top   -> provider=nosla, route=optimized
bitsflow.haoqi90.top -> provider=bitsflow, route=standard
```

其它节点默认不猜测 `route` / `traffic`。如果要让某个节点进入 `main` 或 `premium`，需要明确补充它的 `traffic` 等级。

#### 自定义规则

可通过 `rules` 传入 JSON 数组。后匹配的规则覆盖先匹配的规则；用户规则在内置规则之后应用，因此可以补充或覆盖默认分类。

规则可按以下字段匹配：

```text
host
hostRegex
name
nameRegex
subName
subNameRegex
```

可写入以下画像字段：

```text
provider
route
traffic
region
asn
profile
```

示例：

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

在 URL fragment 中使用时需要对 JSON 进行 URL 编码。

#### MMDB：自动识别服务器地区与 ASN

Node.js 版 Sub-Store 可配置：

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

> 首次没有 MMDB 数据时不会自动下载，需要先准备文件或等定时任务运行。

`node-profile-filter.js` 会在 DNS Resolve 之后，直接对最终 `proxy.server` IP 使用本地 MMDB：

```text
server IP -> Country / ASN / AS Organization
```

不需要启动 HTTP META，因此适合做低成本的服务器侧地区/ASN 分类。

也可以通过参数覆盖路径：

```text
mmdb_country_path=/path/to/country.mmdb
mmdb_asn_path=/path/to/asn.mmdb
```

> Country/ASN 是客观元数据，但 **不会用于自动判断“中国优化线路”**。线路优化属于路由路径属性，需要依据供应商信息、traceroute/Looking Glass 和长期实测维护。

#### 调试元数据

默认不会把分类元数据写入最终订阅。排查时可启用：

```text
metadata=true
```

节点会临时带上：

```text
_nodeProfile.host
_nodeProfile.provider
_nodeProfile.route
_nodeProfile.traffic
_nodeProfile.region
_nodeProfile.asn
_nodeProfile.aso
_nodeProfile.profile
```

最终的 `google-region-check.js` 也会兜底删除 `_nodeProfile` 和 `_originServer`。

### `http-meta-geo.js`

Fork 自 xream 的 `http_meta_geo.js`。主要保留上游通用能力，同时针对本仓库的 Hysteria2 节点做了一项兼容处理：**进入 HTTP META 检测前，仅在临时检测副本中删除 `ports`，强制使用主 `port`。原始节点和最终订阅中的端口跳跃配置完全不变。**

远程脚本地址：

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/http-meta-geo.js
```

它更适合查询“真实代理出口”的 Country/ASN；而 `node-profile-filter.js` 中的 MMDB 查询针对的是 DNS Resolve 后的服务器 IP。两者含义不同。

### `google-region-probe.js`

当前推荐的 Google「送中」专用探测器。

它会通过 HTTP META / Mihomo 为每个节点创建本地代理端口，再使用容器中的 `curl` 访问：

```text
https://www.youtube.com/premium
```

特点：

- Reality 和 Hysteria2 都通过 HTTP META 实际出站。
- Hysteria2 只在检测副本中临时删除 `ports`。
- `curl` 不自动跟随重定向，避免欧洲节点陷入 YouTube consent 重定向循环。
- 2xx 页面正文包含 `www.google.cn` -> `cn`。
- 明确的非 CN consent region -> `clean`。
- 无法可靠判断的网络错误或异常响应 -> `unknown`。
- 探测结果写入 `_googleStatus=clean|cn|unknown`，供下一步过滤。

远程脚本地址：

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/google-region-probe.js
```

### `google-region-check.js`

读取 `google-region-probe.js` 写入的 `_googleStatus` 并过滤节点；如果 `_googleStatus` 不存在，则兼容旧 `_geo` + `www.google.cn` 判断方式。

支持的 `googleStatus`：

| 参数 | 含义 |
| --- | --- |
| `all` | 保留全部节点（默认） |
| `clean` | 仅保留明确检测为正常的节点 |
| `ok` | `clean` 的别名 |
| `non-cn` | 保留除明确 `cn` 以外的节点，即 `clean + unknown` |
| `cn` | 仅保留明确检测为「送中」的节点 |
| `china` | `cn` 的别名 |
| `unknown` | 仅保留无法可靠判断的节点 |

分类完成后脚本会清理 `_geo`、`_googleStatus`、`_originServer` 和 `_nodeProfile`。

## 推荐的 Sub-Store 处理链路

```text
3x-ui 原始订阅
        │
        ▼
┌──────────────────────────────┐
│ ① protocol-filter.js         │
│                              │
│ 协议过滤                     │
│ 保存 HY2 SNI                 │
│ 保存 _originServer           │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ ② DNS Resolve Action         │
│                              │
│ server 域名 -> IPv4          │
│ TLS 验证开启                 │
│ Cache 300～600 秒            │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ ③ node-profile-filter.js     │
│                              │
│ 静态：route / traffic        │
│       provider / profile     │
│ MMDB：region / ASN           │
│                              │
│ 先缩小候选池                 │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ ④ google-region-probe.js     │
│                              │
│ 只探测剩余节点               │
│ clean / cn / unknown         │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ ⑤ google-region-check.js     │
│                              │
│ Google 状态过滤              │
│ 清理临时元数据               │
└──────────────┬───────────────┘
               │
               ▼
      sing-box / daed / Xray
               │
               ▼
       urltest / load balance
     仅在同等级节点之间竞争
```

把 profile filter 放在 Google HTTP META 探测之前还有一个直接收益：不属于当前策略池的节点无需进行昂贵的实际出站检测。

## 推荐策略示例

### 仅优化线路

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/node-profile-filter.js#profile=optimized
```

### 备用普通线路

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/node-profile-filter.js#profile=backup
```

### 日本优化线路

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/node-profile-filter.js#route=optimized&region=JP
```

### 指定提供方

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/node-profile-filter.js#provider=nosla
```

### 主力 / Premium

只有在规则中已经明确维护 `traffic` 后使用：

```text
profile=main
profile=premium
```

原则是：

```text
Profile 决定候选池
URLTest 决定候选池内当前首选
```

而不是让所有节点仅靠 RTT 直接竞争。

## Hysteria2 SNI 与端口跳跃

- `protocol-filter.js`：在 `server` 被 DNS Resolve 改为 IP 前保存正确 SNI 和 `_originServer`。
- `google-region-probe.js` / `http-meta-geo.js`：只在 HTTP META 检测副本中移除 `ports`，绕过检测阶段对端口跳跃的兼容问题。

最终输出的 Hysteria2 节点仍保留正式连接所需的 `port`、`ports`、`sni`。

## 仓库结构

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

## 维护原则

- 不通过 RTT 推断中国方向线路质量。
- 不通过 Country/ASN 自动推断“中国优化”。
- 未确认的线路属性保持未知，不猜测。
- 用户规则覆盖内置规则，便于后续维护主机变化。
- 动态网络探测必须保留 `unknown` 状态。
- 临时元数据在最终订阅输出前清理。
