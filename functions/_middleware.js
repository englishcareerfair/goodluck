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

// ── Multi-IP Subnet & Device Rotation Protection (Edge In-Memory) ──
const SUBNET_RATE_LIMITS = new Map(); // subnetKey -> { count, resetAt, burstCount, burstResetAt, uniqueIps: Set }
const BANNED_SUBNETS = new Map();     // subnetKey -> banExpiresAt (timestamp)
const CLIENT_ROTATION_TRACKER = new Map(); // clientFp -> { ips: Set, firstSeen, reqCount }
const BANNED_FINGERPRINTS = new Map();     // clientFp -> banExpiresAt (timestamp)

let GLOBAL_DYNAMIC_COUNT = 0;
let GLOBAL_DYNAMIC_RESET_AT = 0;
let GLOBAL_UNIQUE_IPS = new Set();
let UNDER_DDOS_MODE = false;
let UNDER_DDOS_UNTIL = 0;

const GLOBAL_VPN_SERVER_PREFIXES = new Set([
  '103.106.58',
  '103.108.229',
  '103.108.231',
  '103.120.66',
  '103.125.235',
  '103.14.26',
  '103.214.20',
  '103.216.220',
  '103.216.221',
  '103.219.169',
  '103.75.11',
  '103.88.234',
  '104.254.95',
  '109.111.197',
  '109.204.35',
  '109.236.81',
  '116.90.74',
  '130.195.216',
  '130.195.217',
  '130.195.223',
  '130.195.240',
  '130.195.241',
  '130.195.242',
  '130.195.243',
  '130.195.245',
  '130.195.250',
  '134.82.69',
  '134.82.74',
  '134.82.75',
  '135.136.15',
  '135.136.16',
  '135.136.17',
  '135.136.18',
  '135.136.24',
  '135.136.25',
  '135.136.62',
  '138.199.21',
  '138.199.22',
  '138.199.34',
  '138.199.35',
  '138.199.50',
  '138.199.53',
  '138.199.55',
  '138.199.6',
  '138.199.60',
  '138.199.7',
  '144.48.39',
  '146.70.113',
  '146.70.120',
  '146.70.129',
  '146.70.136',
  '146.70.14',
  '146.70.142',
  '146.70.147',
  '146.70.156',
  '146.70.161',
  '146.70.170',
  '146.70.174',
  '146.70.181',
  '146.70.182',
  '146.70.198',
  '146.70.202',
  '146.70.204',
  '146.70.221',
  '146.70.226',
  '146.70.231',
  '146.70.29',
  '146.70.48',
  '146.70.58',
  '146.70.8',
  '146.70.84',
  '146.70.98',
  '149.102.224',
  '149.102.226',
  '149.102.235',
  '149.102.239',
  '149.102.244',
  '149.102.245',
  '149.102.251',
  '149.102.254',
  '149.22.80',
  '149.22.81',
  '149.22.82',
  '149.22.85',
  '149.22.91',
  '149.22.94',
  '149.22.95',
  '149.34.251',
  '149.36.48',
  '149.40.48',
  '149.40.58',
  '149.40.62',
  '149.50.211',
  '149.50.216',
  '149.50.217',
  '149.88.102',
  '149.88.103',
  '149.88.110',
  '149.88.17',
  '149.88.18',
  '149.88.20',
  '149.88.21',
  '149.88.23',
  '149.88.25',
  '149.88.27',
  '149.88.30',
  '151.243.141',
  '152.233.3',
  '154.47.16',
  '154.47.17',
  '154.47.19',
  '156.146.45',
  '156.146.50',
  '156.146.51',
  '156.146.54',
  '156.146.55',
  '163.5.171',
  '169.150.196',
  '169.150.226',
  '172.240.229',
  '175.110.114',
  '178.218.167',
  '178.249.212',
  '178.249.214',
  '180.149.229',
  '185.100.233',
  '185.107.44',
  '185.107.94',
  '185.111.109',
  '185.130.187',
  '185.132.132',
  '185.156.46',
  '185.159.156',
  '185.159.157',
  '185.159.158',
  '185.163.44',
  '185.165.240',
  '185.165.242',
  '185.177.125',
  '185.177.126',
  '185.180.222',
  '185.183.33',
  '185.183.34',
  '185.184.195',
  '185.212.111',
  '185.229.25',
  '185.245.85',
  '185.246.211',
  '185.247.68',
  '185.28.254',
  '185.76.11',
  '185.90.60',
  '188.214.106',
  '188.214.122',
  '188.214.125',
  '188.214.152',
  '188.214.158',
  '188.215.235',
  '188.240.57',
  '190.2.147',
  '190.2.151',
  '190.2.153',
  '192.144.20',
  '192.144.21',
  '192.159.101',
  '193.187.151',
  '193.29.107',
  '193.37.254',
  '193.9.36',
  '193.9.37',
  '193.9.38',
  '193.9.39',
  '194.126.177',
  '194.180.33',
  '194.180.34',
  '194.34.132',
  '195.158.248',
  '195.177.92',
  '195.181.162',
  '195.181.163',
  '195.80.150',
  '195.86.23',
  '195.86.38',
  '195.86.6',
  '196.197.28',
  '196.240.54',
  '196.245.151',
  '198.44.139',
  '2.58.241',
  '205.147.31',
  '212.102.44',
  '212.102.51',
  '212.8.249',
  '213.139.10',
  '213.244.113',
  '217.113.171',
  '217.138.10',
  '217.138.11',
  '217.138.193',
  '217.138.198',
  '217.138.216',
  '217.138.89',
  '217.23.3',
  '217.79.104',
  '31.171.153',
  '37.0.12',
  '37.120.234',
  '37.19.199',
  '37.19.200',
  '37.19.201',
  '37.19.205',
  '37.19.221',
  '37.191.127',
  '37.46.115',
  '45.128.133',
  '45.128.134',
  '45.138.86',
  '45.139.48',
  '45.14.71',
  '45.146.222',
  '45.151.45',
  '45.82.64',
  '45.83.124',
  '45.83.125',
  '45.83.126',
  '45.83.127',
  '45.83.136',
  '45.83.137',
  '45.83.138',
  '45.83.139',
  '45.83.144',
  '45.83.145',
  '45.83.146',
  '45.92.33',
  '5.253.204',
  '51.179.177',
  '62.169.136',
  '66.205.84',
  '66.234.153',
  '66.234.154',
  '66.234.155',
  '66.234.156',
  '66.234.157',
  '72.14.148',
  '72.251.222',
  '74.118.126',
  '74.63.204',
  '79.110.55',
  '79.127.131',
  '79.127.144',
  '79.127.145',
  '79.127.147',
  '79.127.149',
  '79.127.160',
  '79.127.176',
  '79.127.180',
  '79.127.182',
  '79.127.183',
  '79.127.185',
  '79.127.186',
  '79.127.254',
  '79.135.104',
  '79.135.105',
  '84.17.63',
  '84.20.16',
  '84.20.27',
  '84.233.167',
  '84.233.251',
  '84.252.113',
  '85.132.252',
  '85.203.39',
  '85.204.78',
  '86.106.121',
  '87.249.134',
  '87.249.139',
  '88.211.225',
  '89.105.214',
  '89.187.164',
  '89.187.170',
  '89.187.171',
  '89.187.177',
  '89.187.179',
  '89.187.180',
  '89.222.98',
  '89.238.155',
  '89.238.156',
  '89.238.174',
  '89.249.72',
  '89.38.97',
  '89.39.104',
  '89.39.106',
  '89.39.107',
  '89.45.224',
  '89.47.234',
  '91.132.139',
  '91.90.123',
  '93.113.202',
  '93.190.138',
  '93.190.141',
  '93.190.142',
  '94.190.195',
  '95.153.31',
  '95.173.205',
  '95.173.217',
  '95.177.96'
]);

