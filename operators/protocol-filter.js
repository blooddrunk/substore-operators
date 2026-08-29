/**
 * Filter a 3x-ui subscription down to the proxy types used by this setup.
 *
 * filterType:
 *
 * all        - VLESS + Hysteria2 (default)
 * vless      - VLESS only
 * reality    - alias of vless
 * hysteria2  - Hysteria2 only
 * hy2        - alias of hysteria2
 *
 * This operator runs before DNS Resolve. When `server` is a hostname it is
 * copied to `_originServer` so later operators can still classify the node by
 * its stable hostname after DNS Resolve pins `server` to an IP address.
 *
 * Parameter priority:
 * $options > $arguments > defaults
 */

const scriptArgs =
  typeof $arguments === 'object' && $arguments
    ? $arguments
    : {};

const requestOptions =
  typeof $options === 'object' && $options
    ? $options
    : {};

const options = {
  ...scriptArgs,
  ...requestOptions,
};

const FILTER_ALIASES = Object.freeze({
  all: 'all',
  vless: 'vless',
  reality: 'vless',
  hysteria2: 'hysteria2',
  hy2: 'hysteria2',
});

function normalizeFilterType(value) {
  const key = String(value ?? 'all')
    .trim()
    .toLowerCase();

  const result = FILTER_ALIASES[key];

  if (!result) {
    throw new Error(
      `Unknown filterType: ${value}. ` +
      'Expected: all, vless, reality, hysteria2, hy2'
    );
  }

  return result;
}

const filterType = normalizeFilterType(options.filterType);

function getProxyType(proxy) {
  return typeof proxy?.type === 'string'
    ? proxy.type.trim().toLowerCase()
    : '';
}

function isVless(proxy) {
  return getProxyType(proxy) === 'vless';
}

function isHysteria2(proxy) {
  return getProxyType(proxy) === 'hysteria2';
}

/**
 * `all` here means all node types used by this setup,
 * not every protocol supported by Sub-Store.
 */
function shouldKeep(proxy) {
  switch (filterType) {
    case 'vless':
      return isVless(proxy);

    case 'hysteria2':
      return isHysteria2(proxy);

    case 'all':
      return isVless(proxy) || isHysteria2(proxy);

    default:
      return false;
  }
}

function isIpAddress(value) {
  if (typeof value !== 'string') {
    return false;
  }

  const input = value.trim();

  if (!input) {
    return false;
  }

  if (
    typeof ProxyUtils !== 'undefined' &&
    typeof ProxyUtils.isIP === 'function'
  ) {
    return Boolean(ProxyUtils.isIP(input));
  }

  // Lightweight fallback for environments where ProxyUtils.isIP is absent.
  // IPv6 literals contain ':'; IPv4 literals are four decimal octets.
  if (input.includes(':')) {
    return true;
  }

  const parts = input.split('.');

  return (
    parts.length === 4 &&
    parts.every((part) => {
      if (!/^\d{1,3}$/.test(part)) return false;
      const n = Number(part);
      return n >= 0 && n <= 255;
    })
  );
}

/**
 * Preserve the pre-DNS hostname for profile/provider matching later.
 */
function preserveOriginServer(proxy) {
  const server =
    typeof proxy?.server === 'string'
      ? proxy.server.trim()
      : '';

  if (!server || isIpAddress(server) || proxy._originServer) {
    return proxy;
  }

  return {
    ...proxy,
    _originServer: server,
  };
}

/**
 * Before a later DNS Resolve Action changes `server` from hostname to IP,
 * preserve the original hostname as Hysteria2 SNI when no explicit TLS
 * hostname is already configured.
 */
function ensureHysteria2Sni(proxy) {
  if (!isHysteria2(proxy)) {
    return proxy;
  }

  if (proxy.sni || proxy.servername) {
    return proxy;
  }

  const server =
    typeof proxy.server === 'string'
      ? proxy.server.trim()
      : '';

  if (!server || isIpAddress(server)) {
    return proxy;
  }

  return {
    ...proxy,
    sni: server,
  };
}

function operator(proxies = []) {
  if (!Array.isArray(proxies)) {
    throw new TypeError('Expected proxies to be an array');
  }

  return proxies
    .filter(shouldKeep)
    .map(preserveOriginServer)
    .map(ensureHysteria2Sni);
}
