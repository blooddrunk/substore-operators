/**
 * Forked from xream/scripts:
 * https://github.com/xream/scripts/blob/main/surge/modules/sub-store-scripts/check/http_meta_geo.js
 *
 * Local modification:
 * - For Hysteria2 probes only, remove `ports` from the temporary proxy copy before
 *   converting it to ClashMeta. This keeps the original subscription node unchanged
 *   while forcing HTTP META to probe the node through its primary `port`.
 */

async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore
  const cacheEnabled = $arguments.cache
  const cache = scriptResourceCache
  const disableFailedCache = $arguments.disable_failed_cache || $arguments.ignore_failed_error
  const remove_failed = $arguments.remove_failed
  const remove_incompatible = $arguments.remove_incompatible
  const incompatibleEnabled = $arguments.incompatible
  const includeUnsupportedProxy = $arguments.include_unsupported_proxy
  const geoEnabled = $arguments.geo
  const http_meta_host = $arguments.http_meta_host ?? '127.0.0.1'
  const http_meta_port = $arguments.http_meta_port ?? 9876
  const http_meta_protocol = $arguments.http_meta_protocol ?? 'http'
  const http_meta_authorization = $arguments.http_meta_authorization ?? ''
  const http_meta_api = `${http_meta_protocol}://${http_meta_host}:${http_meta_port}`
  const http_meta_start_delay = parseFloat($arguments.http_meta_start_delay ?? 3000)
  const http_meta_proxy_timeout = parseFloat($arguments.http_meta_proxy_timeout ?? 10000)
  const method = $arguments.method || 'get'

  const internal = $arguments.internal
  const mmdb_country_path = $arguments.mmdb_country_path
  const mmdb_asn_path = $arguments.mmdb_asn_path
  const regex = $arguments.regex
  let format = $arguments.format || '{{api.country}} {{api.isp}} - {{proxy.name}}'
  let url = $arguments.api || 'http://ip-api.com/json?lang=zh-CN'
  let utils
  if (internal) {
    utils = new ProxyUtils.MMDB({ country: mmdb_country_path, asn: mmdb_asn_path })
    $.info(
      `[MMDB] GeoLite2 Country 数据库文件路径: ${mmdb_country_path || eval('process.env.SUB_STORE_MMDB_COUNTRY_PATH')}`
    )
    $.info(`[MMDB] GeoLite2 ASN 数据库文件路径: ${mmdb_asn_path || eval('process.env.SUB_STORE_MMDB_ASN_PATH')}`)
    format = $arguments.format || `{{api.countryCode}} {{api.aso}} - {{proxy.name}}`
    url = $arguments.api || 'http://checkip.amazonaws.com'
  }

  const internalProxies = []
  proxies.map((proxy, index) => {
    try {
      // Probe-only copy: keep the original node untouched.
      const probeProxy = { ...proxy }

      // Hysteria2 port hopping is part of the real subscription, but for HTTP META
      // probing we intentionally force the primary port. This removes `ports` only
      // from the temporary copy that is sent to Mihomo.
      if (String(probeProxy.type || '').toLowerCase() === 'hysteria2' && probeProxy.ports) {
        delete probeProxy.ports
      }

      const node = ProxyUtils.produce([probeProxy], 'ClashMeta', 'internal', {
        'include-unsupported-proxy': includeUnsupportedProxy,
      })?.[0]
      if (node) {
        for (const key in proxy) {
          if (/^_/i.test(key)) {
            node[key] = proxy[key]
          }
        }
        internalProxies.push({ ...node, _proxies_index: index })
      } else {
        proxies[index]._incompatible = true
      }
    } catch (e) {
      $.error(e)
    }
  })
  $.info(`核心支持节点数: ${internalProxies.length}/${proxies.length}`)
  if (!internalProxies.length) return proxies

  if (cacheEnabled) {
    try {
      let allCached = true
      for (var i = 0; i < internalProxies.length; i++) {
        const proxy = internalProxies[i]
        const id = getCacheId({ proxy, url, format, regex })
        const cached = cache.get(id)
        if (cached) {
          if (cached.api) {
            proxies[proxy._proxies_index].name = formatter({
              proxy: proxies[proxy._proxies_index],
              api: cached.api,
              format,
              regex,
            })
            proxies[proxy._proxies_index]._geo = cached.api
          } else {
            if (disableFailedCache) {
              allCached = false
              break
            }
          }
        } else {
          allCached = false
          break
        }
      }
      if (allCached) {
        $.info('所有节点都有有效缓存 完成')
        return proxies
      }
    } catch (e) {}
  }

  const http_meta_timeout = http_meta_start_delay + internalProxies.length * http_meta_proxy_timeout

  let http_meta_pid
  let http_meta_ports = []

  const res = await http({
    retries: 0,
    method: 'post',
    url: `${http_meta_api}/start`,
    headers: {
      'Content-type': 'application/json',
      Authorization: http_meta_authorization,
    },
    body: JSON.stringify({
      proxies: internalProxies,
      timeout: http_meta_timeout,
    }),
  })
  let body = res.body
  try {
    body = JSON.parse(body)
  } catch (e) {}
  const { ports, pid } = body
  if (!pid || !ports) {
    throw new Error(`======== HTTP META 启动失败 ====\n${body}`)
  }
  http_meta_pid = pid
  http_meta_ports = ports
  $.info(
    `\n======== HTTP META 启动 ====\n[端口] ${ports}\n[PID] ${pid}\n[超时] 若未手动关闭 ${
      Math.round(http_meta_timeout / 60 / 10) / 100
    } 分钟后自动关闭\n`
  )
  $.info(`等待 ${http_meta_start_delay / 1000} 秒后开始检测`)
  await $.wait(http_meta_start_delay)

  const concurrency = parseInt($arguments.concurrency || 10)
  await executeAsyncTasks(
    internalProxies.map(proxy => () => check(proxy)),
    { concurrency }
  )

  try {
    const res = await http({
      method: 'post',
      url: `${http_meta_api}/stop`,
      headers: {
        'Content-type': 'application/json',
        Authorization: http_meta_authorization,
      },
      body: JSON.stringify({
        pid: [http_meta_pid],
      }),
    })
    $.info(`\n======== HTTP META 关闭 ====\n${JSON.stringify(res, null, 2)}`)
  } catch (e) {
    $.error(e)
  }

  if (remove_incompatible || remove_failed) {
    proxies = proxies.filter(p => {
      if (remove_incompatible && p._incompatible) {
        return false
      } else if (remove_failed && !p._geo) {
        return !remove_incompatible && p._incompatible
      }
      return true
    })
  }

  if (!geoEnabled || !incompatibleEnabled) {
    proxies = proxies.map(p => {
      if (!geoEnabled) {
        delete p._geo
      }
      if (!incompatibleEnabled) {
        delete p._incompatible
      }
      return p
    })
  }

  return proxies

  async function check(proxy) {
    const id = cacheEnabled ? getCacheId({ proxy, url, format, regex }) : undefined
    try {
      const cached = cache.get(id)
      if (cacheEnabled && cached) {
        if (cached.api) {
          $.info(`[${proxy.name}] 使用成功缓存`)
          $.log(`[${proxy.name}] api: ${JSON.stringify(cached.api, null, 2)}`)
          proxies[proxy._proxies_index].name = formatter({
            proxy: proxies[proxy._proxies_index],
            api: cached.api,
            format,
            regex,
          })
          if (geoEnabled) proxies[proxy._proxies_index]._geo = cached.api
          return
        } else {
          if (disableFailedCache) {
            $.info(`[${proxy.name}] 不使用失败缓存`)
          } else {
            $.info(`[${proxy.name}] 使用失败缓存`)
            return
          }
        }
      }

      const index = internalProxies.indexOf(proxy)
      const startedAt = Date.now()

      const res = await http({
        proxy: `http://${http_meta_host}:${http_meta_ports[index]}`,
        method,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1',
        },
        url,
      })
      let api = String(lodash_get(res, 'body'))
      const status = parseInt(res.status || res.statusCode || 200)
      let latency = `${Date.now() - startedAt}`
      $.info(`[${proxy.name}] status: ${status}, latency: ${latency}`)
      if (internal) {
        const ip = api.trim()
        api = {
          countryCode: utils.geoip(ip) || '',
          aso: utils.ipaso(ip) || '',
          asn: (utils.ipasn ? utils.ipasn(ip) : '') || '',
        }
      } else {
        try {
          api = JSON.parse(api)
        } catch (e) {}
      }

      if (status == 200) {
        proxies[proxy._proxies_index].name = formatter({ proxy: proxies[proxy._proxies_index], api, format, regex })
        proxies[proxy._proxies_index]._geo = api
        if (cacheEnabled) {
          $.info(`[${proxy.name}] 设置成功缓存`)
          cache.set(id, { api })
        }
      } else {
        if (cacheEnabled) {
          $.info(`[${proxy.name}] 设置失败缓存`)
          cache.set(id, {})
        }
      }

      $.log(`[${proxy.name}] api: ${JSON.stringify(api, null, 2)}`)
    } catch (e) {
      $.error(`[${proxy.name}] ${e.message ?? e}`)
      if (cacheEnabled) {
        $.info(`[${proxy.name}] 设置失败缓存`)
        cache.set(id, {})
      }
    }
  }

  async function http(opt = {}) {
    const METHOD = opt.method || $arguments.method || 'get'
    const TIMEOUT = parseFloat(opt.timeout || $arguments.timeout || 5000)
    const RETRIES = parseFloat(opt.retries ?? $arguments.retries ?? 1)
    const RETRY_DELAY = parseFloat(opt.retry_delay ?? $arguments.retry_delay ?? 1000)

    let count = 0
    const fn = async () => {
      try {
        return await $.http[METHOD]({ ...opt, timeout: TIMEOUT })
      } catch (e) {
        if (count < RETRIES) {
          count++
          const delay = RETRY_DELAY * count
          await $.wait(delay)
          return await fn()
        } else {
          throw e
        }
      }
    }
    return await fn()
  }

  function lodash_get(obj, path, defaultValue) {
    const keys = Array.isArray(path)
      ? path
      : String(path)
          .replace(/\[(\d+)\]/g, '.$1')
          .replace(/^\./, '')
          .split('.')
    let result = obj
    for (const key of keys) {
      if (result == null || !(key in Object(result))) return defaultValue
      result = result[key]
    }
    return result === undefined ? defaultValue : result
  }

  function formatter({ proxy, api, format, regex }) {
    let apiData = api
    if (regex) {
      apiData = {}
      const rules = String(regex).split(';')
      for (const rule of rules) {
        const index = rule.indexOf(':')
        if (index <= 0) continue
        const key = rule.slice(0, index)
        const pattern = rule.slice(index + 1)
        try {
          const match = String(api).match(new RegExp(pattern))
          apiData[key] = match?.[1] ?? match?.[0] ?? ''
        } catch (e) {
          apiData[key] = ''
        }
      }
    }

    return String(format).replace(/{{\s*([^{}]+?)\s*}}/g, (_, expression) => {
      const [scope, ...rest] = expression.trim().split('.')
      const keyPath = rest.join('.')
      if (scope === 'proxy') return lodash_get(proxy, keyPath, '')
      if (scope === 'api') return lodash_get(apiData, keyPath, '')
      return ''
    })
  }

  function getCacheId({ proxy, url, format, regex }) {
    return JSON.stringify({
      proxy,
      url,
      format,
      regex,
    })
  }

  async function executeAsyncTasks(tasks = [], options = {}) {
    const concurrency = Math.max(1, parseInt(options.concurrency || 1))
    let cursor = 0

    const worker = async () => {
      while (cursor < tasks.length) {
        const index = cursor++
        await tasks[index]()
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()))
  }
}
