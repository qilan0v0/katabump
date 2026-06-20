// 将 vmess:// / vless:// 分享链接解析为带本地 HTTP 入站的 v2ray config.json
// 用法 (CLI): node gen-v2ray-config.js "<share-link>" <http-port> <out-path>
// 用法 (模块): const { buildConfig } = require('./gen-v2ray-config'); buildConfig(link, port)
const fs = require('fs');

function b64decode(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Buffer.from(s, 'base64').toString('utf8');
}

// 解析分享链接为 v2ray outbound 对象（vmess:// 或 vless://）
function parseOutbound(link) {
let outbound;

if (link.startsWith('vmess://')) {
    const conf = JSON.parse(b64decode(link.slice('vmess://'.length)));
    const tls = (conf.tls === 'tls' || conf.tls === true);
    const net = conf.net || 'tcp';
    const streamSettings = { network: net, security: tls ? 'tls' : 'none' };
    if (tls) {
        streamSettings.tlsSettings = { serverName: conf.sni || conf.host || conf.add, allowInsecure: false };
    }
    if (net === 'ws') {
        streamSettings.wsSettings = { path: conf.path || '/', headers: conf.host ? { Host: conf.host } : {} };
    } else if (net === 'grpc') {
        streamSettings.grpcSettings = { serviceName: conf.path || '' };
    }
    outbound = {
        protocol: 'vmess',
        settings: {
            vnext: [{
                address: conf.add,
                port: parseInt(conf.port, 10),
                users: [{ id: conf.id, alterId: parseInt(conf.aid || '0', 10), security: conf.scy || 'auto' }]
            }]
        },
        streamSettings
    };
} else if (link.startsWith('vless://')) {
    const u = new URL(link);
    const q = u.searchParams;
    const net = q.get('type') || 'tcp';
    const security = q.get('security') || 'none';
    const streamSettings = { network: net, security };
    if (security === 'tls' || security === 'reality') {
        streamSettings.tlsSettings = { serverName: q.get('sni') || u.hostname, allowInsecure: false };
        if (security === 'reality') {
            streamSettings.realitySettings = {
                serverName: q.get('sni') || u.hostname,
                publicKey: q.get('pbk') || '',
                shortId: q.get('sid') || '',
                fingerprint: q.get('fp') || 'chrome'
            };
            delete streamSettings.tlsSettings;
        }
    }
    if (net === 'ws') {
        streamSettings.wsSettings = { path: q.get('path') || '/', headers: q.get('host') ? { Host: q.get('host') } : {} };
    } else if (net === 'grpc') {
        streamSettings.grpcSettings = { serviceName: q.get('serviceName') || '' };
    }
    outbound = {
        protocol: 'vless',
        settings: {
            vnext: [{
                address: u.hostname,
                port: parseInt(u.port, 10),
                users: [{ id: decodeURIComponent(u.username), encryption: q.get('encryption') || 'none', flow: q.get('flow') || '' }]
            }]
        },
        streamSettings
    };
} else {
    throw new Error('[v2ray] 不支持的链接类型，仅支持 vmess:// 或 vless://');
}
    return outbound;
}

// 构建完整的 v2ray config 对象（含本地 HTTP 入站）
function buildConfig(link, httpPort) {
    const outbound = parseOutbound((link || '').trim());
    return {
        log: { loglevel: 'warning' },
        inbounds: [{
            tag: 'http-in',
            port: httpPort,
            listen: '127.0.0.1',
            protocol: 'http',
            settings: { allowTransparent: false }
        }],
        routing: {
            domainStrategy: 'UseIPv4',
            rules: []
        },
        outbounds: [
            { ...outbound, tag: 'proxy' },
            { protocol: 'freedom', tag: 'direct' }
        ]
    };
}

module.exports = { parseOutbound, buildConfig, b64decode };

// CLI 入口：仅在被直接执行时运行
if (require.main === module) {
    const link = (process.argv[2] || '').trim();
    const httpPort = parseInt(process.argv[3] || '10809', 10);
    const outPath = process.argv[4] || 'v2ray-config.json';
    if (!link) {
        console.error('[v2ray] 缺少分享链接 (Secret V2RAY_VMESS 未设置?)');
        process.exit(1);
    }
    let config;
    try {
        config = buildConfig(link, httpPort);
    } catch (e) {
        console.error(e.message);
        process.exit(1);
    }
    fs.writeFileSync(outPath, JSON.stringify(config, null, 2));
    console.log(`[v2ray] 已生成配置 ${outPath} (协议=${config.outbounds[0].protocol}, HTTP 入站=127.0.0.1:${httpPort})`);
}
