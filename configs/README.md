# configs 目录说明

本目录存放 VPS 部署配置模板。含个人信息的实际部署文件不入库（见根目录 `.gitignore`）。

## 文件清单

| 文件 | 用途 |
| --- | --- |
| `openresty-substore-cache.conf` | Sub-Store 前置 openresty / Nginx 下载缓存模板，解决 daed 5 秒订阅更新超时。部署步骤见[主 README「VPS 生产部署与 daed 订阅超时」](../README.md#vps-生产部署与-daed-订阅超时)一节 |
| `keepwarm.example.sh` | 缓存保热 cron 脚本模板。复制为 `keepwarm.sh` 并填入自己的前端路径与订阅下载路径（填写后的文件已 gitignore，不入库） |

## 节点档案在哪

`node-profile-rules.json` 含个人节点信息，不入库（已 gitignore）。模板见
[examples/node-profile-rules.example.json](../examples/node-profile-rules.example.json)，
托管方式（secret gist raw）与 `rulesUrl` 用法见
[主 README「node-profile-filter.js」](../README.md#node-profile-filterjs)一节。
