/**
 * Filter nodes by stable, policy-oriented profile metadata before runtime
 * urltest/load-balancing. The purpose is to prevent low-RTT but poor China
 * routes from competing with known optimized routes in the same pool.
 *
 * Supported filters (comma-separated values are OR; different fields are AND):
 *   profile=main|premium|backup|optimized|standard|all
 *   route=optimized|standard
 *   traffic=high|low
 *   region=JP,US,...
 *   provider=nosla,bitsflow,...
 *   asn=12345,AS12345
 *   host=nosla.example.com,...
 *
 * Optional behavior:
 *   rules=<JSON array>          additional/override classification rules
 *   mmdb_country_path=<path>    override country MMDB path
 *   mmdb_asn_path=<path>        override ASN MMDB path
 *   metadata=true               keep `_nodeProfile` for diagnostics
 *
 * Environment fallback:
 *   SUB_STORE_MMDB_COUNTRY_PATH
 *   SUB_STORE_MMDB_ASN_PATH
 *
 * Rule precedence:
 *   later matching rules override earlier ones.
 *   built-in rules are applied first, then user `rules`.
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

/**
 * Only facts explicitly established for this setup belong here.
 * Do not infer China-route quality from ASN, country, or latency.
 *
 * Add `traffic` when the traffic/cost tier is known. Once both `route` and
 * `traffic` are known, `profile=main|premium|backup` can be derived.
 */
const BUILTIN_RULES = Object.freeze([
  {
    host: 'nosla.example.com',
    provider: 'nosla',
    route: 'optimized',
  },
  {
    host: 'bitsflow.example.com',
    provider: 'bitsflow',
    route: 'standard',
  },
]);

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function list(value) {
  if (value === undefined || value === null || value === '') return [];

  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeLower(value) {
  return String(value ?? '').trim().toLowerCase();
}

function normalizeUpper(value) {
  return String(value ?? '').trim().toUpperCase();
}

function normalizeHost(value) {
  return normalizeLower(value).replace(/^\[|\]$/g, '');
}

function normalizeAsn(value) {
  const raw = normalizeUpper(value);
  if (!raw) return '';
  return raw.startsWith('AS') ? raw.slice(2) : raw;
}

function isIpAddress(value) {
  if (typeof value !== 'string') return false;
  const input = value.trim();
  if (!input) return false;

  if (
    typeof ProxyUtils !== 'undefined' &&
    typeof ProxyUtils.isIP === 'function'
  ) {
    return Boolean(ProxyUtils.isIP(input));
  }

  if (input.includes(':')) return true;

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

function parseUserRules(value) {
  if (value === undefined || value === null || value === '') return [];

  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch (error) {
      throw new Error(`Invalid rules JSON: ${error.message ?? error}`);
    }
  }

  if (!Array.isArray(parsed)) {
    throw new TypeError('rules must be a JSON array');
  }

  return parsed.map((rule, index) => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      throw new TypeError(`rules[${index}] must be an object`);
    }
    return rule;
  });
}

function getEnvironment(name) {
  try {
    return eval(`process.env.${name}`) || '';
  } catch (_) {
    return '';
  }
}

function getStableHost(proxy) {
  const origin = normalizeHost(proxy?._originServer);
  if (origin) return origin;

  const server = normalizeHost(proxy?.server);
  return server && !isIpAddress(server) ? server : '';
}

function getSubName(proxy) {
  return String(proxy?._subName ?? proxy?.subName ?? '').trim();
}

function getName(proxy) {
  return String(proxy?.name ?? '').trim();
}

function matchString(actual, expected, normalizer = normalizeLower) {
  if (expected === undefined || expected === null || expected === '') return true;

  const actualValue = normalizer(actual);
  const expectedValues = Array.isArray(expected) ? expected : [expected];

  return expectedValues.some((candidate) => actualValue === normalizer(candidate));
}

function matchRegex(actual, pattern) {
  if (pattern === undefined || pattern === null || pattern === '') return true;

  try {
    return new RegExp(String(pattern), 'i').test(String(actual ?? ''));
  } catch (error) {
    throw new Error(`Invalid rule regex ${pattern}: ${error.message ?? error}`);
  }
}

function ruleMatches(proxy, rule) {
  const stableHost = getStableHost(proxy);

  return (
    matchString(stableHost, rule.host, normalizeHost) &&
    matchRegex(stableHost, rule.hostRegex) &&
    matchString(getName(proxy), rule.name) &&
    matchRegex(getName(proxy), rule.nameRegex) &&
    matchString(getSubName(proxy), rule.subName) &&
    matchRegex(getSubName(proxy), rule.subNameRegex)
  );
}

function applyRule(meta, rule) {
  const next = { ...meta };

  for (const key of ['provider', 'route', 'traffic', 'region', 'profile']) {
    if (rule[key] !== undefined && rule[key] !== null && rule[key] !== '') {
      next[key] = key === 'region'
        ? normalizeUpper(rule[key])
        : normalizeLower(rule[key]);
    }
  }

  if (rule.asn !== undefined && rule.asn !== null && rule.asn !== '') {
    next.asn = normalizeAsn(rule.asn);
  }

  return next;
}

