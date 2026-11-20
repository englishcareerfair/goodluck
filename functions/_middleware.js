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

const UNBANNED_IPS = new Set([
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
  9009,   // M247 (NordVPN, Surfshark, Proton, Mullvad, PIA, CyberGhost)
  60068,  // Datacamp Limited / CDN77
  212238, // Datacamp Limited
  136787, // Tefincom S.A. (NordVPN)
  209103, // Proton AG
  211298, // Proton AG
  39351,  // 31173 Services AB (Mullvad)
  198093, // 31173 Services AB (Mullvad)
  397723, // Mullvad
  209854, // Surfshark
  209446, // Surfshark / Proxy egress
  199610, // CyberGhost / Virtual1
  396356, // TunnelBear / McAfee VPN
  62041,  // Privax / HideMyAss
  397423, // Kape Technologies (PIA / CyberGhost / ExpressVPN)
  46562,  // Total Server Solutions / PIA
  394711, // ExpressVPN
  33438,  // Highwinds / StackPath / IPVanish
  39572,  // NetProtect / IPVanish
  208323, // Windscribe
  398493, // Windscribe
  202425, // WorldStream
  206238, // FlokiNET
  44907,  // Private Layer
  49981,  // WorldStream
  53667,  // FranTech / BuyVM
  60781,  // Leaseweb Netherlands
  28753,  // Leaseweb Germany
  14061,  // DigitalOcean
  20473,  // The Constant Company / Choopa / Vultr
  24940,  // Hetzner Online
  16276,  // OVH SAS
  63949,  // Akamai Connected Cloud / Linode
  51167,  // Contabo
  31898,  // Oracle Cloud
  16509,  // Amazon AWS
  14618,  // Amazon AES
  8075,   // Microsoft Azure
  45102,  // Alibaba Cloud
  132203, // Tencent Cloud
  396982, // Google Cloud
  47583,  // Hostinger International
  36352,  // ColoCrossing
  8100,   // QuadraNet
  36007,  // Kamatera
  50673,  // Serverius
  46844,  // Sharktech
  11878,  // Tzulo
  21859,  // Zenlayer
  12876,  // Scaleway
  202053, // UpCloud
  8560,   // IONOS
  398324, // Censys / Scanner Cloud
  204957, // BrightData / Hola Networks
  62240,  // Clouvider
  205016, // HERN Labs AB (datacenter/hosting)
  174,    // Cogent Communications (transit/datacenter)
  1299,   // Telia Company AB (transit)
  3257,   // GTT Communications (transit/datacenter)
  6939,   // Hurricane Electric (tunnel broker/datacenter)
  13335,  // Cloudflare (WARP VPN / proxy)
  32934,  // Facebook/Meta (not residential)
  15169,  // Google (non-consumer)
  2906,   // Netflix (non-residential)
  20940,  // Akamai Technologies (CDN/datacenter)
  22822,  // Limelight Networks
  54113,  // Fastly
  209242, // Cloudflare Spectrum / WARP
  34665,  // Digital Network JSC (proxy egress)
  35913,  // DediPath (hosting)
  40676,  // Psychz Networks (datacenter)
  25820,  // IT7 Networks (datacenter)
  7489,   // Hostus (datacenter)
  26347,  // DreamHost (hosting)
  32613,  // Iweb Technologies (datacenter)
  36236,  // NetActuate (hosting)
  53755,  // Enzu Inc (datacenter)
  200019, // Cherry Servers (datacenter)
  210558, // Pacific Internet Exchange (datacenter)
  138915, // Kaopu Cloud HK (datacenter)
  135377, // UCLOUD (datacenter)
  58466,  // CHINANET Yunnan (datacenter)
  3214,   // xTom GmbH (datacenter)
  34927,  // iFog GmbH (datacenter)
  210320, // Greencloud (datacenter)
  206264, // Amarutu Technology Ltd (datacenter)
  43350,  // NForce Entertainment (datacenter/hosting)
  35017,  // Swisscolocation (datacenter)
  51852,  // Private Layer Inc (VPN)
  57169,  // HZ Hosting (datacenter)
  61317,  // Digital Realty / Interxion
  199524, // G-Core Labs (datacenter)
  47447,  // 23M GmbH (datacenter)
  9009,   // M247 Europe SRL
  198047, // Ihor Hosting (datacenter)
  60781,  // LeaseWeb
  147049, // HOSTKEY (datacenter)
  206804, // EstNOC Global / Realcloud OU (datacenter/VPN)
  200052, // Realcloud OU
  208447, // OVPN
  54888,  // Equinix / PacketHost
  213230, // Hetzner Online
  35540,  // OVH SAS
  202685, // Hostinger
  59253,  // Leaseweb Asia
  49392,  // Datagroup
  44558,  // Serverius
  212531, // Quickpacket
  55286,  // ServerMania
  206499, // Melbikomas UAB
  42831,  // UK Dedicated Servers
  204655, // HostRoyale
  207083, // Hostinger
  62371,  // Proton AG (core routing)
  199218, // Proton AG (ProtonVPN-2)
  208172, // Proton AG
  206774, // Proton AG
  208534, // Proton AG
  202422  // Feral Hosting / Proton partner
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

  if (!clientIp || isPrivateOrDevIp(clientIp) || ADMIN_OWN_IPS.includes(clientIp) || UNBANNED_IPS.has(clientIp)) {
    return { isVpn: false, reason: '', asn, asOrg, country, city, region };
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
        // Remove admin IPs and explicitly unbanned IPs, leave all other bans intact
        const unbanList = [...ADMIN_OWN_IPS, ...Array.from(UNBANNED_IPS)];
        const cleanedBanned = bannedArr.filter(ip => !unbanList.includes(String(ip || '').trim()));
        for (const ip of unbanList) { delete bfObj[ip]; }
        await db.prepare("INSERT INTO kv (k,v) VALUES ('banned_ips',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
          .bind(JSON.stringify(cleanedBanned)).run();
        await db.prepare("INSERT INTO kv (k,v) VALUES ('brute_force_bans',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
          .bind(JSON.stringify(bfObj)).run();
        // Also clear live_visitors banned flag for unbanned IPs
        for (const ip of unbanList) {
          await db.prepare("UPDATE live_visitors SET is_banned=0, is_vpn=0 WHERE ip=?").bind(ip).run();
        }
      } catch {}
    }

    for (const uIp of UNBANNED_IPS) {
      blockedSet.delete(uIp);
      AUTO_BANNED_IPS.delete(uIp);
      VPN_BANNED_IPS.delete(uIp);
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
    // 1. FAST-DROP: Check Auto-Bans
    // ─────────────────────────────────────────────────────────────

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