const GLOBAL_VPN_SERVER_IPS = new Set([
  '103.106.58.163',
  '103.108.229.18',
  '103.108.231.162',
  '103.108.231.242',
  '103.120.66.226',
  '103.125.235.18',
  '103.125.235.20',
  '103.14.26.127',
  '103.214.20.210',
  '103.214.20.98',
  '103.216.220.98',
  '103.216.221.66',
  '103.216.221.70',
  '103.216.221.74',
  '103.219.169.99',
  '103.75.11.18',
  '103.88.234.147',
  '104.254.95.98',
  '109.111.197.130',
  '109.111.197.2',
  '109.204.35.226',
  '109.204.35.233',
  '109.236.81.160',
  '109.236.81.166',
  '116.90.74.178',
  '130.195.216.66',
  '130.195.217.2',
  '130.195.223.2',
  '130.195.240.2',
  '130.195.241.2',
  '130.195.242.2',
  '130.195.243.2',
  '130.195.245.3',
  '130.195.250.66',
  '134.82.69.2',
  '134.82.69.6',
  '134.82.74.104',
  '134.82.74.16',
  '134.82.74.200',
  '134.82.74.224',
  '134.82.74.56',
  '134.82.74.72',
  '134.82.74.8',
  '134.82.75.112',
  '134.82.75.136',
  '134.82.75.16',
  '134.82.75.160',
  '134.82.75.32',
  '134.82.75.40',
  '134.82.75.8',
  '135.136.15.130',
  '135.136.15.2',
  '135.136.16.2',
  '135.136.17.2',
  '135.136.18.2',
  '135.136.24.130',
  '135.136.24.2',
  '135.136.25.130',
  '135.136.25.2',
  '135.136.62.2',
  '138.199.21.193',
  '138.199.21.206',
  '138.199.22.102',
  '138.199.22.103',
  '138.199.34.193',
  '138.199.35.97',
  '138.199.50.103',
  '138.199.50.104',
  '138.199.50.105',
  '138.199.50.106',
  '138.199.50.107',
  '138.199.50.97',
  '138.199.50.98',
  '138.199.53.225',
  '138.199.53.236',
  '138.199.53.237',
  '138.199.53.242',
  '138.199.53.247',
  '138.199.55.33',
  '138.199.6.181',
  '138.199.60.85',
  '138.199.60.87',
  '138.199.7.129',
  '138.199.7.159',
  '138.199.7.234',
  '138.199.7.250',
  '138.199.7.251',
  '144.48.39.226',
  '146.70.113.114',
  '146.70.120.146',
  '146.70.129.18',
  '146.70.136.35',
  '146.70.14.19',
  '146.70.14.42',
  '146.70.142.18',
  '146.70.142.82',
  '146.70.147.114',
  '146.70.156.2',
  '146.70.161.178',
  '146.70.170.18',
  '146.70.174.66',
  '146.70.181.34',
  '146.70.182.34',
  '146.70.198.50',
  '146.70.202.178',
  '146.70.202.82',
  '146.70.204.162',
  '146.70.221.130',
  '146.70.226.226',
  '146.70.231.2',
  '146.70.29.194',
  '146.70.48.2',
  '146.70.58.130',
  '146.70.8.2',
  '146.70.84.2',
  '146.70.98.162',
  '146.70.98.194',
  '146.70.98.98',
  '149.102.224.161',
  '149.102.224.48',
  '149.102.226.193',
  '149.102.235.33',
  '149.102.239.225',
  '149.102.239.33',
  '149.102.239.34',
  '149.102.244.97',
  '149.102.245.129',
  '149.102.251.97',
  '149.102.254.78',
  '149.22.80.1',
  '149.22.81.1',
  '149.22.82.88',
  '149.22.85.193',
  '149.22.85.222',
  '149.22.91.161',
  '149.22.94.28',
  '149.22.95.193',
  '149.34.251.136',
  '149.36.48.153',
  '149.40.48.106',
  '149.40.48.65',
  '149.40.58.146',
  '149.40.62.21',
  '149.50.211.144',
  '149.50.216.225',
  '149.50.217.161',
  '149.88.102.110',
  '149.88.102.46',
  '149.88.103.163',
  '149.88.110.33',
  '149.88.17.129',
  '149.88.18.193',
  '149.88.20.129',
  '149.88.21.122',
  '149.88.23.102',
  '149.88.23.117',
  '149.88.25.129',
  '149.88.27.219',
  '149.88.27.233',
  '149.88.27.236',
  '149.88.30.88',
  '151.243.141.157',
  '151.243.141.161',
  '152.233.3.193',
  '154.47.16.81',
  '154.47.17.158',
  '154.47.19.213',
  '156.146.45.139',
  '156.146.50.5',
  '156.146.51.129',
  '156.146.51.78',
  '156.146.54.81',
  '156.146.54.97',
  '156.146.55.225',
  '163.5.171.2',
  '169.150.196.100',
  '169.150.196.71',
  '169.150.196.83',
  '169.150.196.96',
  '169.150.196.97',
  '169.150.226.161',
  '169.150.226.172',
  '172.240.229.103',
  '175.110.114.43',
  '178.218.167.210',
  '178.249.212.161',
  '178.249.212.162',
  '178.249.212.163',
  '178.249.214.65',
  '180.149.229.130',
  '185.100.233.84',
  '185.107.44.200',
  '185.107.94.181',
  '185.111.109.1',
  '185.130.187.2',
  '185.132.132.113',
  '185.132.132.26',
  '185.156.46.33',
  '185.159.156.119',
  '185.159.156.122',
  '185.159.156.124',
  '185.159.156.125',
  '185.159.156.126',
  '185.159.156.127',
  '185.159.156.128',
  '185.159.156.129',
  '185.159.156.130',
  '185.159.156.133',
  '185.159.156.134',
  '185.159.156.135',
  '185.159.156.144',
  '185.159.156.146',
  '185.159.156.147',
  '185.159.156.148',
  '185.159.156.159',
  '185.159.156.162',
  '185.159.156.179',
  '185.159.156.183',
  '185.159.156.185',
  '185.159.156.29',
  '185.159.156.43',
  '185.159.156.49',
  '185.159.156.56',
  '185.159.156.58',
  '185.159.156.81',
  '185.159.156.82',
  '185.159.156.83',
  '185.159.156.84',
  '185.159.156.85',
  '185.159.156.86',
  '185.159.156.87',
  '185.159.156.88',
  '185.159.156.89',
  '185.159.156.90',
  '185.159.156.93',
  '185.159.156.95',
  '185.159.156.97',
  '185.159.156.98',
  '185.159.157.176',
  '185.159.157.23',
  '185.159.158.1',
  '185.159.158.123',
  '185.159.158.138',
  '185.159.158.149',
  '185.159.158.165',
  '185.159.158.167',
  '185.159.158.168',
  '185.159.158.177',
  '185.159.158.180',
  '185.159.158.181',
  '185.159.158.182',
  '185.159.158.183',
  '185.159.158.187',
  '185.159.158.191',
  '185.159.158.194',
  '185.159.158.195',
  '185.159.158.200',
  '185.159.158.202',
  '185.159.158.204',
  '185.159.158.208',
  '185.159.158.209',
  '185.159.158.21',
  '185.159.158.214',
  '185.159.158.215',
  '185.159.158.216',
  '185.159.158.219',
  '185.159.158.22',
  '185.159.158.220',
  '185.159.158.221',
  '185.159.158.223',
  '185.159.158.224',
  '185.159.158.225',
  '185.159.158.232',
  '185.159.158.233',
  '185.159.158.234',
  '185.159.158.237',
  '185.159.158.24',
  '185.159.158.240',
  '185.159.158.245',
  '185.159.158.28',
  '185.159.158.43',
  '185.159.158.55',
  '185.159.158.74',
  '185.159.158.75',
  '185.163.44.137',
  '185.165.240.80',
  '185.165.242.20',
  '185.177.125.172',
  '185.177.125.196',
  '185.177.126.132',
  '185.177.126.14',
  '185.180.222.89',
  '185.183.33.217',
  '185.183.34.149',
  '185.183.34.165',
  '185.183.34.27',
  '185.184.195.59',
  '185.212.111.98',
  '185.229.25.116',
  '185.245.85.130',
  '185.246.211.193',
  '185.247.68.50',
  '185.28.254.2',
  '185.76.11.17',
  '185.76.11.27',
  '185.90.60.210',
  '188.214.106.178',
  '188.214.122.82',
  '188.214.125.162',
  '188.214.152.226',
  '188.214.158.34',
  '188.215.235.82',
  '188.240.57.226',
  '190.2.147.7',
  '190.2.151.139',
  '190.2.153.215',
  '192.144.20.2',
  '192.144.21.2',
  '192.159.101.226',
  '193.187.151.98',
  '193.29.107.162',
  '193.37.254.66',
  '193.9.36.1',
  '193.9.37.1',
  '193.9.38.1',
  '193.9.39.1',
  '194.126.177.14',
  '194.126.177.6',
  '194.126.177.9',
  '194.180.33.3',
  '194.180.33.8',
  '194.180.34.11',
  '194.180.34.7',
  '194.34.132.55',
  '195.158.248.226',
  '195.177.92.58',
  '195.181.162.163',
  '195.181.163.1',
  '195.80.150.226',
  '195.86.23.81',
  '195.86.38.33',
  '195.86.6.249',
  '196.197.28.130',
  '196.240.54.114',
  '196.245.151.210',
  '198.44.139.83',
  '2.58.241.66',
  '205.147.31.1',
  '212.102.44.166',
  '212.102.51.241',
  '212.8.249.21',
  '213.139.10.129',
  '213.244.113.194',
  '217.113.171.2',
  '217.138.10.130',
  '217.138.11.2',
  '217.138.193.98',
  '217.138.198.246',
  '217.138.216.130',
  '217.138.216.162',
  '217.138.89.2',
  '217.23.3.76',
  '217.79.104.1',
  '217.79.104.3',
  '31.171.153.98',
  '37.0.12.226',
  '37.120.234.194',
  '37.19.199.129',
  '37.19.199.144',
  '37.19.199.149',
  '37.19.199.155',
  '37.19.200.1',
  '37.19.200.17',
  '37.19.200.22',
  '37.19.201.129',
  '37.19.201.130',
  '37.19.205.223',
  '37.19.221.193',
  '37.191.127.2',
  '37.46.115.5',
  '45.128.133.226',
  '45.128.134.194',
  '45.128.134.199',
  '45.138.86.194',
  '45.139.48.242',
  '45.14.71.5',
  '45.14.71.6',
  '45.14.71.7',
  '45.146.222.226',
  '45.151.45.4',
  '45.82.64.25',
  '45.83.124.1',
  '45.83.125.1',
  '45.83.126.1',
  '45.83.127.1',
  '45.83.136.1',
  '45.83.137.1',
  '45.83.138.1',
  '45.83.139.1',
  '45.83.144.1',
  '45.83.145.1',
  '45.83.146.1',
  '45.92.33.162',
  '5.253.204.162',
  '51.179.177.2',
  '62.169.136.104',
  '62.169.136.105',
  '62.169.136.106',
  '62.169.136.108',
  '62.169.136.109',
  '62.169.136.110',
  '62.169.136.111',
  '62.169.136.112',
  '62.169.136.113',
  '62.169.136.116',
  '62.169.136.117',
  '62.169.136.12',
  '62.169.136.124',
  '62.169.136.13',
  '62.169.136.141',
  '62.169.136.150',
  '62.169.136.153',
  '62.169.136.165',
  '62.169.136.187',
  '62.169.136.197',
  '62.169.136.208',
  '62.169.136.209',
  '62.169.136.210',
  '62.169.136.211',
  '62.169.136.212',
  '62.169.136.213',
  '62.169.136.218',
  '62.169.136.219',
  '62.169.136.227',
  '62.169.136.232',
  '62.169.136.238',
  '62.169.136.239',
  '62.169.136.241',
  '62.169.136.243',
  '62.169.136.245',
  '62.169.136.252',
  '62.169.136.253',
  '62.169.136.27',
  '62.169.136.56',
  '62.169.136.57',
  '62.169.136.60',
  '62.169.136.65',
  '62.169.136.7',
  '62.169.136.8',
  '62.169.136.80',
  '62.169.136.81',
  '62.169.136.82',
  '62.169.136.85',
  '62.169.136.9',
  '62.169.136.93',
  '62.169.136.94',
  '62.169.136.95',
  '66.205.84.242',
  '66.234.153.130',
  '66.234.153.2',
  '66.234.154.130',
  '66.234.154.2',
  '66.234.155.130',
  '66.234.155.2',
  '66.234.156.130',
  '66.234.156.2',
  '66.234.157.2',
  '72.14.148.2',
  '72.251.222.1',
  '74.118.126.104',
  '74.118.126.108',
  '74.118.126.112',
  '74.118.126.116',
  '74.118.126.132',
  '74.118.126.136',
  '74.118.126.144',
  '74.118.126.152',
  '74.118.126.156',
  '74.118.126.16',
  '74.118.126.172',
  '74.118.126.180',
  '74.118.126.184',
  '74.118.126.188',
  '74.118.126.2',
  '74.118.126.200',
  '74.118.126.204',
  '74.118.126.208',
  '74.118.126.212',
  '74.118.126.216',
  '74.118.126.220',
  '74.118.126.224',
  '74.118.126.228',
  '74.118.126.236',
  '74.118.126.24',
  '74.118.126.240',
  '74.118.126.28',
  '74.118.126.32',
  '74.118.126.36',
  '74.118.126.4',
  '74.118.126.48',
  '74.118.126.56',
  '74.118.126.60',
  '74.118.126.64',
  '74.118.126.68',
  '74.118.126.72',
  '74.118.126.8',
  '74.118.126.96',
  '74.63.204.210',
  '79.110.55.2',
  '79.127.131.222',
  '79.127.144.130',
  '79.127.144.158',
  '79.127.144.159',
  '79.127.145.65',
  '79.127.147.3',
  '79.127.149.65',
  '79.127.160.187',
  '79.127.160.216',
  '79.127.176.29',
  '79.127.180.1',
  '79.127.182.65',
  '79.127.183.234',
  '79.127.185.251',
  '79.127.186.193',
  '79.127.186.222',
  '79.127.254.119',
  '79.135.104.100',
  '79.135.104.104',
  '79.135.104.108',
  '79.135.104.110',
  '79.135.104.112',
  '79.135.104.20',
  '79.135.104.21',
  '79.135.104.28',
  '79.135.104.35',
  '79.135.104.40',
  '79.135.104.41',
  '79.135.104.43',
  '79.135.104.45',
  '79.135.104.49',
  '79.135.104.50',
  '79.135.104.60',
  '79.135.104.69',
  '79.135.104.85',
  '79.135.104.92',
  '79.135.104.93',
  '79.135.104.94',
  '79.135.105.1',
  '79.135.105.104',
  '79.135.105.12',
  '79.135.105.132',
  '79.135.105.148',
  '79.135.105.16',
  '79.135.105.160',
  '79.135.105.168',
  '79.135.105.184',
  '79.135.105.188',
  '79.135.105.192',
  '79.135.105.196',
  '79.135.105.20',
  '79.135.105.200',
  '79.135.105.204',
  '79.135.105.208',
  '79.135.105.212',
  '79.135.105.24',
  '79.135.105.4',
  '79.135.105.40',
  '79.135.105.48',
  '79.135.105.52',
  '79.135.105.56',
  '79.135.105.60',
  '79.135.105.68',
  '79.135.105.72',
  '79.135.105.76',
  '79.135.105.80',
  '79.135.105.84',
  '79.135.105.88',
  '79.135.105.96',
  '84.17.63.17',
  '84.20.16.29',
  '84.20.27.34',
  '84.20.27.35',
  '84.20.27.38',
  '84.20.27.39',
  '84.20.27.44',
  '84.20.27.46',
  '84.20.27.47',
  '84.233.167.225',
  '84.233.251.34',
  '84.252.113.9',
  '85.132.252.34',
  '85.203.39.226',
  '85.204.78.39',
  '86.106.121.3',
  '87.249.134.138',
  '87.249.139.170',
  '88.211.225.188',
  '89.105.214.199',
  '89.187.164.241',
  '89.187.170.135',
  '89.187.170.159',
  '89.187.171.248',
  '89.187.177.71',
  '89.187.179.55',
  '89.187.180.1',
  '89.187.180.14',
  '89.187.180.54',
  '89.222.98.35',
  '89.238.155.130',
  '89.238.155.2',
  '89.238.156.194',
  '89.238.156.242',
  '89.238.174.130',
  '89.238.174.2',
  '89.249.72.2',
  '89.38.97.138',
  '89.39.104.165',
  '89.39.106.82',
  '89.39.107.109',
  '89.39.107.185',
  '89.39.107.188',
  '89.45.224.2',
  '89.47.234.146',
  '89.47.234.226',
  '89.47.234.242',
  '91.132.139.2',
  '91.90.123.50',
  '93.113.202.39',
  '93.190.138.166',
  '93.190.141.58',
  '93.190.142.102',
  '94.190.195.24',
  '95.153.31.114',
  '95.173.205.129',
  '95.173.205.159',
  '95.173.205.163',
  '95.173.217.224',
  '95.177.96.177'
]);

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

