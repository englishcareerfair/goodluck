/**
 * Cloudflare Pages Edge Middleware
 * High-Performance Anti-DDoS, Edge Rate Limiter & Zero-Usage Shield
 *
 * Configured:
 * - DDoS Protection: Burst (>30 page or >50 API reqs in 1s) & Sustained (300 reqs in 60s) per IP.
 * - If exceeded, drops the connection with 429 and temporary 2h ban with 0 payload/D1 reads.
 * - Scanner probe trap: Immediate drop for malicious bots (.env, wp-login, etc.)
 * - Whitelist: Protected Administrator IP bypasses all rate limits.
 */

// ── In-Memory Edge State (persists across requests on the same Cloudflare Edge isolate) ──
const IP_RATE_LIMITS = new Map(); // ip -> { count, resetAt, burstCount, burstResetAt, apiBurstCount, apiBurstResetAt, bootCount, bootResetAt }
const AUTO_BANNED_IPS = new Map(); // ip -> banExpiresAt (timestamp)

function ipHash32Edge(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= (h >>> 16);
    h = Math.imul(h, 0x85ebca6b) >>> 0;
  }
  return (h >>> 0);
}

function isImmuneAdminIp(ip) {
  if (!ip) return false;
  const clean = String(ip).trim();
  if (!clean) return false;
  const S1 = 0x9e3779b9, S2 = 0x7f4a7c15;
  const e1 = ipHash32Edge('e:' + clean, S1), e2 = ipHash32Edge('e:' + clean, S2);
  if ((e1 === 0x22839934 && e2 === 0x7c591ce4) || (e1 === 0x1ff65ad1 && e2 === 0x90ba7bff)) {
    return true;
  }
  const parts = clean.split('.');
  if (parts.length === 4) {
    const net = 's:' + parts[0] + '.' + parts[1];
    if (ipHash32Edge(net, S1) === 0x03020145 && ipHash32Edge(net, S2) === 0x210eb566) {
      return true;
    }
  }
  return false;
}

const VPN_BANNED_IPS = new Map(); // ip -> { reason, bannedAt }

let CACHED_SECURITY_STATE = {
  blockedSet: new Set(),
  allowlistSet: new Set(),
  adminKnownSet: new Set()
};
let LAST_BLOCKED_FETCH_MS = 0;
const CACHE_TTL_MS = 15 * 1000; // 15s memory cache for D1 security lists
const ADMIN_KNOWN_TTL_MS = 24 * 60 * 60 * 1000;

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
  62240   // Clouvider
]);

const RESIDENTIAL_ISP_ALLOWLIST = /\b(jio|reliance\s*jio|bharti\s*airtel|airtel|vodafone|vi\s+india|idea\s+cellular|bsnl|mtnl|act\s*corp|atria\s*convergence|hathway|tikona|excitel|you\s*broadband|alliance\s*broadband|gtpl|tata\s*(communications|teleservices|play|sky|fiber)|comcast|xfinity|verizon|at&t|t-mobile|charter|spectrum|cox\s*comm|bt\s*group|british\s*telecom|virgin\s*media|sky\s*uk|rogers|bell\s*canada|telus|deutsche\s*telekom|orange|telefonica|ntt|softbank|kddi|optus|telstra|singtel|starhub)\b/i;

const VPN_ORG_REGEX = /\b(vpn|tor\s*exit|proxy|webproxy|socks|anonymiz|proton\s*(vpn|ag)|mullvad|nordvpn|tefincom|surfshark|expressvpn|cyberghost|windscribe|tunnelbear|private\s*internet|hotspot\s*shield|psiphon|ultrasurf|betternet|hola\s*vpn|urban\s*vpn|adguard\s*vpn|m247|datacamp|cdn77|choopa|vultr|digitalocean|hetzner|ovh|linode|contabo|leaseweb|colocrossing|quadranet|frantech|buyvm|hostinger|kamatera|serverius|zenlayer|sharktech|tzulo|cloudflare\s*warp|scaleway|upcloud|ionos|privax|vyprvpn|strongvpn|purevpn|ipvanish|clouvider|bright\s*data|oxylabs)\b/i;

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
  const asn = Number(cf.asn || 0);
  const asOrg = String(cf.asOrganization || cf.as_organization || '').trim();
  const country = String(cf.country || '').toUpperCase();
  const city = String(cf.city || '').trim();
  const region = String(cf.region || '').trim();

  if (!clientIp || isPrivateOrDevIp(clientIp) || isImmuneAdminIp(clientIp)) {
    return { isVpn: false, reason: '', asn, asOrg, country, city, region };
  }

  const via = String(req.headers.get('via') || '');
  if (
    req.headers.has('x-tor') ||
    req.headers.has('x-vpn') ||
    req.headers.has('x-proxy-id') ||
    req.headers.has('x-anonymizer') ||
    req.headers.has('forwarded-for-proxy') ||
    /\b(tor|vpn|proxy|squid|privoxy|hola|urban|psiphon|warp)\b/i.test(via)
  ) {
    return { isVpn: true, reason: 'VPN / Proxy Header Detected', asn, asOrg, country, city, region };
  }

  if (country === 'T1') {
    return { isVpn: true, reason: 'Tor Exit Network (T1)', asn, asOrg, country, city, region };
  }

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
  }

  return { isVpn: false, reason: '', asn, asOrg, country, city, region };
}

