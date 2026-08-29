# 节点档案与部署配置（中文为主维护）

本目录包含两部分：

1. `node-profile-rules.json` —— 部署专属节点元数据，供 `operators/node-profile-filter.js` 通过 `rulesUrl` 加载。
2. VPS 生产部署配置（openresty 下载缓存 + 保热脚本），完整部署实录见 [README.zh-CN.md](../README.zh-CN.md) 的「VPS 部署与 daed 订阅超时」一节。

## daed 订阅更新 5 秒限制

daed（dae-wing）更新订阅时**单次尝试硬编码 5 秒超时**——先直连、失败再走路由——没有任何配置项
（dae-wing 源码 `graphql/service/subscription/mutation_utils.go`：`timeout := 10 * time.Second`
拆成两次 5 秒尝试）。Sub-Store 下载超过 5 秒即报：

```text
Get "https://substore.../download/collection/MySub?...": context deadline exceeded
(Client.Timeout exceeded while awaiting headers) (direct); ... (route)
```

实测 `collection/MySub` 生产耗时从 ~0.5s（探测缓存命中）到 6s+（探测缓存过期 +
`http_meta_start_delay=3000` + 死节点探测超时）波动，daed 的 6 小时定时任务每次都是冷启动，
极易超时。三层修复：

1. **Operator 探测缓存**（本仓库）：`probe_budget`（默认 8s）约束单组探测总时长，
   `share_by_server=true` 合并同服务器节点，`unknown` 结果按 `unknown_cache_ttl`
   （默认 10 分钟）缓存——死节点不再每次生产都付出完整探测超时；探测异常回退最近一次
   任意类型的缓存结果。
2. **openresty 反代缓存**（VPS）：`openresty-substore-cache.conf`，预热后所有下载毫秒级响应
   （stale-while-revalidate），上游慢或瞬时 500 不再传导给 daed。
3. **保热 cron**（VPS）：`keepwarm.sh` 每 5 分钟刷新，daed 定时任务永远命中热缓存：

```bash
cp keepwarm.sh /usr/local/bin/substore-keepwarm.sh && chmod +x /usr/local/bin/substore-keepwarm.sh
( crontab -l; echo '*/5 * * * * /usr/local/bin/substore-keepwarm.sh >/dev/null 2>&1' ) | crontab -
```

Sub-Store 中 `google-region-probe.js` 的推荐参数（当前 `http_meta_start_delay=3000`
一项就占掉 5s 预算的 60%；`share_by_server=true` 值得保留——同 VPS 多入站共享出站）：

```text
api=https%3A%2F%2Fwww.youtube.com%2Fpremium&concurrency=5&http_meta_start_delay=1500&share_by_server=true&timeout=10000
```

## 当前节点档案

| Provider | Host | Route | Traffic | Profile | Region | City |
| --- | --- | --- | --- | --- | --- | --- |
| bwh | `bwh.example.com` | optimized | low | premium | US | LA |
| nosla | `nosla.example.com` | optimized | high | main | DE | FRA |
| lightlayer | `lightlayer.example.com` | optimized | medium | main | US | SJC |
| bitsflow | `bitsflow.example.com` | standard | medium | backup | JP | TYO |

配置文件（`rulesUrl` 指向）：

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/configs/node-profile-rules.json
```

## 工作方式

`node-profile-rules.json` 定义节点元数据，operator 再按元数据过滤：

```text
rulesUrl -> 节点分类 -> 过滤 -> urltest/负载均衡
```

`profile`、`route`、`traffic`、`region`、`city`、`provider`、`asn`、`host` 是相互独立的过滤维度。

示例：

```text
profile=main
profile=premium
profile=backup
route=optimized
region=US
city=SJC
route=optimized&region=US
```

同一过滤维度内逗号分隔为 OR；不同维度之间为 AND。

## 可直接复制的 Sub-Store 脚本 URL

rulesUrl（已编码）：

```text
https%3A%2F%2Fraw.githubusercontent.com%2Fblooddrunk%2Fsubstore-operators%2Fmain%2Fconfigs%2Fnode-profile-rules.json
```

### main 池

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/node-profile-filter.js#rulesUrl=https%3A%2F%2Fraw.githubusercontent.com%2Fblooddrunk%2Fsubstore-operators%2Fmain%2Fconfigs%2Fnode-profile-rules.json&profile=main
```

### premium 池

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/node-profile-filter.js#rulesUrl=https%3A%2F%2Fraw.githubusercontent.com%2Fblooddrunk%2Fsubstore-operators%2Fmain%2Fconfigs%2Fnode-profile-rules.json&profile=premium
```

### backup 池

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/node-profile-filter.js#rulesUrl=https%3A%2F%2Fraw.githubusercontent.com%2Fblooddrunk%2Fsubstore-operators%2Fmain%2Fconfigs%2Fnode-profile-rules.json&profile=backup
```

### 全部 optimized 线路

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/node-profile-filter.js#rulesUrl=https%3A%2F%2Fraw.githubusercontent.com%2Fblooddrunk%2Fsubstore-operators%2Fmain%2Fconfigs%2Fnode-profile-rules.json&route=optimized
```

### US optimized 线路

```text
https://raw.githubusercontent.com/blooddrunk/substore-operators/main/operators/node-profile-filter.js#rulesUrl=https%3A%2F%2Fraw.githubusercontent.com%2Fblooddrunk%2Fsubstore-operators%2Fmain%2Fconfigs%2Fnode-profile-rules.json&route=optimized&region=US
```
