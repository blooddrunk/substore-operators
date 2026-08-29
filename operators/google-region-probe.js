/**
 * Probe Google/YouTube region behavior through every proxy using HTTP META.
 *
 * This is intentionally specialized for the Google "送中" check:
 * - 2xx response: keep the response body in `_geo` for google-region-check.js.
 * - EEA YouTube/Google consent redirect: store a small non-CN marker instead of
 *   following the redirect loop.
 * - Other failures / redirects: leave `_geo` unset => unknown.
 *
 * Hysteria2 `ports` is removed only from the temporary HTTP META probe copy.
 * The original subscription node remains unchanged.
 *
 * The actual HTTPS probe intentionally uses only Node built-in modules (`http`
 * and `tls`). Sub-Store's remote-script runtime does not expose `undici` as a
 * require-able package, and Sub-Store's own HTTP wrapper automatically follows
 * redirects with a hard redirect limit.
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
        proxyHost: httpMetaHost,
        proxyPort: httpMetaPorts[internalIndex],
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
        // An explicit non-CN consent region is positive evidence that this
        // request is being handled as that region, not mainland China.
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

async function probeViaHttpMeta({ proxyHost, proxyPort, url, timeout }) {
  let currentUrl = url

  // Follow only a few ordinary redirects ourselves. Consent redirects are
  // intentionally not followed, so they cannot enter Sub-Store's redirect loop.
  for (let i = 0; i < 4; i++) {
    const response = await requestHttpsThroughHttpProxy({
      proxyHost,
      proxyPort,
      url: currentUrl,
      timeout,
    })

    const { statusCode, headers, body } = response

    if (statusCode >= 200 && statusCode < 300) {
      return { kind: 'ok', statusCode, body }
    }

    if (statusCode >= 300 && statusCode < 400) {
      const rawLocation = Array.isArray(headers.location)
        ? headers.location[0]
        : headers.location

      if (!rawLocation) {
        return { kind: 'unknown', statusCode }
      }

      const nextUrl = new URL(rawLocation, currentUrl)
      const hostname = nextUrl.hostname.toLowerCase()

      // A direct redirect to Google China is itself a positive CN signal.
      if (hostname === 'www.google.cn' || hostname.endsWith('.google.cn')) {
        return {
          kind: 'ok',
          statusCode,
          body: nextUrl.toString(),
        }
      }

      if (hostname === 'consent.youtube.com' || hostname === 'consent.google.com') {
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
}

function requestHttpsThroughHttpProxy({ proxyHost, proxyPort, url, timeout }) {
  const http = eval('require("http")')
  const tls = eval('require("tls")')
  const target = new URL(url)

  if (target.protocol !== 'https:') {
    throw new Error(`Google probe only supports HTTPS URLs: ${url}`)
  }

  const targetPort = Number(target.port || 443)
  const authority = `${target.hostname}:${targetPort}`

  return new Promise((resolve, reject) => {
    let settled = false

    const fail = error => {
      if (settled) return
      settled = true
      reject(error instanceof Error ? error : new Error(String(error)))
    }

    const connectReq = http.request({
      host: proxyHost,
      port: Number(proxyPort),
      method: 'CONNECT',
      path: authority,
      agent: false,
      headers: {
        Host: authority,
        'Proxy-Connection': 'keep-alive',
      },
    })

    connectReq.setTimeout(timeout, () => {
      connectReq.destroy(new Error('HTTP META CONNECT timeout'))
    })

    connectReq.once('connect', (connectRes, socket, head) => {
      if (connectRes.statusCode !== 200) {
        socket.destroy()
        fail(new Error(`HTTP META CONNECT failed: ${connectRes.statusCode}`))
        return
      }

      if (head?.length) {
        socket.unshift(head)
      }

      const tlsSocket = tls.connect({
        socket,
        servername: target.hostname,
        rejectUnauthorized: true,
        ALPNProtocols: ['http/1.1'],
      })

      const chunks = []

      tlsSocket.setTimeout(timeout, () => {
        tlsSocket.destroy(new Error('Google probe TLS/request timeout'))
      })

      tlsSocket.once('secureConnect', () => {
        const path = `${target.pathname || '/'}${target.search || ''}`
        const requestText = [
          `GET ${path} HTTP/1.1`,
          `Host: ${target.host}`,
          'User-Agent: Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1',
          'Cookie: SOCS=CAI',
          'Accept: */*',
          'Accept-Encoding: identity',
          'Connection: close',
          '',
          '',
        ].join('\r\n')

        tlsSocket.write(requestText)
      })

      tlsSocket.on('data', chunk => chunks.push(chunk))

      tlsSocket.once('end', () => {
        if (settled) return

        try {
          const parsed = parseHttpResponse(Buffer.concat(chunks))
          settled = true
          resolve(parsed)
        } catch (e) {
          fail(e)
        }
      })

      tlsSocket.once('error', fail)
    })

    connectReq.once('error', fail)
    connectReq.end()
  })
}

function parseHttpResponse(buffer) {
  const separator = Buffer.from('\r\n\r\n')
  const headerEnd = buffer.indexOf(separator)

  if (headerEnd < 0) {
    throw new Error('Invalid HTTP response: missing headers')
  }

  const headerText = buffer.subarray(0, headerEnd).toString('latin1')
  const lines = headerText.split('\r\n')
  const statusMatch = lines.shift()?.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i)

  if (!statusMatch) {
    throw new Error('Invalid HTTP response: missing status')
  }

  const headers = {}

  for (const line of lines) {
    const index = line.indexOf(':')
    if (index <= 0) continue

    const key = line.slice(0, index).trim().toLowerCase()
    const value = line.slice(index + 1).trim()

    if (headers[key] === undefined) {
      headers[key] = value
    } else if (Array.isArray(headers[key])) {
      headers[key].push(value)
    } else {
      headers[key] = [headers[key], value]
    }
  }

  let bodyBuffer = buffer.subarray(headerEnd + separator.length)
  const transferEncoding = String(headers['transfer-encoding'] || '').toLowerCase()

  if (transferEncoding.includes('chunked')) {
    bodyBuffer = decodeChunkedBody(bodyBuffer)
  }

  return {
    statusCode: Number(statusMatch[1]),
    headers,
    body: bodyBuffer.toString('utf8'),
  }
}

function decodeChunkedBody(buffer) {
  const chunks = []
  let offset = 0

  while (offset < buffer.length) {
    const lineEnd = buffer.indexOf(Buffer.from('\r\n'), offset)
    if (lineEnd < 0) {
      throw new Error('Invalid chunked response')
    }

    const sizeText = buffer
      .subarray(offset, lineEnd)
      .toString('ascii')
      .split(';')[0]
      .trim()
    const size = parseInt(sizeText, 16)

    if (!Number.isFinite(size)) {
      throw new Error('Invalid chunk size')
    }

    offset = lineEnd + 2

    if (size === 0) {
      break
    }

    const chunkEnd = offset + size
    if (chunkEnd > buffer.length) {
      throw new Error('Incomplete chunked response')
    }

    chunks.push(buffer.subarray(offset, chunkEnd))
    offset = chunkEnd + 2
  }

  return Buffer.concat(chunks)
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
