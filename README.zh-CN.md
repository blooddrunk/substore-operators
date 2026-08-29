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

> 当前 `reality` 只是 `vless` 的别名。脚本暂时不会进一步检查 VLESS 节点是否真的使用 Reality，例如不会检查 `flow`、Reality 相关配置字段等。这符合当前订阅中 VLESS 节点均为 Reality 的使用场景。

参数优先级：

```text
$options > $arguments > 默认值
```

默认参数：

```text
filterType=all
```

## 推荐的 Sub-Store 处理链路

```text
3x-ui 原始订阅
        │
        ▼
┌──────────────────────────────┐
│ ① protocol-filter.js         │
│                              │
│ 协议过滤：                   │
│   all   → VLESS + HY2        │
│   vless → VLESS              │
│   hy2   → Hysteria2          │
│                              │
│ 同时保护 Hysteria2 SNI       │
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
            输出订阅
```

这个执行顺序很重要。

对于没有显式设置 `sni` / `servername` 的 Hysteria2 节点，`protocol-filter.js` 会在域名解析之前，将原始 `server` 域名保存到 `sni` 中。这样即使下一步把：

```text
example.com
```

替换成：

```text
203.0.113.10
```

TLS 证书验证仍然会使用原始域名，而不是解析后的 IP。

## 行为与安全设计

- `filterType=all` 只表示保留当前需要的全部节点类型，即 VLESS + Hysteria2，并不是保留 Sub-Store 支持的所有协议。
- 已经存在的 `sni` 或 `servername` 不会被覆盖。
- 只有当 `server` 看起来是域名时才会自动推断 SNI；如果已经是 IP，则不会处理。
- 仅在需要补充 SNI 时创建新的节点对象，避免不必要地修改原节点。
- `proxy.type` 会进行去空格和小写标准化，提高对输入数据细微差异的容错能力。
- 如果 `filterType` 是未知值，脚本会直接抛出明确错误，而不是静默生成意外的订阅结果。
- 如果传入的 `proxies` 不是数组，也会直接报错，避免错误输入继续向后传播。

## 下一步：Google「送中」检测

计划增加基于节点实际出口访问 Google 的检测 Operator，并根据检测结果对节点进行分类或过滤。

这里暂时**不预设具体检测实现**。后续会先根据 Sub-Store 作者提出的检测方式逐步验证：

1. 检测依据本身是否可靠；
2. 在 Sub-Store Script Operator 的运行环境中是否可实现；
3. VLESS / Reality 和 Hysteria2 是否都能正确经过指定节点发起检测；
4. 超时、TLS 错误、代理连接失败等异常应该如何处理；
5. 最终如何与协议过滤、域名解析和订阅输出组合。

在实现层面，建议内部至少保留三个状态，而不是简单使用真假值：

| 状态 | 含义 |
| --- | --- |
| `clean` | 可以确认未「送中」 |
| `cn` | 可以确认出现「送中」特征 |
| `unknown` | 无法可靠判断 |

例如下面这些情况应该首先归为 `unknown`：

- 请求超时；
- TLS 握手失败；
- 节点连接失败；
- Google 返回异常或无法解释的 HTTP 响应；
- 检测过程中出现临时网络错误。

这样可以避免把「节点坏了」或「一次临时网络故障」错误地归类为「送中」或「未送中」。

未来可能支持类似：

```text
googleStatus=all
googleStatus=clean
googleStatus=cn
googleStatus=unknown
```

并允许和协议过滤组合，例如：

```text
filterType=hy2
googleStatus=clean
```

从而得到「仅 Hysteria2 + Google 未送中」的节点集合。

> 上述 Google 检测接口和参数目前只是规划，尚未实现。具体方案会在实际验证后再确定。

## 仓库结构

```text
.
├── README.md
├── README.zh-CN.md
└── operators/
    └── protocol-filter.js
```

随着脚本增加，原则上每个独立功能使用单独文件，例如：

```text
operators/
├── protocol-filter.js
└── google-region-check.js
```

具体命名会在实现时根据职责确定。

## 开发约定

为了让远程脚本长期稳定使用，约定：

- 每个远程脚本尽量保持完全自包含，不依赖 npm 包运行。
- 所有可配置行为都提供明确默认值。
- 参数别名需要在文档中明确说明。
- 除非转换本身有必要，否则尽量保留节点原始字段。
- 所有依赖网络请求的检测都必须考虑失败和不确定状态。
- 一旦某个脚本 URL 已经被 Sub-Store 使用，尽量保持文件路径稳定。
- 对检测算法先验证再实现，不把未经验证的网络现象直接固化成分类规则。

## 与 Sub-Store 的关系

Sub-Store 的 Script Operator 会执行名为：

```js
function operator(proxies) {
  // ...
}
```

的函数，并向脚本环境暴露 `$arguments`、`$options` 等能力。

本仓库中的 Operator 按照这一运行模型编写，并尽量避免依赖 Sub-Store 运行环境之外的组件。
