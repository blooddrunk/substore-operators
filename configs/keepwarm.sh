#!/bin/sh
# Sub-Store 下载缓存保热脚本（个人配置在外部 conf 里，脚本本身可入库）
#
# 背景：daed 每 6 小时更新订阅、单次尝试硬编码 5 秒超时；openresty 用
# proxy_cache 缓存 /download/（见 openresty-substore-cache.conf）。本脚本定时
# 刷新每个下载地址，作用有二：缓存被清空后自愈，主动变更订阅后及时换新。
#
# 为什么默认每小时即可：让 daed 稳定成功的是反代 stale-while-revalidate——
# 条目过期但仍在 inactive 窗口内时，nginx 立即回旧值、后台刷新；保热 cron
# 只负责自愈与换新，频率硬上限是缓存 inactive=7d。
#
# conf 文件（BASE= / CACHE_DIR= / 每行一个保热路径，模板 keepwarm.example.conf）
# 按以下顺序解析：
#   1. 环境变量 KEEPWARM_CONF 指定的路径
#   2. 脚本同目录下的 keepwarm.conf（仓库内手动运行时生效）
#   3. /usr/local/etc/substore-keepwarm.conf（install 安装位置，cron 用）
#
# 子命令（在 configs/ 目录下执行；脚本会自我安装，无需手动 cp / crontab -e）：
#   sh keepwarm.sh                            立即保热一次（cron 调用时的默认行为）
#   sh keepwarm.sh install [cron表达式]       安装/更新：复制脚本与 conf 到安装位置，
#                                             写入（或替换）cron 条目，缺省 0 * * * *
#   sh keepwarm.sh status                     查看 conf / cron 条目 / 已安装文件 / 缓存目录
#   sh keepwarm.sh uninstall [--purge-cache]  清理副作用：cron 条目 + 已安装文件；
#                                             --purge-cache 同时清空反代缓存目录
#
# 更新保热 URL：直接编辑已安装的 conf，下次运行即生效；或改仓库 conf 后重新
# install 覆盖。更新 cron 频率：install '*/30 * * * *'（幂等替换旧条目）。

INSTALL_PATH="/usr/local/bin/substore-keepwarm.sh"
CONF_PATH="/usr/local/etc/substore-keepwarm.conf"
CRON_EXPR="0 * * * *"

die() { echo "错误：$*" >&2; exit 1; }

SCRIPT_DIR=$(dirname -- "$0")
if [ -n "${KEEPWARM_CONF:-}" ]; then
  CONF="$KEEPWARM_CONF"
elif [ -f "$SCRIPT_DIR/keepwarm.conf" ]; then
  CONF="$SCRIPT_DIR/keepwarm.conf"
else
  CONF="$CONF_PATH"
fi

CR=$(printf '\r')

# 读取 conf：BASE= 下载地址前缀；CACHE_DIR= 反代缓存目录（可选）；其余非注释
# 行均为保热路径（相对 BASE；以 http(s):// 开头的行按完整 URL 处理）。
load_conf() {
  BASE=""; CACHE_DIR=""; URLS=""; CONF_ERR=""
  if [ ! -f "$CONF" ]; then
    CONF_ERR="找不到配置文件 $CONF（从 keepwarm.example.conf 复制一份，或用 KEEPWARM_CONF 指定路径）"
    return 0
  fi
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%"$CR"}
    case "$line" in
      ''|'#'*) continue ;;
      BASE=*) BASE=${line#BASE=} ;;
      CACHE_DIR=*) CACHE_DIR=${line#CACHE_DIR=} ;;
      *) URLS="$URLS$line
" ;;
    esac
  done < "$CONF"
}

check_config() {
  load_conf
  [ -z "$CONF_ERR" ] || die "$CONF_ERR"
  case "$BASE" in
    '') die "conf 里缺少 BASE=（下载地址前缀）" ;;
    *example.com*|*PATH_TOKEN*) die "BASE 仍是模板占位值，请填入真实下载地址前缀" ;;
  esac
  [ -n "$URLS" ] || die "conf 里没有列出任何保热路径"
}

warm() {
  check_config
  # heredoc 让循环在当前 shell 执行，末尾的 wait 才等得到后台 curl
  while IFS= read -r u; do
    [ -n "$u" ] || continue
    case "$u" in
      http://*|https://*)
        curl -fsS -o /dev/null --max-time 120 "$u" 2>/dev/null & ;;
      *)
        curl -fsS -o /dev/null --max-time 120 "$BASE/$u" 2>/dev/null & ;;
    esac
  done <<EOF
$URLS
EOF
  wait
}