const RESIDENTIAL_ISP_ALLOWLIST = /\b(jio|reliance\s*jio|bharti\s*airtel|airtel|vodafone|vi\s+india|idea\s+cellular|bsnl|mtnl|act\s*corp|atria\s*convergence|hathway|tikona|excitel|you\s*broadband|alliance\s*broadband|gtpl|tata\s*(communications|teleservices|play|sky|fiber)|comcast|xfinity|verizon|at&t|t-mobile|charter|spectrum|cox\s*comm|bt\s*group|british\s*telecom|virgin\s*media|sky\s*uk|rogers|bell\s*canada|telus|deutsche\s*telekom|orange|telefonica|ntt|softbank|kddi|optus|telstra|singtel|starhub)\b/i;

const VPN_ORG_REGEX = /\b(vpn|tor\s*exit|proxy|webproxy|socks|anonymiz|proton|mullvad|nordvpn|tefincom|surfshark|expressvpn|cyberghost|windscribe|tunnelbear|private\s*internet|hotspot\s*shield|psiphon|ultrasurf|betternet|hola\s*vpn|urban\s*vpn|adguard\s*vpn|m247|datacamp|cdn77|choopa|vultr|digitalocean|hetzner|ovh|linode|contabo|leaseweb|colocrossing|quadranet|frantech|buyvm|hostinger|kamatera|serverius|zenlayer|sharktech|tzulo|cloudflare\s*warp|scaleway|upcloud|ionos|privax|vyprvpn|strongvpn|purevpn|ipvanish|clouvider|bright\s*data|oxylabs|estnoc|hern\s*labs|realcloud|melbikomas|equinix|gcore|packethost|psychz|dedipath|ovpn|airvpn|torguard|hidemyass|astrill|ivacy|fastvpn|shinjiru|cinipac|blazing\s*seo|iproyal|stormproxies|smartproxy|webshare)\b/i;