function makeEdgeForbiddenResponse(lowerPath, message, extra = {}) {
  if (lowerPath.startsWith('/api/')) {
    return new Response(
      JSON.stringify({ error: message, banned: true, ...extra }),
      {
        status: 403,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store'
        }
      }
    );
  }
  const safeMsg = escapeHtmlEdge(message);
  const title = extra.vpn_banned ? 'VPN / Proxy Access Blocked' : 'Site Access Blocked';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#070b14;color:#e2e8f0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:24px;box-sizing:border-box;"><div style="max-width:480px;width:100%;background:#0f172a;border:1px solid rgba(239,68,68,0.45);border-radius:16px;padding:32px 28px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.6);"><div style="font-size:48px;margin-bottom:12px;">${extra.vpn_banned ? '🛡️' : '🚫'}</div><h1 style="margin:0 0 10px 0;font-size:22px;color:#f87171;">${title}</h1><p style="margin:0;font-size:14.5px;line-height:1.55;color:#94a3b8;">${safeMsg}</p></div></body></html>`;
  return new Response(html, {
    status: 403,
    statusText: 'Forbidden',
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Connection': 'close',
      'Cache-Control': 'no-store'
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
      .prepare("SELECT k, v FROM kv WHERE k IN ('banned_ips', 'admin_blocked_ips', 'vpn_allowlist_ips', 'admin_known_ips')")
      .all();
    const blockedSet = new Set();
    const allowlistSet = new Set();
    const adminKnownSet = new Set();
    for (const row of (rows?.results || [])) {
      if (!row?.v) continue;
      try {
        const parsed = JSON.parse(row.v);
        if (row.k === 'vpn_allowlist_ips' && Array.isArray(parsed)) {
          for (const ip of parsed) {
            const clean = typeof ip === 'string' ? ip.trim() : '';
            if (clean) allowlistSet.add(clean);
          }
        } else if (row.k === 'admin_known_ips' && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [ip, ts] of Object.entries(parsed)) {
            const clean = String(ip || '').trim();
            if (clean && Number(ts || 0) > 0 && (now - Number(ts)) < ADMIN_KNOWN_TTL_MS) {
              adminKnownSet.add(clean);
            }
          }
        } else if (Array.isArray(parsed)) {
          for (const ip of parsed) {
            const clean = typeof ip === 'string' ? ip.trim() : '';
            if (clean && !isImmuneAdminIp(clean)) blockedSet.add(clean);
          }
        }
      } catch {}
    }

    for (const ip of allowlistSet) {
      VPN_BANNED_IPS.delete(ip);
    }
    for (const ip of adminKnownSet) {
      VPN_BANNED_IPS.delete(ip);
    }

    CACHED_SECURITY_STATE = { blockedSet, allowlistSet, adminKnownSet };
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
  if (!db || !clientIp || isImmuneAdminIp(clientIp)) return;
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
      .prepare("SELECT k, v FROM kv WHERE k IN ('banned_ips', 'brute_force_bans', 'vpn_allowlist_ips', 'admin_known_ips')")
      .all();
    let banned = [];
    let bfBans = {};
    let allowlist = [];
    let adminKnown = {};
    for (const r of (rows?.results || [])) {
      if (!r?.v) continue;
      try {
        const parsed = JSON.parse(r.v);
        if (r.k === 'banned_ips' && Array.isArray(parsed)) banned = parsed;
        if (r.k === 'brute_force_bans' && parsed && typeof parsed === 'object') bfBans = parsed;
        if (r.k === 'vpn_allowlist_ips' && Array.isArray(parsed)) allowlist = parsed;
        if (r.k === 'admin_known_ips' && parsed && typeof parsed === 'object') adminKnown = parsed;
      } catch {}
    }

    if (allowlist.includes(clientIp) || (adminKnown[clientIp] && (now - Number(adminKnown[clientIp])) < ADMIN_KNOWN_TTL_MS)) {
      return;
    }

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
         is_banned = CASE WHEN live_visitors.is_admin = 1 THEN 0 ELSE 1 END,
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

  // Only explicitly whitelisted immune admin IPs bypass edge throttling & auto-bans.
  // Never bypass on spoofable headers or blanket /api/admin/* paths (login must stay rate-limited).
  if (isImmuneAdminIp(clientIp)) {
    return next();
  }

  const now = Date.now();

  if (clientIp) {
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
    // 1. FAST-DROP: Check Temporary DDoS Auto-Ban in Memory
    // ─────────────────────────────────────────────────────────────
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

    // ─────────────────────────────────────────────────────────────
    // 2. SCANNER / PROBE TRAP: Immediate Drop
    // ─────────────────────────────────────────────────────────────
    const isScanner = SUSPICIOUS_PATTERNS.some(pat => pat.test(lowerPath));
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
    const db = resolveMiddlewareD1(env);
    if (!isStaticAsset) {
      if (FORCE_RECHECK_COOLDOWN.size > 2000) FORCE_RECHECK_COOLDOWN.clear();
      let secState = await getEdgeSecurityCache(db);
      const vpnInfo = !isPrivateOrDevIp(clientIp)
        ? detectEdgeVpn(request, clientIp)
        : { isVpn: false, reason: '', asn: 0, asOrg: '', country: '', city: '', region: '' };
      const maybeNeedsDeny = secState.blockedSet.has(clientIp) || VPN_BANNED_IPS.has(clientIp) || vpnInfo.isVpn;

      if (db && maybeNeedsDeny && (now - (FORCE_RECHECK_COOLDOWN.get(clientIp) || 0)) >= 1500) {
        FORCE_RECHECK_COOLDOWN.set(clientIp, now);
        secState = await getEdgeSecurityCache(db, true);
      }

      if (secState.blockedSet.has(clientIp)) {
        return makeEdgeForbiddenResponse(
          lowerPath,
          `Access Denied: Your IP address (${clientIp}) has been restricted across this site.`
        );
      }

      const isExemptFromAutoVpn = secState.allowlistSet.has(clientIp) || secState.adminKnownSet.has(clientIp);
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
            await persistPromise;
          }
          return makeEdgeForbiddenResponse(
            lowerPath,
            `Access Denied: VPN / Proxy / Tor usage is strictly prohibited on this site (${vpnInfo.reason}). Your IP (${clientIp}) has been banned immediately.`,
            { vpn_banned: true, vpn_reason: vpnInfo.reason }
          );
        }
      }
    }

    // ─────────────────────────────────────────────────────────────
    // 4. MULTI-TIERED DDoS RATE LIMITER (Instant Burst & 60s Window)
    // ─────────────────────────────────────────────────────────────
    // Skip rate-limiting static sub-assets so initial page render isn't penalized
    if (!isStaticAsset) {
      const method = (request.method || 'GET').toUpperCase();
      const isApiRequest = lowerPath.startsWith('/api/');
      const BOOT_READ_PATHS = new Set(['/api/config', '/api/scores', '/api/feedback', '/api/admin/user-title']);
      const isBootRead = (method === 'GET' || method === 'HEAD') && BOOT_READ_PATHS.has(lowerPath);
      const API_BURST_MAX_REQS = 50;
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

      // --- 4A. INSTANT 1-SECOND BURST CHECK ---
      if (!isApiRequest) {
        if (bumpWindow('burstCount', 'burstResetAt', BURST_WINDOW_MS) > BURST_MAX_REQS) {
          return makeDdosBanResponse(
            "DDoS Attack Blocked: Exceeded rate limit (>30 requests in 1 second). Your device IP has been banned temporarily.",
            "Too Many Requests - DDoS Burst Ban",
            "Burst-Triggered"
          );
        }
      } else if (!isBootRead) {
        if (bumpWindow('apiBurstCount', 'apiBurstResetAt', BURST_WINDOW_MS) > API_BURST_MAX_REQS) {
          return makeDdosBanResponse(
            "DDoS Attack Blocked: Exceeded API burst limit. Your device IP has been banned immediately.",
            "Too Many Requests - DDoS Burst Ban",
            "Burst-Triggered"
          );
        }
      }

      // --- 4B. SUSTAINED 60-SECOND WINDOW CHECK ---
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
