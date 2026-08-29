/**
 * Probe Google/YouTube region behavior through proxies using HTTP META.
 *
 * Specialized for the Google "送中" check:
 * - 2xx body containing www.google.cn => cn.
 * - Other successful 2xx responses => clean.
 * - YouTube/Google consent redirect with an explicit non-CN `gl` => clean.
 * - Redirect to google.cn, or consent with gl=CN => cn.
 * - Other failures / redirects => unknown.
 *
 * Successful `clean` / `cn` results are cached in Sub-Store storage. Fresh
 * cache entries skip HTTP META entirely. `unknown` is never cached.
 *
 * Optional `share_by_server=true` treats nodes on the same resolved server as
 * one Google egress identity. This is useful when Reality/Hysteria2 inbounds on
 * the same VPS share the same outbound path. Leave it disabled if different
 * inbounds on one server can use different egress routes.
 */

async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore

  if (!Array.isArray(proxies)) {
    throw new TypeError('Expected proxies to be an array')
  }

  const httpMetaHost = $arguments.http_meta_host ?? '127.0.0.1'
  const httpMetaPort = $arguments.http_meta_port ?? 9876
  const httpMetaProtocol = $arguments.http_meta_protocol ?? 'http'
  const httpMetaAuthorization = $arguments.http_meta_authorization ?? ''
  const httpMetaApi = `${httpMetaProtocol}://${httpMetaHost}:${httpMetaPort}`
  const startDelay = parseFloat($arguments.http_meta_start_delay ?? 1500)
  const startRetryDelay = parseFloat($arguments.http_meta_start_retry_delay ?? 1500)
  const proxyTimeout = parseFloat($arguments.http_meta_proxy_timeout ?? 10000)
  const requestTimeout = parseFloat($arguments.timeout ?? 10000)
  const concurrency = Math.max(1, parseInt($arguments.concurrency || 10))
  const cacheTtl = Math.max(0, parseFloat($arguments.cache_ttl ?? 900000))
  const shareByServer = /^(1|true|yes|on)$/i.test(String($arguments.share_by_server ?? 'false'))
  const includeUnsupportedProxy = $arguments.include_unsupported_proxy
  const url = $arguments.api || 'https://www.youtube.com/premium'

  const groups = new Map()

  proxies.forEach((proxy, index) => {
    const key = probeCacheKey(proxy, url, shareByServer)
    const existing = groups.get(key)

    if (existing) {
      existing.indexes.push(index)
      return
    }

    groups.set(key, {
      indexes: [index],
      cached: readProbeCache(proxy, url, shareByServer),
    })
  })

  if (shareByServer && groups.size < proxies.length) {
    $.info(`Google probe shared by server: ${groups.size} groups / ${proxies.length} nodes`)
  }

  const internalProxies = []
  let cacheHits = 0

  for (const group of groups.values()) {
    const { indexes, cached } = group

    if (cached && cacheTtl > 0 && Date.now() - cached.time <= cacheTtl) {
      for (const index of indexes) {
        applyProbeResult(proxies[index], cached.result)
      }
      cacheHits += indexes.length
      continue
    }

    let internalNode
    let representativeIndex

    for (const index of indexes) {
      const proxy = proxies[index]

      try {
        const probeProxy = { ...proxy }

        // Probe through the primary Hysteria2 port only. The original node keeps
        // its port-hopping `ports` value for normal subscription use.
        if (String(probeProxy.type || '').trim().toLowerCase() === 'hysteria2') {
          delete probeProxy.ports
        }

        const node = ProxyUtils.produce([probeProxy], 'ClashMeta', 'internal', {
          'include-unsupported-proxy': includeUnsupportedProxy,
        })?.[0]

        if (node) {
          internalNode = node
          representativeIndex = index
          break
        }
      } catch (e) {
        $.error(`[${proxy?.name || index}] ${e.message ?? e}`)
      }
    }

    if (internalNode) {
      internalProxies.push({
        ...internalNode,
        _proxies_indexes: indexes,
        _representative_index: representativeIndex,
        _stale_google_cache: cached,
      })
    }
  }

  if (cacheHits) {
    $.info(`Google probe cache hit: ${cacheHits}/${proxies.length}`)
  }

  $.info(`Google probe 核心支持组数: ${internalProxies.length}/${groups.size}`)
  if (!internalProxies.length) return proxies

  const httpMetaTimeout = startDelay + startRetryDelay + internalProxies.length * proxyTimeout
  let httpMetaPid
  let httpMetaPorts = []

  try {
    const startRes = await $.http.post({
      url: `${httpMetaApi}/start`,
      timeout: requestTimeout,
      headers: {
        'Content-Type': 'application/json',
        Authorization: httpMetaAuthorization,
      },
      body: JSON.stringify({
        proxies: internalProxies.map(
          ({ _proxies_indexes, _representative_index, _stale_google_cache, ...proxy }) => proxy
        ),
        timeout: httpMetaTimeout,
      }),
    })

    let body = startRes.body
    try {
      body = JSON.parse(body)
    } catch (_) {}

    const { ports, pid } = body || {}
    if (!pid || !Array.isArray(ports)) {
      throw new Error(`HTTP META start failed: ${JSON.stringify(body)}`)
    }

    httpMetaPid = pid
    httpMetaPorts = ports

    $.info(`Google probe HTTP META started: pid=${pid}, ports=${ports.join(',')}`)
    await $.wait(startDelay)

    await executeAsyncTasks(
      internalProxies.map((proxy, index) => () => check(proxy, index)),
      concurrency
    )
  } finally {
    if (httpMetaPid) {
      try {
        await $.http.post({
          url: `${httpMetaApi}/stop`,
          timeout: requestTimeout,
          headers: {
            'Content-Type': 'application/json',
            Authorization: httpMetaAuthorization,
          },
          body: JSON.stringify({ pid: [httpMetaPid] }),
        })
      } catch (e) {
        $.error(`HTTP META stop failed: ${e.message ?? e}`)
      }
    }
  }

  return proxies

  async function check(proxy, internalIndex) {
    const indexes = proxy._proxies_indexes
    const representativeIndex = proxy._representative_index
    const representative = proxies[representativeIndex]
    const staleCache = proxy._stale_google_cache
    const name = representative?.name || proxy.name || String(representativeIndex)
    const sharedSuffix = indexes.length > 1 ? ` (+${indexes.length - 1} same-server node)` : ''
    const startedAt = Date.now()

    try {
      let result

      try {
        result = await probeViaHttpMeta({
          proxyHost: httpMetaHost,
          proxyPort: httpMetaPorts[internalIndex],
          url,
          timeout: requestTimeout,
        })
      } catch (e) {
        if (!isLocalProxyStartupError(e) || startRetryDelay <= 0) throw e

        $.info(`[${name}] HTTP META proxy not ready, retrying in ${startRetryDelay}ms`)
        await $.wait(startRetryDelay)

        result = await probeViaHttpMeta({
          proxyHost: httpMetaHost,
          proxyPort: httpMetaPorts[internalIndex],
          url,
          timeout: requestTimeout,
        })
      }

      const latency = Date.now() - startedAt

      for (const index of indexes) {
        applyProbeResult(proxies[index], result)
      }

      if (cacheTtl > 0 && (result.kind === 'clean' || result.kind === 'cn')) {
        writeProbeCache(representative, url, result, shareByServer)
      }

      if (result.kind === 'clean' && result.region) {
        $.info(
          `[${name}] status: ${result.statusCode}, verdict: clean, consent-region: ${result.region}, latency: ${latency}${sharedSuffix}`
        )
        return
      }

      $.info(
        `[${name}] status: ${result.statusCode}, verdict: ${result.kind}, latency: ${latency}${sharedSuffix}`
      )
    } catch (e) {
      if (
        staleCache?.result &&
        (staleCache.result.kind === 'clean' || staleCache.result.kind === 'cn')
      ) {
        for (const index of indexes) {
          applyProbeResult(proxies[index], staleCache.result)
        }
        $.error(`[${name}] probe failed; using stale cache: ${e.message ?? e}`)
        return
      }

      for (const index of indexes) {
        proxies[index]._googleStatus = 'unknown'
      }
      $.error(`[${name}] ${e.message ?? e}`)
    }
  }
}