// Catch-all datacenter/hosting org detector — matches orgs that look like hosting providers
// even if they're not in the explicit lists above (e.g. "HERN Labs AB", "Psychz Networks", etc.)
const DATACENTER_ORG_REGEX = /\b(labs?\s+ab|hosting|datacenter|data\s*center|colocation|colo\b|dedicated|server\s*farm|cloud\s*(host|services?|solutions?)|vps|bare\s*metal|managed\s*server|internet\s*exchange|ix\b|transit|peering|fiber\s*net|network\s*solutions?|cyber\s*hub|tech\s*solutions?|web\s*services?|server\s*solutions?|cloud\s*computing|it\s*infrastructure|noc\b|telecom\s*services?|ctrls|yotta|webwerks|netmagic|e2e\s*networks|rackbank|pi\s*datacenters)\b/i;

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

  if (!clientIp || isPrivateOrDevIp(clientIp)) {
    return { isVpn: false, reason: '', asn, asOrg, country, city, region };
  }

  if (EXPLICIT_DDOS_BANNED_IPS.has(clientIp)) {
    return { isVpn: true, reason: 'Explicit DDoS Attack IP Banned', asn, asOrg, country, city, region };
  }

  // Worldwide VPN Server Fleet (Exit Nodes across 149+ countries)
  if (GLOBAL_VPN_SERVER_IPS.has(clientIp)) {
    return { isVpn: true, reason: 'Worldwide VPN Exit Node Detected', asn, asOrg, country, city, region };
  }
  const ipP = clientIp.split('.');
  if (ipP.length === 4 && GLOBAL_VPN_SERVER_PREFIXES.has(`${ipP[0]}.${ipP[1]}.${ipP[2]}`)) {
    return { isVpn: true, reason: 'Worldwide VPN Server Subnet Detected', asn, asOrg, country, city, region };
  }

  // Anycast / Datacenter Egress IP check (client browser can never have a Cloudflare/datacenter Anycast IP)
  if (/^(172\.(6[4-9]|7[0-1])\.|104\.(1[6-9]|2[0-7])\.|162\.15[89]\.|2606:4700:)/i.test(clientIp)) {
    return { isVpn: true, reason: `Cloudflare / Anycast Proxy Egress IP (${clientIp})`, asn, asOrg, country, city, region };
  }

  // 1. Chained proxy check (multiple IPs in X-Forwarded-For)
  const xff = String(req.headers.get('x-forwarded-for') || '');
  if (xff.includes(',')) {
    return { isVpn: true, reason: 'Chained Proxy Headers (X-Forwarded-For)', asn, asOrg, country, city, region };
  }

  // 2. Explicit proxy / VPN headers
  const via = String(req.headers.get('via') || '');
  if (
    req.headers.has('x-tor') ||
    req.headers.has('x-vpn') ||
    req.headers.has('x-proxy-id') ||
    req.headers.has('x-anonymizer') ||
    req.headers.has('forwarded-for-proxy') ||
    req.headers.has('proxy-connection') ||
    req.headers.has('x-real-ip') ||
    /\b(tor|vpn|proxy|squid|privoxy|hola|urban|psiphon|warp|varnish)\b/i.test(via)
  ) {
    return { isVpn: true, reason: 'VPN / Proxy Header Detected', asn, asOrg, country, city, region };
  }

  // 3. Cloudflare threat score / Tor / Anonymous proxy country flags
  if (threatScore > 5) {
    return { isVpn: true, reason: `Cloudflare Threat Flag (Score: ${threatScore})`, asn, asOrg, country, city, region };
  }
  if (country === 'T1' || country === 'XX' || country === 'A1' || country === 'A2') {
    return { isVpn: true, reason: `Tor / Anonymous Proxy Country Code (${country})`, asn, asOrg, country, city, region };
  }

  // 4. Known VPN & Datacenter ASN check
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
    // Catch-all: any non-residential org that looks like a datacenter/hosting provider
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
    // Any non-residential foreign connection
    if (country && country !== 'IN' && !RESIDENTIAL_ISP_ALLOWLIST.test(asOrg)) {
      return {
        isVpn: true,
        reason: `Non-Residential Foreign Network (${country}${asn ? ' · AS' + asn : ''}${asOrg ? ' · ' + asOrg : ''})`,
        asn,
        asOrg,
        country,
        city,
        region
      };
    }
    // Any Indian datacenter/cloud network
    if (country === 'IN' && asOrg && DATACENTER_ORG_REGEX.test(asOrg)) {
      return {
        isVpn: true,
        reason: `Indian Datacenter / Cloud Proxy (${asOrg})`,
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
        const ADMIN_OWN_IPS = ['157.119.203.139', '192.159.101.125'];
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
    const isAdminDevice = Boolean(secState.adminDevicesSet && secState.adminDevicesSet.has(clientIp));
    const isAllowlisted = Boolean(secState.allowlistSet && secState.allowlistSet.has(clientIp)) || isAdminDevice;

    if (isAllowlisted) {
      AUTO_BANNED_IPS.delete(clientIp);
      VPN_BANNED_IPS.delete(clientIp);
      IP_RATE_LIMITS.delete(clientIp);
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
    // 1. FAST-DROP: Check Temporary DDoS Auto-Bans in Memory
    // ─────────────────────────────────────────────────────────────
    const ipP_fast = clientIp.split('.');
    const slash24_fast = ipP_fast.length === 4 ? `${ipP_fast[0]}.${ipP_fast[1]}.${ipP_fast[2]}` : '';
    if (EXPLICIT_DDOS_BANNED_IPS.has(clientIp) || GLOBAL_VPN_SERVER_IPS.has(clientIp) || (slash24_fast && GLOBAL_VPN_SERVER_PREFIXES.has(slash24_fast))) {
      return makeEdgeForbiddenResponse(lowerPath, "Worldwide VPN / Datacenter Node Blocked", { ip: clientIp });
    }

    const { net: netKey, sub: subnetKey } = getSubnetKeys(clientIp);
    const clientFp = getClientFingerprint(request);

    if (netKey && BANNED_SUBNETS.has(netKey)) {
      if (now < BANNED_SUBNETS.get(netKey)) {
        return new Response(null, {
          status: 429,
          statusText: "Too Many Requests - Network Banned for DDoS",
          headers: { "Connection": "close", "Retry-After": "7200", "Cache-Control": "no-store" }
        });
      } else {
        BANNED_SUBNETS.delete(netKey);
      }
    }

    if (!isAllowlisted) {
      // 1A. Check Subnet Banned (Multi-IP DDoS Attack Source)
      if (subnetKey && BANNED_SUBNETS.has(subnetKey)) {
        const subExp = BANNED_SUBNETS.get(subnetKey);
        if (now < subExp) {
          AUTO_BANNED_IPS.set(clientIp, subExp);
          return new Response(null, {
            status: 429,
            statusText: "Too Many Requests - Subnet Multi-IP DDoS Blocked",
            headers: {
              "Connection": "close",
              "Retry-After": "7200",
              "Cache-Control": "no-store",
              "X-DDoS-Protection": "Subnet-Banned"
            }
          });
        } else {
          BANNED_SUBNETS.delete(subnetKey);
        }
      }

      // 1B. Check Client Fingerprint Banned (IP-Rotating Attacker)
      if (clientFp && BANNED_FINGERPRINTS.has(clientFp)) {
        const fpExp = BANNED_FINGERPRINTS.get(clientFp);
        if (now < fpExp) {
          AUTO_BANNED_IPS.set(clientIp, fpExp);
          return new Response(null, {
            status: 429,
            statusText: "Too Many Requests - Multi-IP Rotating Attacker Blocked",
            headers: {
              "Connection": "close",
              "Retry-After": "7200",
              "Cache-Control": "no-store",
              "X-DDoS-Protection": "Rotating-Attacker-Banned"
            }
          });
        } else {
          BANNED_FINGERPRINTS.delete(clientFp);
        }
      }

      // 1C. Check Individual IP Auto-Ban
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
      if (subnetKey) BANNED_SUBNETS.set(subnetKey, now + BAN_DURATION_MS);
      if (clientFp) BANNED_FINGERPRINTS.set(clientFp, now + BAN_DURATION_MS);
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
        if (subnetKey) BANNED_SUBNETS.set(subnetKey, now + BAN_DURATION_MS);
        if (clientFp) BANNED_FINGERPRINTS.set(clientFp, now + BAN_DURATION_MS);
        const persistPromise = persistEdgeVpnBan(db, clientIp, vpnInfo, request, pathname);
        if (typeof context.waitUntil === 'function') {
          context.waitUntil(persistPromise);
        } else {
          try { await persistPromise; } catch {}
        }
        return makeEdgeForbiddenResponse(
          lowerPath,
          `Access Denied: VPN / Proxy / Datacenter usage is strictly prohibited on this site (${vpnInfo.reason}). Your IP (${clientIp}) and subnet have been banned immediately.`,
          { vpn_banned: true, vpn_reason: vpnInfo.reason }
        );
      }
    }

    // ─────────────────────────────────────────────────────────────
    // 4. MULTI-TIERED DDoS RATE LIMITER (Subnet, Multi-IP & Individual Burst)
    // ─────────────────────────────────────────────────────────────
    // Admin devices and allowlisted IPs are completely exempt from DDoS rate limits
    if (!isStaticAsset && !isAllowlisted) {
      // 4A. Global Velocity Tracking across all unauthenticated requests
      if (now > GLOBAL_DYNAMIC_RESET_AT) {
        GLOBAL_DYNAMIC_RESET_AT = now + 1000;
        GLOBAL_DYNAMIC_COUNT = 1;
        GLOBAL_UNIQUE_IPS = new Set([clientIp]);
      } else {
        GLOBAL_DYNAMIC_COUNT++;
        GLOBAL_UNIQUE_IPS.add(clientIp);
      }

      // If >35 dynamic requests/sec from >=4 distinct IPs -> activate Under-DDoS Mode
      if (GLOBAL_DYNAMIC_COUNT > 35 && GLOBAL_UNIQUE_IPS.size >= 4) {
        UNDER_DDOS_MODE = true;
        UNDER_DDOS_UNTIL = now + 15000;
      } else if (now > UNDER_DDOS_UNTIL) {
        UNDER_DDOS_MODE = false;
      }

      // 4B. Client Fingerprint Multi-IP Rotation Tracking
      // Catches an attacker who rotates/hops across multiple IPs while maintaining same client state
      if (clientFp) {
        let rotTracker = CLIENT_ROTATION_TRACKER.get(clientFp);
        if (!rotTracker || now - rotTracker.firstSeen > 10000) {
          rotTracker = { ips: new Set([clientIp]), firstSeen: now, reqCount: 1 };
          CLIENT_ROTATION_TRACKER.set(clientFp, rotTracker);
        } else {
          rotTracker.ips.add(clientIp);
          rotTracker.reqCount++;
        }

        // If the same client fingerprint hops across >=3 distinct IPs in 10s:
        if (rotTracker.ips.size >= 3) {
          BANNED_FINGERPRINTS.set(clientFp, now + BAN_DURATION_MS);
          for (const bIp of rotTracker.ips) {
            AUTO_BANNED_IPS.set(bIp, now + BAN_DURATION_MS);
          }
          return new Response(null, {
            status: 429,
            statusText: "Too Many Requests - Multi-IP Rotating Attacker Banned",
            headers: {
              "Connection": "close",
              "Retry-After": "7200",
              "Cache-Control": "no-store",
              "X-DDoS-Protection": "Multi-IP-Hopping-Banned"
            }
          });
        }
      }

      // 4C. Multi-IP Network Cluster & Subnet DDoS Tracking (IPv6 /48 & /64, IPv4 /16 & /24)
      const trackCluster = (clusterKey, isWide) => {
        if (!clusterKey) return null;
        let tracker = SUBNET_RATE_LIMITS.get(clusterKey);
        if (!tracker || now > tracker.resetAt) {
          tracker = { count: 1, resetAt: now + 1000, uniqueIps: new Set([clientIp]) };
          SUBNET_RATE_LIMITS.set(clusterKey, tracker);
        } else {
          tracker.count++;
          tracker.uniqueIps.add(clientIp);
        }

        const maxBurst = UNDER_DDOS_MODE ? (isWide ? 4 : 5) : (isWide ? 10 : 12);
        // If >=2 distinct IPs from the same network cluster burst with >=3 requests in 1 second, or total requests > burst:
        if ((tracker.uniqueIps.size >= 2 && tracker.count >= 3) || tracker.count > maxBurst) {
          BANNED_SUBNETS.set(clusterKey, now + BAN_DURATION_MS);
          if (subnetKey) BANNED_SUBNETS.set(subnetKey, now + BAN_DURATION_MS);
          if (netKey) BANNED_SUBNETS.set(netKey, now + BAN_DURATION_MS);
          for (const sIp of tracker.uniqueIps) {
            AUTO_BANNED_IPS.set(sIp, now + BAN_DURATION_MS);
          }
          return new Response(null, {
            status: 429,
            statusText: "Too Many Requests - Multi-IP Cluster DDoS Attack Blocked",
            headers: {
              "Connection": "close",
              "Retry-After": "7200",
              "Cache-Control": "no-store",
              "X-DDoS-Protection": "Cluster-Multi-IP-Banned"
            }
          });
        }
        return null;
      };

      const netDrop = trackCluster(netKey, true);
      if (netDrop) return netDrop;
      const subDrop = trackCluster(subnetKey, false);
      if (subDrop) return subDrop;

      // 4D. Individual Client IP Burst & Sustained Rate Limits
      const method = (request.method || 'GET').toUpperCase();
      const isApiRequest = lowerPath.startsWith('/api/');
      const BOOT_READ_PATHS = new Set(['/api/config', '/api/scores', '/api/feedback', '/api/admin/user-title']);
      const isBootRead = (method === 'GET' || method === 'HEAD') && BOOT_READ_PATHS.has(lowerPath);
      
      const BURST_MAX = UNDER_DDOS_MODE ? 3 : BURST_MAX_REQS;
      const API_BURST_MAX = UNDER_DDOS_MODE ? 4 : API_BURST_MAX_REQS;
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
        if (subnetKey) BANNED_SUBNETS.set(subnetKey, now + BAN_DURATION_MS);
        if (clientFp) BANNED_FINGERPRINTS.set(clientFp, now + BAN_DURATION_MS);
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
      if (SUBNET_RATE_LIMITS.size > 1000) {
        for (const [sKey, entry] of SUBNET_RATE_LIMITS.entries()) {
          if (now > entry.resetAt) SUBNET_RATE_LIMITS.delete(sKey);
        }
      }
      if (CLIENT_ROTATION_TRACKER.size > 1000) {
        for (const [fpKey, entry] of CLIENT_ROTATION_TRACKER.entries()) {
          if (now - entry.firstSeen > 15000) CLIENT_ROTATION_TRACKER.delete(fpKey);
        }
      }
    }
  }

  return next();
}
