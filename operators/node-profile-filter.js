/**
 * Classify and filter nodes before runtime urltest/load-balancing.
 *
 * The script intentionally contains NO built-in node/provider/route data.
 * Node metadata comes from user rules, an optional rulesUrl, and optional MMDB.
 *
 * Mental model:
 *   1. rules / rulesUrl define node metadata.
 *   2. profile / route / traffic / region / provider / asn / host filter it.
 *   3. urltest/load-balancing only compares the surviving nodes.
 *
 * Filters (comma-separated values are OR; different fields are AND):
 *   profile=main,premium
 *   route=optimized,standard
 *   traffic=high,low
 *   region=JP,US
 *   provider=provider-a,provider-b
 *   asn=12345,AS67890
 *   host=node.example.com
 *
 * Rule sources:
 *   rules=<JSON array>
 *   rulesUrl=<URL returning a JSON array, or {"rules":[...]}>
 *
 * Canonical rule format:
 *   {
 *     "match": { "host": "node.example.com" },
 *     "set": {
 *       "provider": "provider-a",
 *       "route": "optimized",
 *       "traffic": "high",
 *       "profile": "main",
 *       "region": "JP",
 *       "asn": "12345"
 *     }
 *   }
 *
 * Match fields:
 *   host, hostRegex, name, nameRegex, subName, subNameRegex
 *
 * Set fields:
 *   provider, route, traffic, region, asn, profile
 *
 * Later matching rules override earlier rules. rulesUrl rules are applied first;
 * inline rules are applied last, so inline rules can override remote config.
 *
 * Legacy flat rules are still accepted for backward compatibility:
 *   { "host": "node.example.com", "route": "optimized" }
 *
 * Optional MMDB enrichment:
 *   mmdb_country_path=<path>
 *   mmdb_asn_path=<path>
 * or environment variables:
 *   SUB_STORE_MMDB_COUNTRY_PATH
 *   SUB_STORE_MMDB_ASN_PATH
 *
 * MMDB only fills region/asn/aso when those values are not already supplied by
 * rules. Country/ASN/latency are NEVER used to infer route quality.
 *
 * Diagnostics:
 *   metadata=true   keep `_nodeProfile` temporarily
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

const MATCH_FIELDS = Object.freeze([
  'host',
  'hostRegex',
  'name',
  'nameRegex',
  'subName',
  'subNameRegex',
]);

const SET_FIELDS = Object.freeze([
  'provider',
  'route',
  'traffic',
  'region',
  'asn',
  'profile',
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

function normalizeRule(rule, index, source) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    throw new TypeError(`${source}[${index}] must be an object`);
  }

  // Canonical explicit schema.
  if (
    Object.prototype.hasOwnProperty.call(rule, 'match') ||
    Object.prototype.hasOwnProperty.call(rule, 'set')
  ) {
    const match = rule.match ?? {};
    const set = rule.set ?? {};

    if (!match || typeof match !== 'object' || Array.isArray(match)) {
      throw new TypeError(`${source}[${index}].match must be an object`);
    }

    if (!set || typeof set !== 'object' || Array.isArray(set)) {
      throw new TypeError(`${source}[${index}].set must be an object`);
    }

    return { match: { ...match }, set: { ...set } };
  }

  // Backward-compatible flat rule schema.
  const match = {};
  const set = {};

  for (const key of MATCH_FIELDS) {
    if (rule[key] !== undefined) match[key] = rule[key];
  }

  for (const key of SET_FIELDS) {
    if (rule[key] !== undefined) set[key] = rule[key];
  }

  return { match, set };
}

function parseRulesPayload(value, source = 'rules') {
  if (value === undefined || value === null || value === '') return [];

  let parsed = value;

  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch (error) {
      throw new Error(`Invalid ${source} JSON: ${error.message ?? error}`);
    }
  }

  if (
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    Array.isArray(parsed.rules)
  ) {
    parsed = parsed.rules;
  }

  if (!Array.isArray(parsed)) {
    throw new TypeError(`${source} must be a JSON array or an object containing a rules array`);
  }

  return parsed.map((rule, index) => normalizeRule(rule, index, source));
}

async function loadRulesFromUrl() {
  const url = String(options.rulesUrl ?? options.rules_url ?? '').trim();
  if (!url) return [];

  if (
    typeof $substore === 'undefined' ||
    !$substore?.http ||
    typeof $substore.http.get !== 'function'
  ) {
    throw new Error('rulesUrl requires $substore.http.get in this Sub-Store runtime');
  }

  const timeout = parseFloat(options.rulesTimeout ?? options.rules_timeout ?? 10000);
  const response = await $substore.http.get({ url, timeout });
  const status = parseInt(response?.status ?? response?.statusCode ?? 200);

  if (status < 200 || status >= 300) {
    throw new Error(`rulesUrl request failed with HTTP ${status}`);
  }

  const body = response?.body ?? '';
  return parseRulesPayload(body, 'rulesUrl');
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
  const match = rule.match || {};
  const stableHost = getStableHost(proxy);

  return (
    matchString(stableHost, match.host, normalizeHost) &&
    matchRegex(stableHost, match.hostRegex) &&
    matchString(getName(proxy), match.name) &&
    matchRegex(getName(proxy), match.nameRegex) &&
    matchString(getSubName(proxy), match.subName) &&
    matchRegex(getSubName(proxy), match.subNameRegex)
  );
}

function applyRule(meta, rule) {
  const next = { ...meta };
  const set = rule.set || {};

  for (const key of ['provider', 'route', 'traffic', 'profile']) {
    if (set[key] !== undefined && set[key] !== null && set[key] !== '') {
      next[key] = normalizeLower(set[key]);
    }
  }

  if (set.region !== undefined && set.region !== null && set.region !== '') {
    next.region = normalizeUpper(set.region);
  }

  if (set.asn !== undefined && set.asn !== null && set.asn !== '') {
    next.asn = normalizeAsn(set.asn);
  }

  return next;
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

function classify(proxy, rules, mmdb) {
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

  for (const rule of rules) {
    if (ruleMatches(proxy, rule)) {
      meta = applyRule(meta, rule);
    }
  }

  return enrichFromMmdb(meta, proxy, mmdb);
}

function profileMatches(meta) {
  if (!requestedProfiles.length || requestedProfiles.includes('all')) {
    return true;
  }

  return matchesAny(meta.profile, requestedProfiles);
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

async function operator(proxies = []) {
  if (!Array.isArray(proxies)) {
    throw new TypeError('Expected proxies to be an array');
  }

  const remoteRules = await loadRulesFromUrl();
  const inlineRules = parseRulesPayload(options.rules, 'rules');
  const rules = [...remoteRules, ...inlineRules];
  const mmdb = createMmdb();

  return proxies.flatMap((proxy) => {
    const meta = classify(proxy, rules, mmdb);

    if (!shouldKeep(meta)) {
      return [];
    }

    const result = { ...proxy };

    if (keepMetadata) {
      result._nodeProfile = meta;
    } else {
      delete result._nodeProfile;
    }

    // `_originServer` only bridges the DNS Resolve boundary.
    delete result._originServer;

    return [result];
  });
}
