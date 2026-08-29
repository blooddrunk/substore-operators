# substore-operators

[English](./README.md) | **简体中文**

用于代理订阅处理的个人 [Sub-Store](https://github.com/sub-store-org/Sub-Store) 远程 Operator 脚本集合。

这个仓库用于统一管理可复用的 Sub-Store 脚本，使这些脚本可以通过 Git 进行版本管理、审查和维护，并直接作为远程脚本加载到 Sub-Store 中。

## Operators

### `protocol-filter.js`

用于处理 3x-ui 原始订阅，只保留当前使用的节点协议，同时在后续「域名解析」Action 将 `server` 从域名替换为 IP 之前，为 Hysteria2 节点保护原始 TLS 主机名。

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

### `http-meta-geo.js`

Fork 自 xream 的 `http_meta_geo.js`。主要保留上游通用能力，同时针对本仓库的 Hysteria2 节点做了一项兼容处理：**进入 HTTP META 检测前，仅在临时检测副本中删除 `ports`，强制使用主 `port`。原始节点和最终订阅中的端口跳跃配置完全不变。**

远程脚本地址：

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/http-meta-geo.js
```

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

远程脚本地址：

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/google-region-check.js
```

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

两个常用生产策略：

```text
googleStatus=clean
```

严格模式：只有成功确认正常的节点才保留；瞬时网络失败也会被删除。

```text
googleStatus=non-cn
```

保守剔除模式：只删除明确判定为 `cn` 的节点，`unknown` 不会因为一次探测失败而被误删。

分类完成后脚本会删除 `_geo` 和 `_googleStatus`，检测元数据不会进入最终订阅。

> `www.google.cn` 属于经验性判据，并非 Google 官方 API。网络失败必须与 `cn` 分开处理，因此始终保留 `unknown` 状态。

## 推荐的 Sub-Store 处理链路

```text
3x-ui 原始订阅
        │
        ▼
┌──────────────────────────────┐
│ ① protocol-filter.js         │
│                              │
│ 筛选 VLESS / Hysteria2       │
│ 在 server 变成 IP 前保护 SNI │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ ② 域名解析 Action            │
│                              │
│ DNS：Cloudflare              │
│ IP：IPv4                     │
│ 输出：只保留 IP              │
│ TLS 验证：开启               │
│ Cache：300～600 秒           │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ ③ google-region-probe.js     │
│                              │
│ 检测最终实际使用的 server IP │
│ clean / cn / unknown         │
│ HY2 检测副本临时删除 ports   │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ ④ google-region-check.js     │
│                              │
│ 严格：googleStatus=clean     │
│ 保守：googleStatus=non-cn    │
│ 清理检测元数据               │
└──────────────┬───────────────┘
               │
               ▼
            输出订阅
```

### 为什么域名解析放在 Google 检测之前

对于本仓库的使用场景，这个顺序更合理：最终订阅本来就会把节点 `server` 固定成解析后的 IP，因此 Google 探测最好验证**最终真正会输出并使用的连接配置**。

如果先用域名做 Google 探测、之后再执行 DNS Resolve，那么在域名存在多个 A 记录、DNS 缓存变化或解析结果变化时，探测阶段使用的入口 IP 与最终订阅固定下来的 IP 理论上可能不同。

因此推荐：

```text
协议过滤 / 保存 SNI
    -> DNS Resolve
    -> Google 探测
    -> Google 过滤
```

唯一重要的前提是：**DNS Resolve 之前必须保存 TLS 所需的主机名。** `protocol-filter.js` 已为没有显式 SNI 的 Hysteria2 节点完成这一步；Reality/VLESS 节点本身的 TLS/Reality SNI 等字段则继续保留。

## 可直接使用的配置

### 1. 协议过滤

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/protocol-filter.js#filterType=all
```

### 2. 域名解析

建议继续使用现有配置：Cloudflare、IPv4、IP only、TLS validation enabled、缓存 300～600 秒。

### 3. Google 探测

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/google-region-probe.js#http_meta_protocol=http&http_meta_host=127.0.0.1&http_meta_port=9876&http_meta_start_delay=3000&http_meta_proxy_timeout=10000&api=https%3A%2F%2Fwww.youtube.com%2Fpremium&concurrency=1&timeout=10000
```

### 4. Google 过滤

只保留明确正常节点：

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/google-region-check.js#googleStatus=clean
```

只剔除明确「送中」节点，保留 `clean + unknown`：

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/google-region-check.js#googleStatus=non-cn
```

排查时：

```text
googleStatus=cn
googleStatus=unknown
googleStatus=all
```

## Hysteria2 SNI 与端口跳跃

这两个处理属于不同阶段：

- `protocol-filter.js`：在 `server` 被 DNS Resolve 改为 IP 前保存正确 SNI。
- `google-region-probe.js` / `http-meta-geo.js`：只在 HTTP META 检测副本中移除 `ports`，绕过检测阶段对端口跳跃的兼容问题。

最终输出的 Hysteria2 节点仍然保留原来的：

```text
port
ports
sni
```

不会因为 DNS Resolve 或 Google 检测而丢失正式连接所需的端口跳跃与 TLS 主机名配置。

## 仓库结构

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

## 开发约定

- 每个远程脚本尽量保持自包含；若使用系统工具，应明确运行环境要求。
- 所有可配置行为提供明确默认值。
- 参数别名在文档中明确说明。
- 除非转换本身有必要，否则保留节点原始字段。
- 所有依赖网络请求的检测都必须保留 `unknown` 状态。
- 检测用临时元数据不进入最终订阅。
- 一旦脚本 URL 被 Sub-Store 使用，尽量保持文件路径稳定。

## 与 Sub-Store 的关系

Sub-Store Script Operator 会执行 `operator(proxies)`，并向脚本环境暴露 `$arguments`、`$options` 等能力。本仓库中的 Operator 按照这一运行模型编写。
