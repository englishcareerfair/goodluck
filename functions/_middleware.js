const ADMIN_OWN_IPS = [];
/**
 * Cloudflare Pages Edge Middleware
 * High-Performance Anti-DDoS, Edge Rate Limiter & Zero-Usage Shield
 *
 * Configured:
 * - DDoS Protection: Burst (>30 page or >50 API reqs in 1s) & Sustained (300 reqs in 60s) per IP.
 * - If exceeded, drops the connection with 429 and temporary 2h ban with 0 payload/D1 reads.
 * - Scanner probe trap: Immediate drop for malicious bots (.env, wp-login, etc.)
 * - Zero permanent IP bypasses: All public client IPs are subject to identical rate limits & security checks.
 */

// ── In-Memory Edge State (persists across requests on the same Cloudflare Edge isolate) ──
const IP_RATE_LIMITS = new Map(); // ip -> { count, resetAt, burstCount, burstResetAt, apiBurstCount, apiBurstResetAt, bootCount, bootResetAt }
const AUTO_BANNED_IPS = new Map(); // ip -> banExpiresAt (timestamp)
const VPN_BANNED_IPS = new Map(); // ip -> { reason, bannedAt }



let GLOBAL_DYNAMIC_COUNT = 0;
let GLOBAL_DYNAMIC_RESET_AT = 0;
let GLOBAL_UNIQUE_IPS = new Set();
let UNDER_DDOS_MODE = false;
let UNDER_DDOS_UNTIL = 0;

// ── Reset in-memory maps on boot to ensure clean slate ──
AUTO_BANNED_IPS.clear();
VPN_BANNED_IPS.clear();
IP_RATE_LIMITS.clear();

const EXPLICIT_DDOS_BANNED_IPS = new Set([
  '2606:4700:310c::ac42:2ca2',
  '2606:4700:310c::ac42:2f5e',
  '172.66.44.162',
  '172.66.47.94'
]);

function expandIpv6(ip) {
  if (!ip || !ip.includes(':')) return ip;
  const parts = ip.split('::');
  if (parts.length === 2) {
    const head = parts[0] ? parts[0].split(':').filter(Boolean) : [];
    const tail = parts[1] ? parts[1].split(':').filter(Boolean) : [];
    const missing = 8 - head.length - tail.length;
    const zeros = Array(Math.max(0, missing)).fill('0000');
    const full = [...head, ...zeros, ...tail];
    return full.map(p => p.padStart(4, '0')).join(':').toLowerCase();
  }
  return ip.split(':').map(p => p.padStart(4, '0')).join(':').toLowerCase();
}

function getSubnetKeys(ip) {
  if (!ip) return { net: '', sub: '' };
  const s = String(ip).trim();
  if (s.includes(':')) {
    const exp = expandIpv6(s);
    const parts = exp.split(':');
    return {
      net: 'v6_48:' + parts.slice(0, 3).join(':'),
      sub: 'v6_64:' + parts.slice(0, 4).join(':')
    };
  }
  const parts = s.split('.');
  if (parts.length >= 3) {
    return {
      net: 'v4_16:' + parts.slice(0, 2).join('.'),
      sub: 'v4_24:' + parts.slice(0, 3).join('.')
    };
  }
  return { net: s, sub: s };
}

function getSubnetKey(ip) {
  return getSubnetKeys(ip).sub;
}

function getClientFingerprint(req) {
  const customId = req.headers.get('x-visitor-id') || req.headers.get('x-client-id') || '';
  const cookie = req.headers.get('cookie') || '';
  let sessCookie = '';
  const m = cookie.match(/\b(cf_visitor_id|cf_session_id|session_id)=([^;]+)/i);
  if (m) sessCookie = m[2];
  if (customId || sessCookie) return `id:${customId || sessCookie}`;
  const ua = String(req.headers.get('user-agent') || '').slice(0, 80);
  const lang = String(req.headers.get('accept-language') || '').slice(0, 20);
  const ch = String(req.headers.get('sec-ch-ua') || '').slice(0, 40);
  if (ua) return `fp:${ua}|${lang}|${ch}`;
  return '';
}

let CACHED_SECURITY_STATE = {
  blockedSet: new Set(),
  allowlistSet: new Set(),
  adminDevicesSet: new Set()
};
let HAS_CLEANED_BANS_IN_D1 = false;
let LAST_BLOCKED_FETCH_MS = 0;
const CACHE_TTL_MS = 15 * 1000; // 15s memory cache for D1 security lists

