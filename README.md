# substore-operators

用于代理订阅处理的 [Sub-Store](https://github.com/sub-store-org/Sub-Store) 远程 Operator 脚本集合。

这套脚本把**静态策略**与**动态探测**分开：先按你维护的节点档案（provider / route / traffic / profile …）把节点划入不同候选池，再对池内节点做 Google「送中」探测，最后交给 sing-box / daed / Xray 的 urltest 或负载均衡在**同一个池内部**竞争。这样可以避免「RTT 更低但中国方向线路更差」的节点，仅因为延迟低就压过实际体验更好的线路。

核心原则一句话：

```text
你定义节点属于哪个池；URLTest 只决定这个池里当前选谁。
```

## 目录

- [Pipeline 总览](#pipeline-总览)
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [详细配置](#详细配置)
  - [protocol-filter.js](#protocol-filterjs)
  - [node-profile-filter.js](#node-profile-filterjs)
  - [google-region-probe.js](#google-region-probejs)
  - [google-region-check.js](#google-region-checkjs)
  - [可选脚本 http-meta-geo.js](#可选脚本-http-meta-geojs)
  - [进阶技巧](#进阶技巧)
- [VPS 生产部署与 daed 订阅超时](#vps-生产部署与-daed-订阅超时)
- [Troubleshooting](#troubleshooting)
- [仓库结构](#仓库结构)
- [维护原则](#维护原则)

## Pipeline 总览

| 顺序 | 操作 | 类型 | 作用 |
| --- | --- | --- | --- |
| ① | `protocol-filter.js` | 脚本 | 只保留 VLESS / Hysteria2；把原始域名保存到 `_originServer`；为 Hysteria2 补 SNI |
| ② | DNS 解析 | Sub-Store 内置 | 把节点 `server` 从域名解析成 IP |
| ③ | `node-profile-filter.js` | 脚本 | 按节点档案规则打标，用 `profile` 等条件过滤出候选池 |
| ④ | `google-region-probe.js` | 脚本（需 HTTP META） | 经节点访问 Google，判定 `clean / cn / unknown` 写入 `_googleStatus` |
| ⑤ | `google-region-check.js` | 脚本 | 按探测结果过滤，并清理全部临时元数据 |

```text
3x-ui 等原始订阅
      │
      ▼
① protocol-filter.js ──► ② DNS 解析 ──► ③ node-profile-filter.js
                                            │ 只剩候选池内的节点
                                            ▼
                          ④ google-region-probe.js ──► ⑤ google-region-check.js
                                                                      │
                                                                      ▼
                                                sing-box / daed / Xray 的 urltest、负载均衡
```

理解这套脚本只需要三句话：

```text
rules / rulesUrl   定义「这个节点是什么」（provider、route、profile …）
profile / route …  按已定义的档案筛选节点
urltest            只在筛选后的节点里选当前最优
```

所有 Operator 源码都**不内置**任何节点、供应商或线路信息，档案完全由你自己的规则文件决定；脚本也不会通过 RTT、Country 或 ASN 去猜「中国优化线路」，未确认的属性保持未知。

## 环境要求

| 组件 | 要求 |
| --- | --- |
| Sub-Store 后端 | Node.js 版。只用 ①③⑤ 不需要额外组件；用 ④ 需要带 HTTP META 的运行环境 |
| HTTP META | [xream/http-meta](https://github.com/xream/http-meta) 服务 + mihomo 内核 + `curl` 命令。直接用 `xream/sub-store:http-meta` 镜像部署 Sub-Store 即自带 |
| 节点档案 JSON | 托管在 Sub-Store 后端可访问的 HTTP(S) 地址，推荐 GitHub secret gist 的 raw URL |
| 客户端 | sing-box / daed / Xray 等任意支持 urltest / 负载均衡的客户端 |
| MMDB（可选） | GeoLite2 Country / ASN 数据库，用于自动补全 region / asn / aso |

## 快速开始

以下从零跑通整条链路。①②③ 是最小可用配置（只分池、不探测）；④⑤ 依赖 HTTP META 环境，暂时不需要时可先跳过。

### 1. 部署 Sub-Store 后端

探测功能要求运行环境带 HTTP META，直接使用 `xream/sub-store:http-meta` 镜像最省事：

```bash
docker run -it -d --restart=always --network host \
  -e "SUB_STORE_BACKEND_API_HOST=127.0.0.1" \
  -e "SUB_STORE_BACKEND_API_PORT=3001" \
  -e "SUB_STORE_FRONTEND_BACKEND_PATH=/随机生成的路径标识" \
  -v /opt/sub-store:/opt/app/data \
  xream/sub-store:http-meta
```

- API 只监听本机 `127.0.0.1:3001`，生产环境建议由 Nginx / openresty 反代并加 HTTPS 后对外（见[「VPS 生产部署与 daed 订阅超时」](#vps-生产部署与-daed-订阅超时)一节）。
- `SUB_STORE_FRONTEND_BACKEND_PATH` 是前后端对接的路径标识，自己随机生成并妥善保管，泄露等于把后端暴露给他人。
- 浏览器访问反代域名打开前端（镜像自带前端页面），也可以使用[官方托管前端](https://sub-store.vercel.app)连接同一后端。
- 其他部署方式（docker compose、已有 Sub-Store 加装 HTTP META 等）见 [Sub-Store 官方文档](https://github.com/sub-store-org/Sub-Store/wiki)。

### 2. 添加上游订阅

前端「订阅」页添加一条订阅，名称如 `MySub`，填入 3x-ui 等上游订阅地址。多个上游可以分别添加，之后用「组合」合并处理。

### 3. 编写并托管节点档案

1. 复制模板 `examples/node-profile-rules.example.json`，把每条规则的 `match.host` 改成你节点的真实 `server` 域名，并在 `set` 里填写属性（至少写 `profile`，即该节点属于哪个池）。
2. 新建一个 GitHub **secret gist**，粘贴这份 JSON，取得 raw 地址：

   ```text
   https://gist.githubusercontent.com/<user>/<gist-id>/raw/node-profile-rules.json
   ```

3. 对该地址做 URL 编码（gist 地址包含 `:` 和 `/`，作为参数值拼进脚本 URL 前必须编码）：

   ```bash
   python3 -c 'import urllib.parse; print(urllib.parse.quote("https://gist.githubusercontent.com/<user>/<gist-id>/raw/node-profile-rules.json", safe=""))'
   ```

   输出形如 `https%3A%2F%2Fgist.githubusercontent.com%2F...`，下文记作 `<编码后的rules地址>`。

### 4. 按顺序配置操作

编辑订阅 →「操作」，按下表从上到下添加。每行的「脚本」操作选择远程链接类型，填入对应 URL：

| # | 操作类型 | 远程链接 / 配置 |
| --- | --- | --- |
| ① | 脚本 | `https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/protocol-filter.js` |
| ② | DNS 解析 | 默认参数即可 |
| ③ | 脚本 | `https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/node-profile-filter.js#rulesUrl=<编码后的rules地址>&profile=main` |
| ④ | 脚本 | `https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/google-region-probe.js#api=https%3A%2F%2Fwww.youtube.com%2Fpremium&concurrency=5&http_meta_start_delay=1500&share_by_server=true&timeout=10000` |
| ⑤ | 脚本 | `https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/google-region-check.js#googleStatus=non-cn` |

顺序要求：

- ① 必须在 ② 之前：② 会把 `server` 换成 IP，① 先把原始域名存进 `_originServer`，③ 才能在 DNS 解析后依然按域名匹配节点。
- ④ 必须在 ③ 之后：只探测过滤后剩下的节点，避免浪费探测时间。
- ⑤ 必须最后：它负责清理 `_originServer`、`_nodeProfile`、`_googleStatus` 等临时字段。

### 5. 验证

- 在前端「预览」该订阅：应只剩档案里 `profile=main` 的节点。
- 节点数量不符合预期时，把 ③ 临时改成 `...&profile=all&metadata=true` 再预览，每个节点会附带 `_nodeProfile` 字段，能看到命中的画像（host、route、profile …）；`_nodeProfile.host` 为空说明该节点没有命中任何规则。排查完改回。
- 探测是否生效看后端日志（`docker logs -f <容器名>`），正常会出现：

  ```text
  Google probe HTTP META started: pid=..., ports=...
  [节点名] status: 200, verdict: clean, latency: ...
  ```

### 6. 接入客户端

复制该订阅的「下载链接」填入 daed / sing-box / Xray 客户端。需要多个候选池时，复制这条订阅（或改用「组合」），把 ③ 里的 `profile=main` 换成 `premium`、`backup` 等你自定义的池名。daed 用户请务必阅读 [VPS 生产部署与 daed 订阅超时](#vps-生产部署与-daed-订阅超时)。

## 详细配置

参数传递方式的统一说明：

- 脚本参数拼在脚本 URL 的 `#` 之后，用 `&` 分隔，作为该操作的固定参数（脚本内的 `$arguments`）。
- `protocol-filter.js`、`node-profile-filter.js`、`google-region-check.js` 还支持在**下载链接**上用 `?$options=<URL 编码的参数串>` 按请求临时覆盖（脚本内的 `$options`，优先级高于 `$arguments`），用法见[进阶技巧](#进阶技巧)。
- 所有匹配都不区分大小写；`asn` 参数自动兼容 `12345` 与 `AS12345` 两种写法。

### protocol-filter.js

远程脚本：

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/protocol-filter.js
```

在 DNS 解析之前做三件事：

1. 按协议过滤，只保留当前使用的节点协议；
2. 把原始 `server` 域名保存到临时字段 `_originServer`，供 ③ 在 DNS 解析后识别节点；
3. 为没有显式 SNI 的 Hysteria2 节点把 `server` 域名写入 `sni`，避免解析成 IP 后 TLS 握手用错主机名。

| `filterType` | 输出 |
| --- | --- |
| `all` | VLESS + Hysteria2（默认） |
| `vless` | 仅 VLESS |
| `reality` | `vless` 的别名 |
| `hysteria2` | 仅 Hysteria2 |
| `hy2` | `hysteria2` 的别名 |

适用于处理 3x-ui 原始订阅；如果你的订阅协议本来就很干净，也可以不加这个操作（此时 ③ 将直接用 `server` 字段做 host 匹配，前提是 ③ 排在 DNS 解析之前，或节点 `server` 本身就是域名）。

### node-profile-filter.js

线路分组的核心脚本。远程脚本：

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/node-profile-filter.js
```

#### 规则格式

每条规则由 `match`（识别节点）和 `set`（写入属性）两部分组成：

```json
{
  "match": { "host": "node-a.example.com" },
  "set": {
    "provider": "provider-a",
    "route": "optimized",
    "traffic": "high",
    "profile": "main",
    "region": "JP"
  }
}
```

`match` 支持的字段（全部可选，多个字段同时给出时为 AND）：

| 字段 | 说明 |
| --- | --- |
| `host` | 原始 `server` 域名。**推荐**：来自 `_originServer`，DNS 解析后依然可用 |
| `hostRegex` | 域名正则 |
| `name` / `nameRegex` | 节点名 / 节点名正则 |
| `subName` / `subNameRegex` | 订阅名 / 订阅名正则 |

`set` 支持的属性：

| 字段 | 归一化 | 含义 |
| --- | --- | --- |
| `provider` | 小写 | 主机 / 线路提供方 |
| `route` | 小写 | 线路属性，如 `optimized` / `standard` |
| `traffic` | 小写 | 流量 / 成本等级，如 `high` / `medium` / `low` |
| `profile` | 小写 | 业务分组标签，名字完全自定义 |
| `region` | 大写 | 地区，如 `JP` / `US` |
| `city` | 大写 | 城市，如 `TYO` / `SJC` |
| `asn` | 去 `AS` 前缀 | 如 `12345` 或 `AS12345` |

规则按数组顺序应用，后命中的规则覆盖先命中的；`rulesUrl` 的远程规则先应用、内联 `rules` 后应用，因此内联规则可以临时覆盖远程配置。旧版扁平格式（`{"host": "...", "route": "..."}`）仍兼容，但推荐显式 `match` / `set` 写法。

#### profile 的语义

`profile` 是你自己命名的业务标签，**没有任何自动推导**：`route=optimized` 不会自动等于 `profile=main`，`route`、`traffic`、`profile` 是三个独立维度。常见的三分池：

```text
main     主力池
premium  优质但流量贵、按需使用
backup   普通线路、备用
```

三个维度分开维护的价值在于：既能按最终用途筛 `profile=main`，也能临时组合筛 `route=optimized&region=JP`。profile 的名字不受任何限制，用 `home` / `work` / `streaming` 一样可以。

#### 规则来源与参数速查

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `rulesUrl` | — | 规则文件地址（别名 `rules_url`），返回 JSON 数组或 `{"rules": [...]}`。需 URL 编码后拼接。**获取失败时脚本直接报错**，不会用空规则静默生成订阅；`rulesCacheTtl` 内有旧缓存时降级使用 stale 缓存并记录日志 |
| `rules` | — | 内联规则 JSON 数组（同样 URL 编码），适合少量规则的排查或临时覆盖 |
| `rulesTimeout` | `10000` | 拉取 `rulesUrl` 的超时（毫秒） |
| `rulesCacheTtl` | `900000` | 远程规则缓存时长（毫秒，默认 15 分钟），`0` 关闭缓存 |
| `profile` / `route` / `traffic` / `region` / `city` / `provider` / `asn` / `host` | 空 | 过滤条件，见下 |
| `metadata` | `false` | `true` 时在输出节点上保留 `_nodeProfile` 画像字段，用于排查 |
| `mmdb_country_path` / `mmdb_asn_path` | — | MMDB 数据库路径，也可用环境变量，见下 |

推荐把规则放在独立 JSON 文件（如 `node-profile-rules.json`）并用 `rulesUrl` 加载，而不是全部内联塞进操作参数。

#### 过滤语义

- 同一字段内逗号分隔是 OR：`profile=main,premium` 表示 `main OR premium`。
- 不同字段之间是 AND：`route=optimized&region=JP,SG` 表示 `route=optimized AND (region=JP OR region=SG)`。
- `profile=all` 表示不按 profile 过滤（其他字段不传即不过滤）。

常用组合：

```text
主力池        #rulesUrl=<编码后的rules地址>&profile=main
Premium 池   #rulesUrl=<编码后的rules地址>&profile=premium
备用池        #rulesUrl=<编码后的rules地址>&profile=backup
全部优化线路  #rulesUrl=<编码后的rules地址>&route=optimized
日本优化线路  #rulesUrl=<编码后的rules地址>&route=optimized&region=JP
指定提供方    #rulesUrl=<编码后的rules地址>&provider=provider-a
```

#### MMDB 自动补全（可选）

如果规则里已经手写了 `region`，且不需要 ASN 自动识别，则**完全不需要配置 MMDB**。配置后脚本可以在 DNS 解析后根据 `server` IP 自动补全 `region` / `asn` / `aso`：

```text
环境变量：SUB_STORE_MMDB_COUNTRY_PATH、SUB_STORE_MMDB_ASN_PATH
或参数：  mmdb_country_path=...、mmdb_asn_path=...
```

规则中手写的 `region` / `asn` 优先，MMDB 不覆盖；Country / ASN 永远不会被用于推断 `route`。

### google-region-probe.js

Google「送中」实际出站探测器。通过 HTTP META / Mihomo 为节点建立本地代理并访问 YouTube Premium，判定结果写入 `_googleStatus`。远程脚本：

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/google-region-probe.js
```

运行前提：HTTP META 服务（默认 `127.0.0.1:9876`，`xream/sub-store:http-meta` 镜像自带）、mihomo 内核、运行环境内有 `curl` 命令。

判定逻辑（默认目标 `https://www.youtube.com/premium`，最多跟随 4 次重定向）：

| 结果 | 条件 |
| --- | --- |
| `clean` | 2xx 且响应不含 `www.google.cn`；或重定向到 consent 页且 `gl` 参数为非 CN 地区 |
| `cn` | 2xx 响应含 `www.google.cn`；重定向到 `google.cn`；或 consent 页 `gl=CN` |
| `unknown` | 其余情况：请求失败、超时、无法判断的重定向等 |

参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `api` | `https://www.youtube.com/premium` | 探测目标 URL（需 URL 编码） |
| `concurrency` | `10` | 并发探测数 |
| `timeout` | `10000` | 单次 HTTP 请求超时（毫秒） |
| `probe_budget` | `8000` | 单节点探测总预算（毫秒，含重定向与启动重试，最小 1000） |
| `cache_ttl` | `900000` | `clean` / `cn` 结果缓存时长（毫秒，15 分钟），`0` 关闭 |
| `unknown_cache_ttl` | `600000` | `unknown` 结果缓存时长（毫秒，10 分钟），`0` 恢复不缓存 |
| `share_by_server` | `false` | 同一 `server` 的多个节点共享一次探测 |
| `http_meta_host` / `http_meta_port` | `127.0.0.1` / `9876` | HTTP META 服务地址与端口 |
| `http_meta_protocol` / `http_meta_authorization` | `http` / 空 | HTTP META 协议与鉴权 |
| `http_meta_start_delay` | `1500` | HTTP META 启动后等待毫秒数 |
| `http_meta_start_retry_delay` | `1500` | 代理未就绪时的重试等待毫秒数 |
| `http_meta_proxy_timeout` | `10000` | 单节点核心存活超时（用于计算 HTTP META 总超时） |
| `include_unsupported_proxy` | 关闭 | 传给内核时包含官方不支持的协议 |

行为要点：

- **结果缓存**：判定写入 Sub-Store 存储，命中缓存的生产完全跳过 HTTP META。缓存 `unknown` 可以避免死节点 / 慢节点每次生产都付出完整探测超时——对 daed 这类订阅更新超时硬编码 5 秒的客户端尤其关键（见[「VPS 生产部署与 daed 订阅超时」](#vps-生产部署与-daed-订阅超时)）。
- **异常回退**：探测抛出异常时，回退使用最近一次任意类型的缓存结果。
- **`share_by_server=true`**：把同一 `server`（DNS 解析后）的多个入站视为同一出站身份，只探测一次。适合同一 VPS 上 Reality + Hysteria2 多入站共享出站的情况；若同机不同入站可能走不同出站，保持 `false`。
- **Hysteria2 端口跳跃**：探测副本会临时删除 `ports`、强制使用主 `port`，最终订阅里的端口跳跃配置不受影响。
- 本脚本的参数只认脚本 URL `#` 后的固定参数，不支持下载链接 `$options` 覆盖。

### google-region-check.js

根据 `_googleStatus` 过滤，并清理全部临时元数据。远程脚本：

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/google-region-check.js
```

| `googleStatus` | 结果 |
| --- | --- |
| `all` | 保留全部（默认） |
| `clean` / `ok` | 仅明确正常 |
| `non-cn` | 保留 `clean + unknown`（推荐：只踢掉明确送中的节点） |
| `cn` / `china` | 仅明确送中 |
| `unknown` | 仅无法可靠判断 |

兼容回退：节点没有 `_googleStatus` 时，检查 `_geo` 字段里的 `www.google.cn` 历史标记判断（可与 `http-meta-geo.js` 联用）。

无论怎么过滤，它都会删除 `_geo`、`_googleStatus`、`_originServer`、`_nodeProfile`，因此**应当永远是链路的最后一个操作**。

### 可选脚本 http-meta-geo.js

Fork 自 xream 的 `http_meta_geo.js`：通过 HTTP META 经每个节点请求落地点 API，把**真实代理出口**的国家 / ISP 写进节点名，方便肉眼发现「落地与预期不符」的节点。注意它与 `node-profile-filter.js` 的 MMDB 补全描述的是不同的东西——后者查的是 DNS 解析后的服务器 IP，前者查的是代理出口。

本仓库 fork 的差异：Hysteria2 探测副本临时删除 `ports`、强制使用主 `port`，原始节点的端口跳跃配置不变。

常用参数：`api`（落地点 API）、`format`（节点名格式）、`geo=true`（附加 `_geo` 字段）、`cache=true`（启用缓存）、`internal` + `mmdb_country_path` / `mmdb_asn_path`（用 MMDB 代替外部 API）。完整参数列表见脚本头部注释。

### 进阶技巧

**同一订阅输出多个池**：`protocol-filter.js`、`node-profile-filter.js`、`google-region-check.js` 支持在下载链接上用 `$options` 按请求覆盖参数，同一条订阅 / 组合可以输出不同池，无需复制多份：

```text
https://<后端域名>/<路径标识>/download/MySub?$options=profile%3Dpremium
https://<后端域名>/<路径标识>/download/MySub?$options=filterType%3Dhy2%26profile%3Dmain
```

注意：每个 `$options` 变体在反代缓存层是**独立的缓存 key**（见下节），保热脚本需要分别覆盖；探测脚本的参数不能用 `$options` 覆盖。

## VPS 生产部署与 daed 订阅超时

### 问题：daed 硬编码 5 秒订阅超时

daed（dae-wing）更新订阅时单次尝试硬编码 5 秒超时（先直连、失败再走路由，共两次），没有任何配置项。Sub-Store「冷生产」——探测缓存过期 + HTTP META 启动延迟 + 死节点探测超时——耗时可达 5 秒以上，daed 因此报错：

```text
Get "https://<后端>/download/...": context deadline exceeded
(Client.Timeout exceeded while awaiting headers) (direct); ... (route)
```

实测同一订阅：探测缓存全命中时约 0.5 秒；缓存过期时 5~7 秒。daed 通常每 6 小时定时更新，而探测缓存 TTL 只有 15 分钟，每次定时更新都必然冷启动，极易超时。

### 三层修复

| 层 | 位置 | 方案 |
| --- | --- | --- |
| 1 | Operator | `unknown` 结果短 TTL 缓存（默认行为）+ 探测异常回退 stale 缓存，压缩冷生产耗时 |
| 2 | 反代 | openresty / Nginx `proxy_cache` + stale-while-revalidate，预热后毫秒级响应，上游慢或瞬时 5xx 不透传 |
| 3 | 保热 | cron 默认每小时刷新缓存（自愈 + 变更后换新），daed 的定时任务永远命中热缓存 |

同时建议把探测操作的 `http_meta_start_delay` 设为 `1500`（`3000` 一项就占掉 5 秒预算的 60%），并保留 `share_by_server=true`：

```text
api=https%3A%2F%2Fwww.youtube.com%2Fpremium&concurrency=5&http_meta_start_delay=1500&share_by_server=true&timeout=10000
```

### 部署 openresty 下载缓存

配置模板：[configs/openresty-substore-cache.conf](./configs/openresty-substore-cache.conf)（含逐行注释），分两段放置：

1. `proxy_cache_path` 段 → http{} 级别的 conf.d 目录（1Panel openresty：`/opt/1panel/www/conf.d/substore-cache.conf`，随 `nginx.conf` 的 http{} include 生效）；
2. `location ^~ /<路径标识>/download/` 段 → Sub-Store 站点 server{} include 的 `proxy/*.conf`（1Panel openresty：`/opt/1panel/www/sites/<域名>/proxy/download.conf`；`^~` 最长前缀匹配，优先级高于原有 `root.conf` 的 `location ^~ /`，其余路径仍走原配置）。

要点：

- 缓存目录放在随数据卷持久化的路径（模板中的 `/www/cache/substore`），容器重建后目录仍在，避免 nginx 因缺目录启动失败。
- `proxy_cache_key "$scheme$proxy_host$request_uri"`：不同 `$options` 变体各自独立缓存。
- `proxy_cache_lock on`：收拢客户端同一秒并发更新多个订阅造成的回源风暴。
- `proxy_cache_background_update` + `proxy_cache_use_stale ... updating http_500 ...`：缓存过期先回旧值再后台刷新；上游慢或瞬时 5xx 永不透传给客户端。

生效与验证：

```bash
docker exec <openresty容器名> nginx -t
docker exec <openresty容器名> nginx -s reload

# 首次 MISS（可能 5~6 秒，由反代吸收），之后 HIT ≈ 30ms
curl -sI 'https://<后端域名>/<路径标识>/download/<订阅名>' | grep -i x-cache-status
```

`X-Cache-Status` 含义：`MISS` 回源 / `HIT` 命中 / `STALE` 返回旧值、后台刷新中 / `UPDATING` 后台刷新期间收到请求 / `BYPASS` 未走缓存（检查 location 是否匹配）。

### 部署保热 cron

脚本 [configs/keepwarm.sh](./configs/keepwarm.sh) 自带 install / status / uninstall 子命令，会自我安装；个人配置（下载地址前缀、保热路径列表、缓存目录）全部放在外部 conf 文件里，脚本本身不含隐私信息、直接入库：

```bash
cd configs
cp keepwarm.example.conf keepwarm.conf  # 编辑：填入 BASE 与所有需要保热的下载路径
sh keepwarm.sh install                  # 安装脚本与 conf，写入 cron（默认 0 * * * *，每小时）
sh keepwarm.sh status                   # 查看 conf / cron 条目 / 已安装文件 / 缓存目录占用
```

`keepwarm.conf` 含真实订阅地址，已被 `.gitignore` 排除，不要提交。路径列表必须覆盖客户端定时拉取的**每一个**下载 URL（包括不同 `$options` 变体），因为缓存 key 包含完整 URI。

为什么默认每小时就够：让 daed 稳定成功的是反代的 stale-while-revalidate——条目过期但仍在 `inactive=7d` 窗口内时，nginx 立即回旧值、后台刷新。保热 cron 只负责两件事：缓存被清空/首次部署后一小时内自愈（否则冷生产 5~7 秒会让 daed 每 6 小时必败，且失败不留下任何缓存，不会自愈）；你主动变更订阅后一小时内换新缓存。对静态自管节点，每小时已覆盖这两个需求，频率硬上限是 `inactive=7d`。

#### 更新保热 URL 与 cron 频率

- **增删订阅（URL 列表）**：直接编辑已安装的 `/usr/local/etc/substore-keepwarm.conf`，下次运行即生效，无需重新安装；或改仓库 `configs/keepwarm.conf` 后执行 `sh keepwarm.sh install` 覆盖安装。`sh keepwarm.sh run` 可立即手动预热一遍验证新 URL。
- **调整频率**：`sh keepwarm.sh install '*/30 * * * *'`。install 是幂等的：总会用当前脚本与 conf 覆盖安装，并替换引用该安装路径的旧 cron 条目（表达式记得加引号，避免 `*` 被 shell 展开；脚本会校验必须是「分 时 日 月 周」5 个字段）。

#### 清理副作用（卸载）

保热的副作用共四处：crontab 条目、`/usr/local/bin/substore-keepwarm.sh`、`/usr/local/etc/substore-keepwarm.conf`、反代缓存目录中被预热的条目。

```bash
sh keepwarm.sh uninstall                # 移除 cron 条目 + 删除已安装脚本与 conf
sh keepwarm.sh uninstall --purge-cache  # 同时清空反代缓存目录（conf 里的 CACHE_DIR）
```

- `--purge-cache` 从 conf 读取 `CACHE_DIR`（宿主机路径；1Panel openresty 为 `/opt/1panel/www/cache/substore`）。直接删除缓存文件即可，nginx 无需 reload，缺失文件按 MISS 处理。
- 按旧文档手动 `cp` + `crontab -e` 安装的同样这样清理：条目按安装路径匹配，`/usr/local/bin/substore-keepwarm.sh` 的旧条目会被一并移除。
- Sub-Store 后端的探测缓存 / 规则缓存按各自 TTL 自行过期，无需（也无法从外部）清理。
- 若只想清缓存、保留保热，清完执行 `sh keepwarm.sh run` 立即重新预热，避免下次拉取冷启动。

## Troubleshooting

### daed 更新订阅报 `context deadline exceeded ... (direct); ... (route)`

daed 单次尝试硬编码 5 秒超时且不可配置。按 [VPS 生产部署](#vps-生产部署与-daed-订阅超时)一节部署三层缓存（Operator 缓存默认已生效），并把探测操作的 `http_meta_start_delay` 降到 `1500`。

### 生成的节点数比预期少，甚至为空

按概率排查：

1. **规则没匹配上**：`match.host` 与订阅里节点的 `server` 域名不一致（匹配不区分大小写，但拼写必须一致）。
2. **操作顺序错误**：① 没放在 ②（DNS 解析）之前，`server` 已变成 IP 且没有 `_originServer`，host 匹配失效。
3. **过滤条件过严**：不同过滤字段之间是 AND 关系。

处理：把 ③ 临时改成 `profile=all&metadata=true` 后预览，查看每个节点的 `_nodeProfile`；`host` 为空说明该节点没命中任何规则。

### `rulesUrl` 请求失败，订阅生成报错

脚本设计为获取失败直接报错，而不是用空规则静默继续（防止配置源故障时生成错误订阅）。检查：

- raw 地址用 curl 直接访问能返回合法 JSON；
- 地址拼接进脚本 URL 前做了 URL 编码；
- Sub-Store 后端容器能访问外网（gist / GitHub raw）。

`rulesCacheTtl`（默认 15 分钟）内有过成功缓存时，会自动降级使用 stale 缓存，并在日志记录 `rulesUrl refresh failed; using stale cache`。

### 报错 `Unknown filterType` / `Unknown googleStatus`

参数值拼写错误。`filterType` 合法值：`all` / `vless` / `reality` / `hysteria2` / `hy2`；`googleStatus` 合法值：`all` / `clean` / `ok` / `non-cn` / `cn` / `china` / `unknown`。

### 探测结果全是 `unknown`，或报 `HTTP META start failed`

- 后端镜像不带 HTTP META：换 `xream/sub-store:http-meta` 镜像，或自行部署 http-meta 服务并用 `http_meta_host` / `http_meta_port` / `http_meta_authorization` 指向它。
- 运行环境内缺 `curl` 命令。
- 看日志定位：正常应出现 `Google probe HTTP META started: pid=...` 与 `[节点名] status: ..., verdict: ...`；出现 `HTTP META proxy not ready` 说明启动等待不够，可增大 `http_meta_start_delay`（daed 5 秒预算场景除外）。

### Hysteria2 端口跳跃节点探测结果是 `unknown`

探测副本会删除 `ports`、只用主 `port` 探测（最终订阅不受影响）。若服务端只有端口跳跃范围开放、主 `port` 不可用，结果为 `unknown`，属预期行为。

### 最终订阅里出现了 `_nodeProfile`、`_originServer` 等临时字段

链路末尾的 `google-region-check.js` 会统一清理这些字段。出现说明链路不完整（比如删掉了 ⑤），或调试用的 `metadata=true` 忘记关掉。补全链路或去掉该参数。

### 缓存不生效，`X-Cache-Status` 一直是 `BYPASS`

`location` 前缀与实际下载路径不一致。核对路径标识、大小写和斜杠：`location ^~ /<路径标识>/download/` 必须是请求 URI 的前缀。

### 每次拉取都要 5~6 秒，`X-Cache-Status` 一直是 `MISS`

- 保热 cron 没装或没跑：`sh configs/keepwarm.sh status` 一键检查 cron 条目与已安装副本，或 `crontab -l` 直接看条目、手动执行脚本看报错。
- 保热脚本的 URL 列表没有覆盖该下载地址：不同 `$options` 变体是独立缓存 key，需逐个列出。
- 缓存目录不存在或无写权限：检查 nginx error log。

### 通过 `$options` 传参对探测脚本不生效

`google-region-probe.js` 只认脚本 URL `#` 后的固定参数，不支持下载链接 `$options` 覆盖；探测相关参数请直接写在操作配置里。

### 用 IP 访问面板 / 后端报 `ERR_CERT_COMMON_NAME_INVALID`

证书 SAN 只包含域名，证书本身没有问题。请用域名访问面板和订阅地址，不要用 IP。

## 仓库结构

```text
.
├── README.md
├── configs/
│   ├── README.md                        # 本目录说明
│   ├── keepwarm.sh                      # 缓存保热脚本，含 install/status/uninstall 子命令
│   ├── keepwarm.example.conf            # 保热配置模板（实际的 keepwarm.conf 不入库）
│   └── openresty-substore-cache.conf    # 反代下载缓存模板
├── examples/
│   └── node-profile-rules.example.json  # 节点档案模板（实际的 node-profile-rules.json 不入库）
└── operators/
    ├── protocol-filter.js
    ├── node-profile-filter.js
    ├── google-region-probe.js
    ├── google-region-check.js
    └── http-meta-geo.js
```

## 维护原则

- Operator 源码不包含任何个人节点、供应商或线路 built-in 信息。
- 不通过 RTT 推断中国方向线路质量。
- 不通过 Country / ASN 自动推断「中国优化」。
- `profile` 是显式业务标签，不由 `route` / `traffic` 自动推导。
- 未确认的线路属性保持未知。
- 动态探测保留明确的 `unknown` 状态。
- 临时元数据在最终订阅输出前清理。