function probeCacheKey(proxy, url, shareByServer = false) {
  const identity = shareByServer
    ? [
        'server',
        String(proxy?.server ?? '').trim().toLowerCase(),
        String(url ?? '').trim(),
      ]
    : [
        'node',
        String(proxy?.type ?? '').trim().toLowerCase(),
        String(proxy?.name ?? '').trim(),
        String(proxy?.server ?? '').trim().toLowerCase(),
        String(proxy?.port ?? '').trim(),
        String(proxy?.sni ?? proxy?.servername ?? '').trim().toLowerCase(),
        String(url ?? '').trim(),
      ]

  return `#google-region-probe:${encodeURIComponent(identity.join('|'))}`
}

function readProbeCache(proxy, url, shareByServer = false) {
  if (typeof $substore?.read !== 'function') return null

  try {
    const raw = $substore.read(probeCacheKey(proxy, url, shareByServer))
    if (!raw) return null

    const cached = JSON.parse(raw)
    if (!cached || !Number.isFinite(Number(cached.time)) || !cached.result) {
      return null
    }

    return {
      time: Number(cached.time),
      result: cached.result,
    }
  } catch (_) {
    return null
  }
}

function writeProbeCache(proxy, url, result, shareByServer = false) {
  if (typeof $substore?.write !== 'function') return

  try {
    $substore.write(
      JSON.stringify({
        time: Date.now(),
        result: {
          kind: result.kind,
          statusCode: result.statusCode,
          region: result.region,
          body: result.body,
        },
      }),
      probeCacheKey(proxy, url, shareByServer)
    )
  } catch (_) {}
}

