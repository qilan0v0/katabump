// 将各类代理链接 (vless:// vmess:// trojan:// hysteria2:// tuic:// anytls:// socks5://)
// 解析为 sing-box client config (本地 SOCKS5 + HTTP 入站)
// 使用方式: node gen-singbox-config.js "<link>" <socks-port> <http-port> [out-path]
const fs = require('fs');

function urlDecode(str) {
    return decodeURIComponent(str);
}

function parseLink(link) {
    // socks5://host:port:user:pass 非标准格式特殊处理
    const socksNonStandard = link.match(/^socks5?:\/\/([^:]+):(\d+):([^:]+):(.+)$/);
    if (socksNonStandard) {
        return {
            tag: 'proxy',
            type: 'socks',
            server: socksNonStandard[1],
            server_port: parseInt(socksNonStandard[2]),
            username: socksNonStandard[3],
            password: socksNonStandard[4],
            version: '5'
        };
    }

    const u = new URL(link);
    const proto = u.protocol.replace(':', '');
    const content = link.slice(link.indexOf('://') + 3).split('#')[0];

    let outbound = { tag: 'proxy' };

    switch (proto) {
        case 'vless': {
            const uuid = u.username;
            outbound = {
                ...outbound,
                type: 'vless',
                server: u.hostname,
                server_port: parseInt(u.port) || 443,
                uuid: uuid,
                flow: u.searchParams.get('flow') || '',
                tls: { enabled: false }
            };
            const ttype = u.searchParams.get('type') || 'tcp';
            const path = urlDecode(u.searchParams.get('path') || '/');
            const host = u.searchParams.get('host') || u.hostname;
            if (ttype !== 'tcp') {
                outbound.transport = { type: ttype, path: path, headers: { Host: host } };
            }
            const sec = u.searchParams.get('security') || 'none';
            if (sec === 'tls' || sec === 'reality') {
                outbound.tls = {
                    enabled: true,
                    server_name: u.searchParams.get('sni') || u.hostname,
                    insecure: u.searchParams.get('insecure') === '1' || u.searchParams.get('allowInsecure') === '1',
                    utls: { enabled: true, fingerprint: u.searchParams.get('fp') || 'chrome' }
                };
                if (sec === 'reality') {
                    outbound.tls.reality = {
                        enabled: true,
                        public_key: u.searchParams.get('pbk') || '',
                        short_id: u.searchParams.get('sid') || ''
                    };
                }
            }
            break;
        }
        case 'vmess': {
            // VMess 链接是 base64 编码的 JSON
            let b64 = content;
            while (b64.length % 4 !== 0) b64 += '=';
            let decoded;
            try {
                decoded = JSON.parse(Buffer.from(b64, 'base64').toString());
            } catch (e) {
                throw new Error(`VMess 解码失败: ${e.message}`);
            }
            outbound = {
                ...outbound,
                type: 'vmess',
                server: decoded.add || '',
                server_port: parseInt(decoded.port) || 443,
                uuid: decoded.id || '',
                security: decoded.scy || 'auto',
                transport: {
                    type: decoded.net || 'tcp',
                    path: urlDecode(decoded.path || '/'),
                    headers: { Host: decoded.host || decoded.add || '' }
                },
                tls: {
                    enabled: (decoded.tls === 'tls'),
                    server_name: decoded.sni || decoded.host || decoded.add || '',
                    insecure: decoded.insecure === '1' || decoded.allowInsecure === '1',
                    utls: { enabled: true, fingerprint: decoded.fp || 'chrome' }
                }
            };
            break;
        }
        case 'trojan': {
            outbound = {
                ...outbound,
                type: 'trojan',
                server: u.hostname,
                server_port: parseInt(u.port) || 443,
                password: u.username,
                tls: {
                    enabled: true,
                    server_name: u.searchParams.get('sni') || u.hostname,
                    insecure: u.searchParams.get('insecure') === '1' || u.searchParams.get('allowInsecure') === '1',
                    utls: { enabled: true, fingerprint: u.searchParams.get('fp') || 'chrome' }
                }
            };
            const ttype = u.searchParams.get('type') || 'tcp';
            const path = urlDecode(u.searchParams.get('path') || '/');
            const host = u.searchParams.get('host') || u.hostname;
            if (ttype !== 'tcp') {
                outbound.transport = { type: ttype, path: path, headers: { Host: host } };
            }
            break;
        }
        case 'hysteria2':
        case 'hy2': {
            outbound = {
                ...outbound,
                type: 'hysteria2',
                server: u.hostname,
                server_port: parseInt(u.port) || 443,
                up_mbps: parseInt(u.searchParams.get('up')) || 100,
                down_mbps: parseInt(u.searchParams.get('down')) || 100,
                password: decodeURIComponent(u.username),
                tls: {
                    enabled: true,
                    server_name: u.searchParams.get('sni') || u.hostname,
                    insecure: u.searchParams.get('insecure') === '1' || u.searchParams.get('allowInsecure') === '1'
                }
            };
            const obfs = u.searchParams.get('obfs');
            if (obfs) {
                outbound.obfs = { type: 'salamander', password: obfs };
            }
            break;
        }
        case 'tuic': {
            const uuidPass = u.username;
            const uuid = uuidPass.includes('%3A') ? uuidPass.split('%3A')[0] : uuidPass.split(':')[0] || uuidPass;
            const pwd = uuidPass.includes('%3A') ? uuidPass.split('%3A')[1] : uuidPass.includes(':') ? uuidPass.split(':')[1] : '';
            outbound = {
                ...outbound,
                type: 'tuic',
                server: u.hostname,
                server_port: parseInt(u.port) || 443,
                uuid: uuid,
                password: pwd || u.searchParams.get('password') || '',
                congestion_control: u.searchParams.get('congestion_control') || 'bbr',
                udp_over_stream: u.searchParams.get('udp_over_stream') !== 'false',
                zero_rtt_handshake: u.searchParams.get('zero_rtt_handshake') === 'true',
                tls: {
                    enabled: true,
                    server_name: u.searchParams.get('sni') || u.hostname,
                    insecure: u.searchParams.get('insecure') === '1' || u.searchParams.get('allowInsecure') === '1'
                }
            };
            const alpn = u.searchParams.get('alpn');
            if (alpn) outbound.tls.alpn = [alpn];
            break;
        }
        case 'anytls': {
            outbound = {
                ...outbound,
                type: 'anytls',
                server: u.hostname,
                server_port: parseInt(u.port) || 443,
                password: u.username,
                tls: {
                    enabled: true,
                    server_name: u.searchParams.get('sni') || u.hostname,
                    insecure: u.searchParams.get('insecure') === '1' || u.searchParams.get('allowInsecure') === '1',
                    utls: { enabled: true, fingerprint: u.searchParams.get('fp') || 'chrome' }
                }
            };
            break;
        }
        case 'socks5':
        case 'socks': {
            outbound = {
                ...outbound,
                type: 'socks',
                server: u.hostname,
                server_port: parseInt(u.port) || 1080,
                version: u.searchParams.get('version') || '5'
            };
            if (u.username) {
                outbound.username = decodeURIComponent(u.username);
                if (u.password) outbound.password = decodeURIComponent(u.password);
            }
            break;
        }
        default:
            throw new Error(`不支持的协议: ${proto}`);
    }

    return outbound;
}

