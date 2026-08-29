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

参数优先级：

```text
$options > $arguments > 默认值
```

默认参数：

```text
filterType=all
```

### `http-meta-geo.js`

Fork 自 xream 的 `http_meta_geo.js`，负责通过 HTTP META / Mihomo 让每个节点实际访问检测 URL。

本仓库只做一项行为修改：**Hysteria2 在进入 HTTP META 检测前，会在临时检测副本中删除 `ports`，强制使用主 `port`。原始节点及最终订阅中的端口跳跃配置完全不变。**

远程脚本地址：

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/http-meta-geo.js
```

Google「送中」检测使用：

```text
api=https://www.youtube.com/premium
geo=true
format={{proxy.name}}
```

经过实际测试，Reality 和带 `ports` 端口跳跃的 Hysteria2 均可以通过该 fork 正常完成探测。

### `google-region-check.js`

读取 `http-meta-geo.js` 写入的 `_geo` 响应正文，根据 `www.google.cn` 特征将节点分成三个状态，并可直接过滤。

远程脚本地址：

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/google-region-check.js
```

支持的 `googleStatus`：

| 参数 | 含义 |
| --- | --- |
| `all` | 保留全部节点（默认） |
| `clean` | 仅保留成功检测且未出现 `www.google.cn` 的节点 |
| `ok` | `clean` 的别名 |
| `cn` | 仅保留命中 `www.google.cn` 的节点 |
| `china` | `cn` 的别名 |
| `unknown` | 仅保留无法可靠判断的节点 |

分类规则：

```text
_geo 不存在 / null / undefined / 空内容
    -> unknown

_geo 包含 www.google.cn
    -> cn

其余非空 _geo
    -> clean
```

分类完成后脚本会删除 `_geo`，避免把整段 YouTube Premium HTML 带入最终订阅。

> `www.google.cn` 检测属于经验性判据，不是 Google 官方 API。本方案已经用已知「送中」节点进行了正向验证，但仍应将网络失败保留为 `unknown`，而不是误判为 `clean`。

## 推荐的 Sub-Store 处理链路

```text
3x-ui 原始订阅
        │
        ▼
┌──────────────────────────────┐
│ ① protocol-filter.js         │
│                              │
│ 筛选 VLESS / Hysteria2       │
│ 保护 Hysteria2 SNI           │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ ② http-meta-geo.js           │
│                              │
│ 通过每个节点访问：           │
│ youtube.com/premium          │
│                              │
│ HY2 检测副本临时删除 ports   │
│ geo=true -> 写入 _geo        │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ ③ google-region-check.js     │
│                              │
│ clean / cn / unknown         │
│ 推荐：googleStatus=clean     │
│ 删除检测用 _geo              │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ ④ 域名解析 Action            │
│                              │
│ DNS：Cloudflare              │
│ IP：IPv4                     │
│ 输出：只保留 IP              │
│ TLS 验证：开启               │
│ Cache：300～600 秒           │
└──────────────┬───────────────┘
               │
               ▼
            输出订阅
```

执行顺序很重要：Google 检测应在域名解析之前完成，以原始节点配置进行实际连通性测试；随后再把节点域名转换成 IP。

## 可直接使用的配置

### 1. 协议过滤

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/protocol-filter.js#filterType=all
```

### 2. Google 探测

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/http-meta-geo.js#http_meta_protocol=http&http_meta_host=127.0.0.1&http_meta_port=9876&http_meta_start_delay=3000&http_meta_proxy_timeout=10000&api=https%3A%2F%2Fwww.youtube.com%2Fpremium&geo=true&format=%7B%7Bproxy.name%7D%7D&concurrency=1&timeout=10000&retries=0
```

这里必须保留：

```text
geo=true
format={{proxy.name}}
```

`geo=true` 用于将响应写入 `_geo`，供下一步判断；`format={{proxy.name}}` 用于避免上游脚本修改节点名。

### 3. 只保留 Google 未「送中」节点

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/google-region-check.js#googleStatus=clean
```

排查时也可以分别查看：

```text
googleStatus=cn
googleStatus=unknown
```

### 4. 域名解析

建议继续使用现有配置：Cloudflare、IPv4、IP only、TLS validation enabled、缓存 300～600 秒。

## Hysteria2 SNI 与端口跳跃

这两个处理属于不同阶段：

- `protocol-filter.js`：在 `server` 被 DNS Resolve 改为 IP 前保存正确 SNI。
- `http-meta-geo.js`：只在 HTTP META 检测副本中移除 `ports`，绕过检测阶段对端口跳跃的兼容问题。

最终输出的 Hysteria2 节点仍然保留原来的：

```text
port
ports
sni
```

不会因为 Google 检测而丢失正式连接所需的端口跳跃配置。

## 仓库结构

```text
.
├── README.md
├── README.zh-CN.md
└── operators/
    ├── protocol-filter.js
    ├── http-meta-geo.js
    └── google-region-check.js
```

## 开发约定

- 每个远程脚本尽量保持完全自包含，不依赖 npm 包运行。
- 所有可配置行为提供明确默认值。
- 参数别名在文档中明确说明。
- 除非转换本身有必要，否则保留节点原始字段。
- 所有依赖网络请求的检测都必须保留 `unknown` 状态。
- 检测用临时元数据不进入最终订阅。
- 一旦脚本 URL 被 Sub-Store 使用，尽量保持文件路径稳定。

## 与 Sub-Store 的关系

Sub-Store Script Operator 会执行 `operator(proxies)`，并向脚本环境暴露 `$arguments`、`$options` 等能力。本仓库中的 Operator 按照这一运行模型编写。