function applyProbeResult(proxy, result) {
  proxy._googleStatus = result.kind

  if (result.body !== undefined) {
    proxy._geo = result.body
  } else {
    delete proxy._geo
  }
}

function isLocalProxyStartupError(error) {
  const message = String(error?.message ?? error ?? '')
  return /(?:failed|could not|couldn't) connect to .*127\.0\.0\.1|connection refused/i.test(message)
}

async function probeViaHttpMeta({ proxyHost, proxyPort, url, timeout }) {
  let currentUrl = url

  for (let i = 0; i < 4; i++) {
    const response = await curlOnce({
      proxyHost,
      proxyPort,
      url: currentUrl,
      timeout,
    })

    const { statusCode, redirectUrl, body } = response

    if (statusCode >= 200 && statusCode < 300) {
      if (/www\.google\.cn/i.test(body)) {
        return { kind: 'cn', statusCode, body }
      }

      return { kind: 'clean', statusCode, body }
    }

    if (statusCode >= 300 && statusCode < 400) {
      if (!redirectUrl) {
        return { kind: 'unknown', statusCode }
      }

      const nextUrl = new URL(redirectUrl, currentUrl)
      const hostname = nextUrl.hostname.toLowerCase()

      if (hostname === 'google.cn' || hostname.endsWith('.google.cn')) {
        return { kind: 'cn', statusCode, body: nextUrl.toString() }
      }

      if (hostname === 'consent.youtube.com' || hostname === 'consent.google.com') {
        const region = String(nextUrl.searchParams.get('gl') || '')
          .trim()
          .toUpperCase()

        if (region === 'CN') {
          return { kind: 'cn', statusCode, body: nextUrl.toString() }
        }

        if (region) {
          return {
            kind: 'clean',
            statusCode,
            region,
            body: `__YOUTUBE_CONSENT_REGION__:${region}`,
          }
        }

        return { kind: 'unknown', statusCode }
      }

      currentUrl = nextUrl.toString()
      continue
    }

    return { kind: 'unknown', statusCode }
  }

  return { kind: 'unknown', statusCode: 0 }
}

function curlOnce({ proxyHost, proxyPort, url, timeout }) {
  const { execFile } = eval('require("child_process")')
  const marker = '\n__SUBSTORE_GOOGLE_PROBE_META__'
  const timeoutSeconds = Math.max(1, Math.ceil(timeout / 1000))
  const proxyUrl = `http://${proxyHost}:${proxyPort}`

  const args = [
    '--silent',
    '--show-error',
    '--http1.1',
    '--proxy',
    proxyUrl,
    '--connect-timeout',
    String(timeoutSeconds),
    '--max-time',
    String(timeoutSeconds),
    '--user-agent',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1',
    '--header',
    'Accept-Encoding: identity',
    '--output',
    '-',
    '--write-out',
    `${marker}%{http_code}\t%{redirect_url}`,
    url,
  ]

  return new Promise((resolve, reject) => {
    execFile(
      'curl',
      args,
      {
        encoding: 'utf8',
        timeout: timeout + 2000,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout = '', stderr = '') => {
        if (error) {
          const detail = String(stderr || error.message || error).trim()
          reject(new Error(detail || 'curl probe failed'))
          return
        }

        const markerIndex = stdout.lastIndexOf(marker)
        if (markerIndex < 0) {
          reject(new Error('curl probe returned no metadata'))
          return
        }

        const body = stdout.slice(0, markerIndex)
        const meta = stdout.slice(markerIndex + marker.length).trim()
        const tabIndex = meta.indexOf('\t')
        const statusText = tabIndex >= 0 ? meta.slice(0, tabIndex) : meta
        const redirectUrl = tabIndex >= 0 ? meta.slice(tabIndex + 1).trim() : ''
        const statusCode = Number(statusText)

        if (!Number.isFinite(statusCode) || statusCode <= 0) {
          reject(new Error(`curl probe returned invalid HTTP status: ${statusText}`))
          return
        }

        resolve({
          statusCode,
          redirectUrl,
          body,
        })
      }
    )
  })
}

function executeAsyncTasks(tasks, concurrency = 1) {
  return new Promise((resolve, reject) => {
    let running = 0
    let index = 0

    function next() {
      while (index < tasks.length && running < concurrency) {
        const task = tasks[index++]
        running++

        Promise.resolve()
          .then(task)
          .catch(() => {})
          .finally(() => {
            running--
            next()
          })
      }

      if (index >= tasks.length && running === 0) {
        resolve()
      }
    }

    try {
      next()
    } catch (e) {
      reject(e)
    }
  })
}