function deriveProfile(meta) {
  if (meta.profile) return meta.profile;

  if (meta.route === 'standard') {
    return 'backup';
  }

  if (meta.route === 'optimized' && meta.traffic === 'high') {
    return 'main';
  }

  if (meta.route === 'optimized' && meta.traffic === 'low') {
    return 'premium';
  }

  return '';
}

function createMmdb() {
  const countryPath =
    String(options.mmdb_country_path ?? '').trim() ||
    getEnvironment('SUB_STORE_MMDB_COUNTRY_PATH');

  const asnPath =
    String(options.mmdb_asn_path ?? '').trim() ||
    getEnvironment('SUB_STORE_MMDB_ASN_PATH');

  if (!countryPath && !asnPath) return null;

  if (
    typeof ProxyUtils === 'undefined' ||
    typeof ProxyUtils.MMDB !== 'function'
  ) {
    throw new Error('ProxyUtils.MMDB is unavailable in this Sub-Store runtime');
  }

  return new ProxyUtils.MMDB({
    country: countryPath || undefined,
    asn: asnPath || undefined,
  });
}

function enrichFromMmdb(meta, proxy, mmdb) {
  if (!mmdb || !isIpAddress(String(proxy?.server ?? ''))) {
    return meta;
  }

  const ip = String(proxy.server).trim();
  const next = { ...meta };

  try {
    if (!next.region && typeof mmdb.geoip === 'function') {
      next.region = normalizeUpper(mmdb.geoip(ip));
    }
  } catch (_) {}

  try {
    if (!next.asn && typeof mmdb.ipasn === 'function') {
      next.asn = normalizeAsn(mmdb.ipasn(ip));
    }
  } catch (_) {}

  try {
    if (typeof mmdb.ipaso === 'function') {
      next.aso = String(mmdb.ipaso(ip) ?? '').trim();
    }
  } catch (_) {}

  return next;
}

function matchesAny(actual, requested, normalizer = normalizeLower) {
  if (!requested.length) return true;
  const normalizedActual = normalizer(actual);
  return requested.some((item) => normalizedActual === normalizer(item));
}

const requestedProfiles = list(options.profile).map(normalizeLower);
const requestedRoutes = list(options.route).map(normalizeLower);
const requestedTraffic = list(options.traffic).map(normalizeLower);
const requestedRegions = list(options.region).map(normalizeUpper);
const requestedProviders = list(options.provider).map(normalizeLower);
const requestedAsns = list(options.asn).map(normalizeAsn);
const requestedHosts = list(options.host).map(normalizeHost);
const keepMetadata = toBoolean(options.metadata, false);
const userRules = parseUserRules(options.rules);
const allRules = [...BUILTIN_RULES, ...userRules];

function classify(proxy, mmdb) {
  let meta = {
    host: getStableHost(proxy),
    provider: '',
    route: '',
    traffic: '',
    region: '',
    asn: '',
    aso: '',
    profile: '',
  };

  for (const rule of allRules) {
    if (ruleMatches(proxy, rule)) {
      meta = applyRule(meta, rule);
    }
  }

  meta = enrichFromMmdb(meta, proxy, mmdb);
  meta.profile = deriveProfile(meta);

  return meta;
}

function profileMatches(meta) {
  if (!requestedProfiles.length || requestedProfiles.includes('all')) {
    return true;
  }

  return requestedProfiles.some((profile) => {
    switch (profile) {
      case 'main':
        return meta.profile === 'main';
      case 'premium':
        return meta.profile === 'premium';
      case 'backup':
        return meta.profile === 'backup';
      case 'optimized':
        return meta.route === 'optimized';
      case 'standard':
        return meta.route === 'standard';
      default:
        throw new Error(
          `Unknown profile: ${profile}. Expected: all, main, premium, backup, optimized, standard`
        );
    }
  });
}

function shouldKeep(meta) {
  return (
    profileMatches(meta) &&
    matchesAny(meta.route, requestedRoutes) &&
    matchesAny(meta.traffic, requestedTraffic) &&
    matchesAny(meta.region, requestedRegions, normalizeUpper) &&
    matchesAny(meta.provider, requestedProviders) &&
    matchesAny(meta.asn, requestedAsns, normalizeAsn) &&
    matchesAny(meta.host, requestedHosts, normalizeHost)
  );
}

function operator(proxies = []) {
  if (!Array.isArray(proxies)) {
    throw new TypeError('Expected proxies to be an array');
  }

  const mmdb = createMmdb();

  return proxies.flatMap((proxy) => {
    const meta = classify(proxy, mmdb);

    if (!shouldKeep(meta)) {
      return [];
    }

    const result = { ...proxy };

    if (keepMetadata) {
      result._nodeProfile = meta;
    } else {
      delete result._nodeProfile;
    }

    // `_originServer` exists only to bridge the DNS Resolve boundary.
    delete result._originServer;

    return [result];
  });
}
