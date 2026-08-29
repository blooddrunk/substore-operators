/**
 * Classify and filter Google region probe results.
 *
 * Preferred upstream contract:
 *   _googleStatus = clean | cn | unknown
 *
 * Compatibility fallback:
 *   if `_googleStatus` is absent, inspect `_geo` and use the historical
 *   www.google.cn marker produced by http-meta-geo.js.
 *
 * googleStatus:
 *   all      - keep all nodes (default)
 *   clean    - keep nodes classified clean
 *   cn       - keep nodes classified cn
 *   unknown  - keep nodes without a reliable probe result
 *
 * Aliases:
 *   ok       -> clean
 *   china    -> cn
 *
 * Parameter priority:
 *   $options > $arguments > defaults
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

const STATUS_ALIASES = Object.freeze({
  all: 'all',
  clean: 'clean',
  ok: 'clean',
  cn: 'cn',
  china: 'cn',
  unknown: 'unknown',
});

function normalizeGoogleStatus(value) {
  const key = String(value ?? 'all')
    .trim()
    .toLowerCase();

  const result = STATUS_ALIASES[key];

  if (!result) {
    throw new Error(
      `Unknown googleStatus: ${value}. ` +
      'Expected: all, clean, ok, cn, china, unknown'
    );
  }

  return result;
}

const googleStatus = normalizeGoogleStatus(options.googleStatus);

function stringifyGeo(value) {
  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value ?? '');
  }
}

function classifyGoogleStatus(proxy) {
  const explicit = String(proxy?._googleStatus ?? '')
    .trim()
    .toLowerCase();

  if (explicit === 'clean' || explicit === 'cn' || explicit === 'unknown') {
    return explicit;
  }

  if (!proxy || !Object.prototype.hasOwnProperty.call(proxy, '_geo')) {
    return 'unknown';
  }

  if (proxy._geo === null || proxy._geo === undefined) {
    return 'unknown';
  }

  const geo = stringifyGeo(proxy._geo).trim();

  if (!geo) {
    return 'unknown';
  }

  return /www\.google\.cn/i.test(geo)
    ? 'cn'
    : 'clean';
}

function shouldKeep(status) {
  return googleStatus === 'all' || status === googleStatus;
}

function operator(proxies = []) {
  if (!Array.isArray(proxies)) {
    throw new TypeError('Expected proxies to be an array');
  }

  return proxies.flatMap((proxy) => {
    const status = classifyGoogleStatus(proxy);

    if (!shouldKeep(status)) {
      return [];
    }

    const result = { ...proxy };
    delete result._geo;
    delete result._googleStatus;

    return [result];
  });
}