do_install() {
  [ -n "$1" ] && CRON_EXPR="$1"
  # crontab 为五字段：分 时 日 月 周；拦下六字段（含秒）或误粘贴的其他内容
  [ "$(printf '%s\n' "$CRON_EXPR" | wc -w)" -eq 5 ] ||
    die "cron 表达式应为 5 个字段（分 时 日 月 周），收到：$CRON_EXPR"
  check_config
  if [ "$0" != "$INSTALL_PATH" ]; then
    cp -- "$0" "$INSTALL_PATH" || die "复制脚本到 $INSTALL_PATH 失败（权限不足时加 sudo）"
    chmod +x "$INSTALL_PATH"
  fi
  if [ "$CONF" != "$CONF_PATH" ]; then
    mkdir -p -- "$(dirname -- "$CONF_PATH")" \
      || die "创建 $(dirname -- "$CONF_PATH") 失败"
    cp -- "$CONF" "$CONF_PATH" || die "复制配置到 $CONF_PATH 失败"
  fi
  # 幂等：先移除引用 INSTALL_PATH 的旧条目再写入新条目，其他条目保留
  crontab -l 2>/dev/null | grep -v -F "$INSTALL_PATH" \
    | { cat; echo "$CRON_EXPR $INSTALL_PATH >/dev/null 2>&1"; } | crontab - \
    || die "写入 crontab 失败"
  echo "已安装：$INSTALL_PATH + $CONF_PATH，当前 cron 条目："
  crontab -l | grep -F "$INSTALL_PATH"
}

do_status() {
  load_conf
  echo "== conf（$CONF）=="
  if [ -n "$CONF_ERR" ]; then
    echo "$CONF_ERR"
  else
    echo "BASE=$BASE"
    echo "保热路径 $(printf '%s' "$URLS" | grep -c .) 个"
    [ -n "$CACHE_DIR" ] && echo "CACHE_DIR=$CACHE_DIR"
  fi
  echo "== cron 条目 =="
  crontab -l 2>/dev/null | grep -F "$INSTALL_PATH" || echo "（未写入）"
  echo "== 已安装文件 =="
  if [ -f "$INSTALL_PATH" ]; then ls -l "$INSTALL_PATH"; else echo "$INSTALL_PATH（未安装）"; fi
  if [ -f "$CONF_PATH" ]; then ls -l "$CONF_PATH"; else echo "$CONF_PATH（未安装）"; fi
  echo "== 反代缓存目录 =="
  if [ -z "$CACHE_DIR" ]; then
    echo "（conf 未配置 CACHE_DIR）"
  elif [ -d "$CACHE_DIR" ]; then
    du -sh "$CACHE_DIR" 2>/dev/null
  else
    echo "$CACHE_DIR（不存在）"
  fi
}

do_uninstall() {
  if crontab -l 2>/dev/null | grep -q -F "$INSTALL_PATH"; then
    crontab -l 2>/dev/null | grep -v -F "$INSTALL_PATH" | crontab -
    echo "已移除 cron 条目"
  else
    echo "crontab 中没有本脚本的条目，跳过"
  fi
  for f in "$INSTALL_PATH" "$CONF_PATH"; do
    if [ -f "$f" ]; then
      rm -f -- "$f" && echo "已删除 $f"
    else
      echo "$f 不存在，跳过"
    fi
  done
  if [ "$1" = "--purge-cache" ]; then
    load_conf
    if [ -n "$CACHE_DIR" ] && [ -d "$CACHE_DIR" ]; then
      # ${CACHE_DIR:?} 保证变量非空，避免误删 /*
      rm -rf -- "${CACHE_DIR:?}"/* 2>/dev/null
      echo "已清空 $CACHE_DIR（直接删缓存文件即可，nginx 无需 reload）"
    else
      echo "conf 未配置 CACHE_DIR 或目录不存在，跳过缓存清理；也可手动清空缓存目录"
    fi
  fi
  echo "完成。Sub-Store 后端的探测/规则缓存按各自 TTL 自行过期，无需清理。"
}

usage() {
  cat <<'EOF'
用法：sh keepwarm.sh [命令]
  （无命令）/ run              立即保热一次（cron 调用时的默认行为）
  install [cron表达式]         安装/更新脚本与 conf，写入 cron 条目（默认 0 * * * *）
  status                       查看 conf / cron 条目 / 已安装文件 / 缓存目录
  uninstall [--purge-cache]    清理副作用（--purge-cache 同时清空反代缓存目录）
配置文件查找顺序：KEEPWARM_CONF 环境变量 → 脚本同目录 keepwarm.conf →
/usr/local/etc/substore-keepwarm.conf
EOF
}

case "${1:-run}" in
  run)       warm ;;
  install)   shift; do_install "$@" ;;
  status)    do_status ;;
  uninstall) shift; do_uninstall "$@" ;;
  -h|--help|help) usage ;;
  *) usage >&2; exit 1 ;;
esac
