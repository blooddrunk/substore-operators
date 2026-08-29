/**
 * Probe Google/YouTube region behavior through every proxy using HTTP META.
 *
 * This is intentionally specialized for the Google "送中" check:
 * - 200 response: keep the response body in `_geo` for google-region-check.js.
 * - EEA YouTube consent redirect: store a small non-CN marker instead of
 *   following the redirect loop.
 * - Other failures / redirects: leave `_geo` unset => unknown.
 *
 * Hysteria2 `ports` is removed only from the temporary HTTP META probe copy.
 * The original subscription node remains unchanged.
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
  const startDelay = parseFloat($arguments.http_meta_start_delay ?? 3000)
  const proxyTimeout = parseFloat($arguments.http_meta_proxy_timeout ?? 10000)
  const requestTimeout = parseFloat($arguments.timeout ?? 10000)
  const concurrency = Math.max(1, parseInt($arguments.concurrency || 10))
  const includeUnsupportedProxy = $arguments.include_unsupported_proxy
  const url = $arguments.api || 'https://www.youtube.com/premium'

  const internalProxies = []

  proxies.forEach((proxy, index) => {
    try {
      const probeProxy = { ...proxy }

      // HTTP META / Mihomo probing has proven unreliable with Hysteria2 port
      // hopping in this setup. Only the probe copy uses the primary port.
      if (String(probeProxy.type || '').trim().toLowerCase() === 'hysteria2') {
        delete probeProxy.ports
      }

      const node = ProxyUtils.produce([probeProxy], 'ClashMeta', 'internal', {
        'include-unsupported-proxy': includeUnsupportedProxy,
      })?.[0]

      if (node) {
        internalProxies.push({ ...node, _proxies_index: index })
      }
    } catch (e) {
      $.error(`[${proxy?.name || index}] ${e.message ?? e}`)
    }
  })

  $.info(`Google probe 核心支持节点数: ${internalProxies.length}/${proxies.length}`)
  if (!internalProxies.length) return proxies

  const httpMetaTimeout = startDelay + internalProxies.length * proxyTimeout
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
        proxies: internalProxies,
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
    const originalIndex = proxy._proxies_index
    const name = proxies[originalIndex]?.name || proxy.name || String(originalIndex)
    const startedAt = Date.now()

    try {
      const result = await probeViaHttpMeta({
        proxyUrl: `http://${httpMetaHost}:${httpMetaPorts[internalIndex]}`,
        url,
        timeout: requestTimeout,
      })

      const latency = Date.now() - startedAt

      if (result.kind === 'ok') {
        proxies[originalIndex]._geo = result.body
        $.info(`[${name}] status: ${result.statusCode}, latency: ${latency}`)
        return
      }

      if (result.kind === 'consent') {
        // A YouTube consent page with an explicit non-CN `gl` is positive
        // evidence that this request is being handled as that region, not CN.
        proxies[originalIndex]._geo = `__YOUTUBE_CONSENT_REGION__:${result.region}`
        $.info(
          `[${name}] status: ${result.statusCode}, consent-region: ${result.region}, latency: ${latency}`
        )
        return
      }

      $.info(`[${name}] status: ${result.statusCode}, verdict: unknown, latency: ${latency}`)
    } catch (e) {
      $.error(`[${name}] ${e.message ?? e}`)
    }
  }
}

async function probeViaHttpMeta({ proxyUrl, url, timeout }) {
  const { ProxyAgent, request } = eval('require("undici")')
  const dispatcher = new ProxyAgent({ uri: proxyUrl })

  try {
    let currentUrl = url

    // Follow only a small number of ordinary redirects ourselves. We stop as
    // soon as YouTube sends us to the regional consent endpoint.
    for (let i = 0; i < 4; i++) {
      const response = await request(currentUrl, {
        dispatcher,
        method: 'GET',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1',
          Cookie: 'SOCS=CAI',
        },
        maxRedirections: 0,
        headersTimeout: timeout,
        bodyTimeout: timeout,
      })

      const statusCode = Number(response.statusCode)
      const body = await response.body.text()

      if (statusCode >= 200 && statusCode < 300) {
        return { kind: 'ok', statusCode, body }
      }

      if (statusCode >= 300 && statusCode < 400) {
        const rawLocation = Array.isArray(response.headers.location)
          ? response.headers.location[0]
          : response.headers.location

        if (!rawLocation) {
          return { kind: 'unknown', statusCode }
        }

        const nextUrl = new URL(rawLocation, currentUrl)

        if (nextUrl.hostname.toLowerCase() === 'consent.youtube.com') {
          const region = String(nextUrl.searchParams.get('gl') || '')
            .trim()
            .toUpperCase()

          if (region && region !== 'CN') {
            return {
              kind: 'consent',
              statusCode,
              region,
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
  } finally {
    try {
      await dispatcher.close()
    } catch (_) {}
  }
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