function buildConfig(link, socksPort = 1080, httpPort = 1081) {
    const outbound = parseLink(link);
    return {
        log: { level: 'warn' },
        inbounds: [
            { type: 'socks', tag: 'socks-in', listen: '127.0.0.1', listen_port: socksPort },
            { type: 'http', tag: 'http-in', listen: '127.0.0.1', listen_port: httpPort }
        ],
        outbounds: [
            outbound,
            { type: 'direct', tag: 'direct' }
        ]
    };
}

module.exports = { parseLink, buildConfig };

if (require.main === module) {
    const link = (process.argv[2] || '').trim();
    const socksPort = parseInt(process.argv[3] || '1080', 10);
    const httpPort = parseInt(process.argv[4] || '1081', 10);
    const outPath = process.argv[5] || 'sing-box-config.json';
    if (!link) {
        console.error('[sing-box] 缺少代理链接');
        process.exit(1);
    }
    let config;
    try {
        config = buildConfig(link, socksPort, httpPort);
    } catch (e) {
        console.error('[sing-box] 配置生成失败:', e.message);
        process.exit(1);
    }
    fs.writeFileSync(outPath, JSON.stringify(config, null, 2));
    console.log(`[sing-box] 已生成配置 ${outPath} (SOCKS5=127.0.0.1:${socksPort}, HTTP=127.0.0.1:${httpPort})`);
}