// ── VPN, Tor, Proxy & Hosting/Datacenter Detection Tables ──
const KNOWN_VPN_ASNS = new Set([
  611,
  1101,
  1610,
  2514,
  3223,
  3257,
  3352,
  3462,
  4224,
  4314,
  4766,
  4837,
  5545,
  5578,
  6461,
  6939,
  7015,
  7385,
  7684,
  7738,
  7979,
  8075,
  8100,
  8151,
  8342,
  8560,
  8595,
  8764,
  8772,
  9009,
  9123,
  10753,
  11721,
  11878,
  12389,
  12552,
  12695,
  12722,
  12816,
  12876,
  12880,
  13213,
  13335,
  13768,
  14061,
  14618,
  14956,
  14987,
  15317,
  15626,
  16125,
  16276,
  16509,
  18779,
  18978,
  20454,
  20473,
  21100,
  21334,
  21769,
  21859,
  23724,
  24669,
  24940,
  25046,
  25369,
  25490,
  25513,
  25549,
  26496,
  26548,
  26832,
  27176,
  27284,
  27947,
  28412,
  28513,
  28550,
  28753,
  29066,
  29182,
  29226,
  29802,
  30836,
  30893,
  31200,
  31898,
  32613,
  33837,
  33993,
  34224,
  34665,
  34787,
  34832,
  34989,
  35816,
  35916,
  36007,
  36183,
  36352,
  36680,
  38731,
  39043,
  39238,
  39392,
  39690,
  40065,
  40355,
  40663,
  40676,
  41079,
  41281,
  41535,
  41564,
  42237,
  42708,
  42730,
  42831,
  42926,
  43226,
  43289,
  43317,
  43350,
  43641,
  43647,
  44050,
  44559,
  44812,
  44925,
  45027,
  45090,
  45102,
  45701,
  45899,
  46261,
  46562,
  46664,
  46844,
  47066,
  47583,
  47702,
  47913,
  48030,
  48031,
  48090,
  48282,
  48287,
  48300,
  48347,
  48614,
  48693,
  48988,
  49063,
  49453,
  49492,
  49505,
  49791,
  49825,
  50053,
  50113,
  50214,
  50245,
  50304,
  50340,
  50613,
  50979,
  51167,
  51248,
  51290,
  51396,
  51747,
  51765,
  51783,
  51852,
  52053,
  53667,
  53831,
  54538,
  54990,
  55286,
  55990,
  56630,
  56655,
  56694,
  56803,
  56971,
  57169,
  58061,
  58065,
  58087,
  58461,
  58519,
  59253,
  59504,
  59592,
  59651,
  59729,
  60068,
  60389,
  60404,
  60729,
  60781,
  61125,
  61317,
  61400,
  61976,
  62082,
  62240,
  62282,
  62370,
  62567,
  62874,
  63023,
  63199,
  63473,
  63949,
  64200,
  64249,
  64267,
  64286,
  132153,
  132203,
  132817,
  133301,
  133944,
  134768,
  135340,
  135377,
  136195,
  136557,
  136787,
  136907,
  137280,
  137409,
  138915,
  139201,
  140389,
  150436,
  154177,
  197540,
  197695,
  197706,
  198093,
  198953,
  199058,
  199242,
  199950,
  200000,
  200019,
  200044,
  200130,
  200195,
  200197,
  200373,
  200590,
  200593,
  200651,
  200740,
  201229,
  201341,
  202018,
  202044,
  202053,
  202109,
  202306,
  202425,
  202496,
  202635,
  202656,
  202984,
  203020,
  203999,
  204490,
  204916,
  204957,
  204997,
  205007,
  205016,
  205090,
  205100,
  205125,
  205301,
  205467,
  205516,
  205659,
  206216,
  206264,
  206411,
  206986,
  207990,
  208226,
  208323,
  208677,
  209605,
  209709,
  209847,
  209854,
  209974,
  210558,
  210644,
  210731,
  210756,
  210906,
  210976,
  211027,
  211298,
  211590,
  211619,
  211680,
  211720,
  212136,
  212238,
  212286,
  212317,
  212477,
  212667,
  212913,
  213220,
  213230,
  213250,
  213520,
  213535,
  213802,
  213861,
  213873,
  213877,
  214159,
  214196,
  214209,
  214238,
  214503,
  214902,
  214940,
  214943,
  214996,
  215125,
  215540,
  215590,
  215659,
  215730,
  215859,
  215925,
  216071,
  216246,
  216253,
  329272,
  393406,
  394362,
  394711,
  394814,
  395092,
  395954,
  396319,
  396356,
  396507,
  396982,
  397336,
  397373,
  398101,
  398324,
  398705,
  398712,
  399486,
  399629,
  399646,
  400175,
  400536,
  400992,
  401115,
  401116,
  401120,
  401152,
]);

const RESIDENTIAL_ISP_ALLOWLIST = /\b(fast\s*4|fast\s*4\s*technologies|jio|reliance\s*jio|bharti\s*airtel|airtel|vodafone|vi\s+india|idea\s+cellular|bsnl|mtnl|act\s*corp|atria\s*convergence|hathway|tikona|excitel|you\s*broadband|alliance\s*broadband|gtpl|tata\s*(communications|teleservices|play|sky|fiber)|comcast|xfinity|verizon|at&t|t-mobile|charter|spectrum|cox\s*comm|bt\s*group|british\s*telecom|virgin\s*media|sky\s*uk|rogers|bell\s*canada|telus|deutsche\s*telekom|orange|telefonica|ntt|softbank|kddi|optus|telstra|singtel|starhub)\b/i;

const VPN_ORG_REGEX = /\b(vpn|tor\s*exit|proxy|webproxy|socks|anonymiz|proton|mullvad|nordvpn|tefincom|surfshark|expressvpn|cyberghost|windscribe|tunnelbear|private\s*internet|hotspot\s*shield|psiphon|ultrasurf|betternet|hola\s*vpn|urban\s*vpn|adguard\s*vpn|m247|datacamp|cdn77|choopa|vultr|digitalocean|hetzner|ovh|linode|contabo|leaseweb|colocrossing|quadranet|frantech|buyvm|hostinger|kamatera|serverius|zenlayer|sharktech|tzulo|cloudflare\s*warp|scaleway|upcloud|ionos|privax|vyprvpn|strongvpn|purevpn|ipvanish|clouvider|bright\s*data|oxylabs|estnoc|hern\s*labs|realcloud|melbikomas|equinix|gcore|packethost|psychz|dedipath|ovpn|airvpn|torguard|hidemyass|astrill|ivacy|fastvpn|shinjiru|cinipac|blazing\s*seo|iproyal|stormproxies|smartproxy|webshare)\b/i;

// Catch-all datacenter/hosting org detector — matches orgs that look like hosting providers
// even if they're not in the explicit lists above (e.g. "HERN Labs AB", "Psychz Networks", etc.)
const DATACENTER_ORG_REGEX = /\b(labs?\s+ab|colocation|dedicated\s*servers?|server\s*farm|bare\s*metal|managed\s*server|cloud\s*(host|solutions?)|vps|ctrls|yotta|webwerks|netmagic|e2e\s*networks|rackbank|pi\s*datacenters)\b/i;

function isPrivateOrDevIp(ip) {
  const s = String(ip || '').trim().toLowerCase();
  if (!s || s === 'localhost' || s === 'local / unknown' || s === '::1') return true;
  if (s.startsWith('127.') || s.startsWith('10.') || s.startsWith('192.168.') || s.startsWith('169.254.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(s)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(s)) return true;
  if (s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80:')) return true;
  return false;
}

function summarizeEdgeUa(ua = '') {
  const s = String(ua || '');
  let os = 'Unknown Device';
  if (/Windows/i.test(s)) os = 'Windows';
  else if (/iPhone|iPad|iPod/i.test(s)) os = 'iOS';
  else if (/Android/i.test(s)) os = 'Android';
  else if (/Mac OS X|Macintosh/i.test(s)) os = 'macOS';
  else if (/Linux/i.test(s)) os = 'Linux';
  let browser = 'Browser';
  if (/Edg\//i.test(s)) browser = 'Edge';
  else if (/Chrome\//i.test(s) && !/Edg\//i.test(s)) browser = 'Chrome';
  else if (/Firefox\//i.test(s)) browser = 'Firefox';
  else if (/Safari\//i.test(s) && !/Chrome\//i.test(s)) browser = 'Safari';
  return `${os} · ${browser}`;
}

function escapeHtmlEdge(str) {
  return String(str || '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function detectEdgeVpn(req, clientIp) {
  const cf = req.cf || {};
  const asn = Number(cf.asn || req.headers.get('cf-as-number') || req.headers.get('x-asn') || 0);
  const asOrg = String(cf.asOrganization || cf.as_organization || req.headers.get('cf-as-organization') || '').trim();
  const country = String(cf.country || req.headers.get('cf-ipcountry') || '').toUpperCase();
  const city = String(cf.city || req.headers.get('cf-ipcity') || '').trim();
  const region = String(cf.region || req.headers.get('cf-region') || '').trim();
  const threatScore = Number(cf.threatScore || cf.threat_score || req.headers.get('cf-threat-score') || 0);

  if (!clientIp || isPrivateOrDevIp(clientIp) || ADMIN_OWN_IPS.includes(clientIp)) {
    return { isVpn: false, reason: '', asn, asOrg, country, city, region };
  }

  if (EXPLICIT_DDOS_BANNED_IPS.has(clientIp)) {
    return { isVpn: true, reason: 'Explicit DDoS Attack IP Banned', asn, asOrg, country, city, region };
  }



  // 1. Explicit proxy / VPN headers
  const via = String(req.headers.get('via') || '');
  if (
    req.headers.has('x-tor') ||
    req.headers.has('x-vpn') ||
    req.headers.has('x-proxy-id') ||
    req.headers.has('x-anonymizer') ||
    req.headers.has('forwarded-for-proxy') ||
    /\b(tor|vpn|webproxy|squid|privoxy|hola|psiphon)\b/i.test(via)
  ) {
    return { isVpn: true, reason: 'VPN / Proxy Header Detected', asn, asOrg, country, city, region };
  }

  // 2. Cloudflare threat score / Tor flags
  if (threatScore > 50) {
    return { isVpn: true, reason: `Cloudflare High Threat Flag (Score: ${threatScore})`, asn, asOrg, country, city, region };
  }
  if (country === 'T1' || country === 'A1' || country === 'A2') {
    return { isVpn: true, reason: `Tor / Anonymous Proxy Country Code (${country})`, asn, asOrg, country, city, region };
  }

  // 3. Known VPN & Datacenter ASN check
  if (!RESIDENTIAL_ISP_ALLOWLIST.test(asOrg)) {
    if (asn && KNOWN_VPN_ASNS.has(asn)) {
      return {
        isVpn: true,
        reason: `VPN / Proxy Network (AS${asn}${asOrg ? ' · ' + asOrg : ''})`,
        asn,
        asOrg,
        country,
        city,
        region
      };
    }
    if (asOrg && VPN_ORG_REGEX.test(asOrg)) {
      return {
        isVpn: true,
        reason: `VPN / Anonymizer Network (${asOrg})`,
        asn,
        asOrg,
        country,
        city,
        region
      };
    }
    if (asOrg && DATACENTER_ORG_REGEX.test(asOrg)) {
      return {
        isVpn: true,
        reason: `Datacenter / Hosting Network (${asOrg})`,
        asn,
        asOrg,
        country,
        city,
        region
      };
    }
  }

  return { isVpn: false, reason: '', asn, asOrg, country, city, region };
}

function makeEdgeForbiddenResponse(lowerPath, message, extra = {}) {
  // Pure 0-byte drop response with Connection: close
  // Completely eliminates Cloudflare bandwidth usage and triggers native browser "This site can't be reached" error screen
  return new Response(null, {
    status: 403,
    statusText: 'Forbidden',
    headers: {
      'Connection': 'close',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'
    }
  });
}

// ── DDoS Defense Thresholds: Multi-Tiered Intelligent Protection ──
const BURST_WINDOW_MS = 1000;          // 1-second burst inspection window
const BURST_MAX_REQS = 30;              // Maximum 30 non-API dynamic requests in 1 second
const RATE_WINDOW_MS = 60 * 1000;      // 60-second sliding inspection window
const MAX_REQUESTS_PER_WINDOW = 300;   // Max 300 requests in 60s
const BAN_DURATION_MS = 2 * 60 * 60 * 1000; // 2 hours temporary ban on violation

// Malicious scanning path triggers (common automated exploit scanners)
const SUSPICIOUS_PATTERNS = [
  /\/\.env/i,
  /\/wp-admin/i,
  /\/wp-login/i,
  /\/xmlrpc\.php/i,
  /\/\.git/i,
  /\/actuator/i,
  /\/swagger/i,
  /\/cgi-bin/i,
  /\/etc\/passwd/i,
  /\/phpinfo/i
];

function resolveMiddlewareD1(env) {
  if (!env || typeof env !== 'object') return null;
  const candidateKeys = [
    'DB', 'db', 'DATABASE', 'database', 'D1', 'd1',
    'careerfair', 'CAREERFAIR', 'careerfair_db', 'careerfair-db',
    'CAREERFAIR_DB', 'careerfairdb', 'CAREERFAIRDB',
    'career_fair', 'career-fair', 'CAREER_FAIR',
    'career_fair_db', 'career-fair-db', 'CAREER_FAIR_DB'
  ];
  for (const k of candidateKeys) {
    try {
      const val = env[k];
      if (val && typeof val === 'object' && typeof val.prepare === 'function') {
        return val;
      }
    } catch {}
  }
  return null;
}

function getEdgeClientIp(req) {
  const raw = req.headers.get('cf-connecting-ip')
    || (req.headers.get('x-forwarded-for') || '').split(',')[0]
    || req.headers.get('x-real-ip')
    || '';
  return raw.trim();
}

const FORCE_RECHECK_COOLDOWN = new Map(); // ip -> lastForceCheckMs

/**
 * Periodically sync security lists with D1 without querying on every single request.
 */
async function getEdgeSecurityCache(db, force = false) {
  const now = Date.now();
  if (!force && LAST_BLOCKED_FETCH_MS > 0 && now - LAST_BLOCKED_FETCH_MS < CACHE_TTL_MS) {
    return CACHED_SECURITY_STATE;
  }

  if (!db) return CACHED_SECURITY_STATE;

  try {
    const rows = await db
      .prepare("SELECT k, v FROM kv WHERE k IN ('banned_ips', 'admin_blocked_ips', 'vpn_allowlist_ips', 'admin_devices')")
      .all();
    const blockedSet = new Set();
    const allowlistSet = new Set();
    const adminDevicesSet = new Set();

    for (const row of (rows?.results || [])) {
      if (!row?.v) continue;
      try {
        const parsed = JSON.parse(row.v);
        if (row.k === 'vpn_allowlist_ips' && Array.isArray(parsed)) {
          for (const ip of parsed) {
            const clean = typeof ip === 'string' ? ip.trim() : '';
            if (clean) allowlistSet.add(clean);
          }
        } else if (row.k === 'admin_devices' && Array.isArray(parsed)) {
          for (const dev of parsed) {
            const clean = typeof dev?.ip === 'string' ? dev.ip.trim() : '';
            if (clean) adminDevicesSet.add(clean);
          }
        } else if (Array.isArray(parsed)) {
          for (const ip of parsed) {
            const clean = typeof ip === 'string' ? ip.trim() : '';
            if (clean) blockedSet.add(clean);
          }
        }
      } catch {}
    }

    // Admin devices and allowlisted IPs must NEVER be blocked or rate-limited
    for (const ip of ADMIN_OWN_IPS) {
      blockedSet.delete(ip);
      allowlistSet.add(ip);
      VPN_BANNED_IPS.delete(ip);
      AUTO_BANNED_IPS.delete(ip);
      IP_RATE_LIMITS.delete(ip);
    }
    for (const ip of allowlistSet) {
      blockedSet.delete(ip);
      VPN_BANNED_IPS.delete(ip);
      AUTO_BANNED_IPS.delete(ip);
      IP_RATE_LIMITS.delete(ip);
    }
    for (const ip of adminDevicesSet) {
      blockedSet.delete(ip);
      VPN_BANNED_IPS.delete(ip);
      AUTO_BANNED_IPS.delete(ip);
      IP_RATE_LIMITS.delete(ip);
    }

    // One-time self-healing: selectively unban admin's own IPs only — never wipe all banned IPs
    if (!HAS_CLEANED_BANS_IN_D1) {
      HAS_CLEANED_BANS_IN_D1 = true;
      try {
        // Selectively remove only the admin's known IPs from the ban lists
        const ADMIN_OWN_IPS = [];
        const rawBanned = await db.prepare("SELECT v FROM kv WHERE k='banned_ips'").first('v');
        const rawBf     = await db.prepare("SELECT v FROM kv WHERE k='brute_force_bans'").first('v');
        let bannedArr = [];
        let bfObj = {};
        try { bannedArr = JSON.parse(rawBanned || '[]'); } catch {}
        try { bfObj = JSON.parse(rawBf || '{}'); } catch {}
        // Remove only admin IPs, leave all other bans intact
        const cleanedBanned = bannedArr.filter(ip => !ADMIN_OWN_IPS.includes(String(ip || '').trim()));
        for (const ip of ADMIN_OWN_IPS) { delete bfObj[ip]; }
        await db.prepare("INSERT INTO kv (k,v) VALUES ('banned_ips',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
          .bind(JSON.stringify(cleanedBanned)).run();
        await db.prepare("INSERT INTO kv (k,v) VALUES ('brute_force_bans',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
          .bind(JSON.stringify(bfObj)).run();
        // Also clear live_visitors banned flag only for admin IPs
        for (const ip of ADMIN_OWN_IPS) {
          await db.prepare("UPDATE live_visitors SET is_banned=0, is_vpn=0 WHERE ip=?").bind(ip).run();
        }
      } catch {}
    }

    CACHED_SECURITY_STATE = { blockedSet, allowlistSet, adminDevicesSet };
    LAST_BLOCKED_FETCH_MS = now;
  } catch {
    // Fail silently, keep existing cached sets
  }
  return CACHED_SECURITY_STATE;
}

/**
 * Persist an edge-detected VPN ban and visitor telemetry row to D1 asynchronously.
 */
async function persistEdgeVpnBan(db, clientIp, vpnInfo, request, pathname) {
  if (!db || !clientIp) return;
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`).run();
    await db.prepare(
      `CREATE TABLE IF NOT EXISTS live_visitors (
        ip TEXT PRIMARY KEY,
        country TEXT DEFAULT '',
        city TEXT DEFAULT '',
        region TEXT DEFAULT '',
        asn INTEGER DEFAULT 0,
        isp TEXT DEFAULT '',
        device TEXT DEFAULT '',
        current_path TEXT DEFAULT '/',
        active_tab TEXT DEFAULT 'overview',
        hits INTEGER DEFAULT 1,
        is_vpn INTEGER DEFAULT 0,
        vpn_reason TEXT DEFAULT '',
        is_banned INTEGER DEFAULT 0,
        is_admin INTEGER DEFAULT 0,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
      )`
    ).run();

    const now = Date.now();
    const deviceLabel = summarizeEdgeUa(request.headers.get('user-agent') || '');
    const rows = await db
      .prepare("SELECT k, v FROM kv WHERE k IN ('banned_ips', 'brute_force_bans', 'vpn_allowlist_ips', 'admin_devices')")
      .all();
    let banned = [];
    let bfBans = {};
    let allowlist = [];
    let adminDevices = [];
    for (const r of (rows?.results || [])) {
      if (!r?.v) continue;
      try {
        const parsed = JSON.parse(r.v);
        if (r.k === 'banned_ips' && Array.isArray(parsed)) banned = parsed;
        if (r.k === 'brute_force_bans' && parsed && typeof parsed === 'object') bfBans = parsed;
        if (r.k === 'vpn_allowlist_ips' && Array.isArray(parsed)) allowlist = parsed;
        if (r.k === 'admin_devices' && Array.isArray(parsed)) adminDevices = parsed;
      } catch {}
    }

    if (allowlist.includes(clientIp)) {
      return;
    }

    if (adminDevices.some(d => d && d.ip === clientIp)) {
      const cleanedDevices = adminDevices.filter(d => d && d.ip !== clientIp);
      await db.prepare(`INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`)
        .bind('admin_devices', JSON.stringify(cleanedDevices))
        .run();
    }

    try {
      const sessRows = await db.prepare("SELECT k, v FROM kv WHERE k LIKE 'admin_sess_%'").all();
      for (const sr of (sessRows?.results || [])) {
        if (!sr?.k || !sr?.v) continue;
        try {
          const parsed = JSON.parse(sr.v);
          if (parsed && String(parsed.ip || '').trim() === clientIp) {
            await db.prepare('DELETE FROM kv WHERE k = ?').bind(sr.k).run();
          }
        } catch {}
      }
    } catch {}

    if (!banned.includes(clientIp)) {
      banned.push(clientIp);
      await db.prepare(`INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`)
        .bind('banned_ips', JSON.stringify(banned))
        .run();
    }

    bfBans[clientIp] = {
      reason: vpnInfo.reason || 'VPN / Proxy Detected',
      attempts: (bfBans[clientIp]?.attempts || 0) + 1,
      banned_at: bfBans[clientIp]?.banned_at || now,
      device: deviceLabel,
      vpn: true
    };
    await db.prepare(`INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`)
      .bind('brute_force_bans', JSON.stringify(bfBans))
      .run();

    try {
      let banTimestamps = {};
      const btRow = await db.prepare("SELECT v FROM kv WHERE k = 'banned_ip_timestamps'").first();
      if (btRow?.v) {
        try { banTimestamps = JSON.parse(btRow.v); } catch {}
      }
      if (!banTimestamps[clientIp]) {
        banTimestamps[clientIp] = now;
        await db.prepare(`INSERT INTO kv (k, v) VALUES ('banned_ip_timestamps', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`)
          .bind(JSON.stringify(banTimestamps))
          .run();
      }
    } catch {}

    await db.prepare(
      `INSERT INTO live_visitors (ip, country, city, region, asn, isp, device, current_path, active_tab, hits, is_vpn, vpn_reason, is_banned, is_admin, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'blocked', 1, 1, ?, 1, 0, ?, ?)
       ON CONFLICT(ip) DO UPDATE SET
         country = CASE WHEN excluded.country != '' THEN excluded.country ELSE live_visitors.country END,
         city = CASE WHEN excluded.city != '' THEN excluded.city ELSE live_visitors.city END,
         region = CASE WHEN excluded.region != '' THEN excluded.region ELSE live_visitors.region END,
         asn = CASE WHEN excluded.asn > 0 THEN excluded.asn ELSE live_visitors.asn END,
         isp = CASE WHEN excluded.isp != '' THEN excluded.isp ELSE live_visitors.isp END,
         device = excluded.device,
         current_path = excluded.current_path,
         hits = live_visitors.hits + 1,
         is_vpn = 1,
         vpn_reason = excluded.vpn_reason,
         is_banned = 1,
         is_admin = 0,
         last_seen = excluded.last_seen`
    ).bind(
      clientIp,
      vpnInfo.country || '',
      vpnInfo.city || '',
      vpnInfo.region || '',
      Number(vpnInfo.asn || 0),
      vpnInfo.asOrg || '',
      deviceLabel,
      String(pathname || '/').slice(0, 120),
      String(vpnInfo.reason || 'VPN / Proxy Detected').slice(0, 200),
      now,
      now
    ).run();
  } catch {}
}

export async function onRequest(context) {
  const { request, env, next } = context;

  // Never block CORS preflight
  if (request.method === 'OPTIONS') {
    return next();
  }

  const clientIp = getEdgeClientIp(request);
  const url = new URL(request.url);
  const pathname = url.pathname;
  const lowerPath = pathname.toLowerCase();

  const now = Date.now();

  if (clientIp) {
    const db = resolveMiddlewareD1(env);
    if (FORCE_RECHECK_COOLDOWN.size > 2000) FORCE_RECHECK_COOLDOWN.clear();
    let secState = await getEdgeSecurityCache(db);
    const isAdminIp = ADMIN_OWN_IPS.includes(clientIp);
    const isAdminDevice = isAdminIp || Boolean(secState.adminDevicesSet && secState.adminDevicesSet.has(clientIp));
    const isAllowlisted = isAdminIp || Boolean(secState.allowlistSet && secState.allowlistSet.has(clientIp)) || isAdminDevice;

    if (isAllowlisted) {
      AUTO_BANNED_IPS.delete(clientIp);
      VPN_BANNED_IPS.delete(clientIp);
      IP_RATE_LIMITS.delete(clientIp);
      const { net: kNet, sub: kSub } = getSubnetKeys(clientIp);

    }

    // Periodic cleanup of expired auto-bans
    if (AUTO_BANNED_IPS.size > 500) {
      for (const [bIp, exp] of AUTO_BANNED_IPS.entries()) {
        if (now >= exp) AUTO_BANNED_IPS.delete(bIp);
      }
    }
    if (VPN_BANNED_IPS.size > 2000) {
      VPN_BANNED_IPS.clear();
    }

    // ─────────────────────────────────────────────────────────────
    // 1. FAST-DROP: Check Explicit DDoS Banned IPs & Auto-Bans
    // ─────────────────────────────────────────────────────────────
    if (EXPLICIT_DDOS_BANNED_IPS.has(clientIp)) {
      return makeEdgeForbiddenResponse(lowerPath, "Explicit DDoS Attacker IP Blocked", { ip: clientIp });
    }

    if (!isAllowlisted) {
      // 1A. Check Individual IP Auto-Ban
      const autoBanUntil = AUTO_BANNED_IPS.get(clientIp);
      if (autoBanUntil) {
        if (now < autoBanUntil) {
          return new Response(null, {
            status: 429,
            statusText: "Too Many Requests - DDoS Protection Triggered",
            headers: {
              "Connection": "close",
              "Retry-After": "7200",
              "Cache-Control": "no-store",
              "X-DDoS-Protection": "Auto-Banned"
            }
          });
        } else {
          AUTO_BANNED_IPS.delete(clientIp);
        }
      }
    }

    // ─────────────────────────────────────────────────────────────
    // 2. SCANNER / PROBE TRAP: Immediate Drop
    // ─────────────────────────────────────────────────────────────
    const isScanner = !isAllowlisted && SUSPICIOUS_PATTERNS.some(pat => pat.test(lowerPath));
    if (isScanner) {
      AUTO_BANNED_IPS.set(clientIp, now + BAN_DURATION_MS);
      return new Response(null, {
        status: 403,
        statusText: "Forbidden",
        headers: { "Connection": "close", "Cache-Control": "no-store" }
      });
    }

    const STATIC_EXTS = [
      '.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico',
      '.woff', '.woff2', '.ttf', '.eot',
      '.mp3', '.wav', '.mp4',
      '.css', '.js', '.mjs', '.json', '.map', '.webmanifest',
      '.pdf', '.txt', '.xml'
    ];
    const isStaticAsset = STATIC_EXTS.some(ext => lowerPath.endsWith(ext));

    // ─────────────────────────────────────────────────────────────
    // 3. PERSISTENT BAN & INSTANT EDGE VPN / PROXY SHIELD
    // ─────────────────────────────────────────────────────────────
    // Must inspect ALL requests (including HTML, JS, CSS, images, and API) so banned IPs get 0 bytes
    const vpnInfo = (!isAllowlisted && !isPrivateOrDevIp(clientIp))
      ? detectEdgeVpn(request, clientIp)
      : { isVpn: false, reason: '', asn: 0, asOrg: '', country: '', city: '', region: '' };
    const maybeNeedsDeny = !isAllowlisted && (secState.blockedSet.has(clientIp) || VPN_BANNED_IPS.has(clientIp) || vpnInfo.isVpn);

    if (db && maybeNeedsDeny && (now - (FORCE_RECHECK_COOLDOWN.get(clientIp) || 0)) >= 1500) {
      FORCE_RECHECK_COOLDOWN.set(clientIp, now);
      secState = await getEdgeSecurityCache(db, true);
    }

    if (!isAllowlisted && secState.blockedSet.has(clientIp)) {
      return makeEdgeForbiddenResponse(
        lowerPath,
        `Access Denied: Your IP address (${clientIp}) has been restricted across this site.`
      );
    }

    const isExemptFromAutoVpn = isAllowlisted || secState.allowlistSet.has(clientIp);
    if (!isExemptFromAutoVpn && !isPrivateOrDevIp(clientIp)) {
      const memVpnBan = VPN_BANNED_IPS.get(clientIp);
      if (memVpnBan) {
        return makeEdgeForbiddenResponse(
          lowerPath,
          `Access Denied: VPN / Proxy / Tor usage is strictly prohibited (${memVpnBan.reason}). Your IP (${clientIp}) has been banned.`,
          { vpn_banned: true, vpn_reason: memVpnBan.reason }
        );
      }

      if (vpnInfo.isVpn) {
        VPN_BANNED_IPS.set(clientIp, { reason: vpnInfo.reason, bannedAt: now });
        secState.blockedSet.add(clientIp);
        const persistPromise = persistEdgeVpnBan(db, clientIp, vpnInfo, request, pathname);
        if (typeof context.waitUntil === 'function') {
          context.waitUntil(persistPromise);
        } else {
          try { await persistPromise; } catch {}
        }
        return makeEdgeForbiddenResponse(
          lowerPath,
          `Access Denied: VPN / Proxy / Datacenter usage is strictly prohibited on this site (${vpnInfo.reason}). Your IP (${clientIp}) has been banned immediately.`,
          { vpn_banned: true, vpn_reason: vpnInfo.reason }
        );
      }
    }

    // ─────────────────────────────────────────────────────────────
    // 4. DDoS RATE LIMITER (Individual Client Burst & Sustained)
    // ─────────────────────────────────────────────────────────────
    // Admin devices and allowlisted IPs are completely exempt from DDoS rate limits
    if (!isStaticAsset && !isAllowlisted) {
      // 4D. Individual Client IP Burst & Sustained Rate Limits
      const method = (request.method || 'GET').toUpperCase();
      const isApiRequest = lowerPath.startsWith('/api/');
      const BOOT_READ_PATHS = new Set(['/api/config', '/api/scores', '/api/feedback', '/api/admin/user-title']);
      const isBootRead = (method === 'GET' || method === 'HEAD') && BOOT_READ_PATHS.has(lowerPath);
      
      const BURST_MAX = BURST_MAX_REQS;
      const API_BURST_MAX = API_BURST_MAX_REQS;
      const BOOT_READ_MAX_PER_WINDOW = 300;

      let tracker = IP_RATE_LIMITS.get(clientIp);
      if (!tracker) {
        tracker = {
          count: 0,
          resetAt: now + RATE_WINDOW_MS,
          burstCount: 0,
          burstResetAt: now + BURST_WINDOW_MS,
          apiBurstCount: 0,
          apiBurstResetAt: now + BURST_WINDOW_MS,
          bootCount: 0,
          bootResetAt: now + RATE_WINDOW_MS
        };
        IP_RATE_LIMITS.set(clientIp, tracker);
      }

      const bumpWindow = (countKey, resetKey, windowMs) => {
        if (now > tracker[resetKey]) {
          tracker[countKey] = 1;
          tracker[resetKey] = now + windowMs;
        } else {
          tracker[countKey] = (tracker[countKey] || 0) + 1;
        }
        return tracker[countKey];
      };

      const makeDdosBanResponse = (message, statusText, extraHeader) => {
        AUTO_BANNED_IPS.set(clientIp, now + BAN_DURATION_MS);
        const headers = {
          "Content-Type": "application/json",
          "Connection": "close",
          "Retry-After": "7200",
          "Cache-Control": "no-store"
        };
        if (extraHeader) headers["X-DDoS-Protection"] = extraHeader;
        return new Response(
          JSON.stringify({ error: message, retry_after_seconds: 7200 }),
          { status: 429, statusText, headers }
        );
      };

      // --- 4E. INSTANT 1-SECOND BURST CHECK ---
      if (!isApiRequest) {
        if (bumpWindow('burstCount', 'burstResetAt', BURST_WINDOW_MS) > BURST_MAX) {
          return makeDdosBanResponse(
            `DDoS Attack Blocked: Exceeded rate limit (>${BURST_MAX} requests in 1 second). Your device IP and subnet have been banned temporarily.`,
            "Too Many Requests - DDoS Burst Ban",
            "Burst-Triggered"
          );
        }
      } else if (!isBootRead) {
        if (bumpWindow('apiBurstCount', 'apiBurstResetAt', BURST_WINDOW_MS) > API_BURST_MAX) {
          return makeDdosBanResponse(
            `DDoS Attack Blocked: Exceeded API burst limit (>${API_BURST_MAX} requests in 1 second). Your device IP and subnet have been banned immediately.`,
            "Too Many Requests - DDoS Burst Ban",
            "Burst-Triggered"
          );
        }
      }

      // --- 4F. SUSTAINED 60-SECOND WINDOW CHECK ---
      if (isBootRead) {
        if (bumpWindow('bootCount', 'bootResetAt', RATE_WINDOW_MS) > BOOT_READ_MAX_PER_WINDOW) {
          return makeDdosBanResponse(
            "DDoS Protection Triggered: Exceeded sustained boot request limit. Your device IP has been banned.",
            "Too Many Requests",
            null
          );
        }
      } else if (bumpWindow('count', 'resetAt', RATE_WINDOW_MS) > MAX_REQUESTS_PER_WINDOW) {
        return makeDdosBanResponse(
          "DDoS Protection Triggered: Exceeded 300 requests in 60 seconds. Your device IP has been banned temporarily.",
          "Too Many Requests",
          null
        );
      }

      // Periodic cleanup to avoid memory leak
      if (IP_RATE_LIMITS.size > 2000) {
        for (const [ipKey, entry] of IP_RATE_LIMITS.entries()) {
          if (now > entry.resetAt && now > entry.burstResetAt && now > (entry.apiBurstResetAt || 0) && now > (entry.bootResetAt || 0)) {
            IP_RATE_LIMITS.delete(ipKey);
          }
        }
      }

    }
  }

  return next();
}
