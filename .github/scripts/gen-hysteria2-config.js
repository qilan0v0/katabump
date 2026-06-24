// 将 hysteria2:// 分享链接解析为带本地 SOCKS5 入站的 hysteria2 client config
// 用法 (CLI): node gen-hysteria2-config.js "<share-link>" <socks5-port> <out-path>
// 用法 (模块): const { buildConfig } = require('./gen-hysteria2-config'); buildConfig(link, port)
const fs = require('fs');

function parseHysteria2Link(link) {
    const u = new URL(link);
    const q = u.searchParams;

    const server = `${u.hostname}:${u.port}`;
    const auth = decodeURIComponent(u.username);

    const config = {
        server,
        auth,
        tls: {
            insecure: q.get('insecure') === '1' || q.get('insecure') === 'true',
            sni: q.get('sni') || u.hostname
        },
        socks5: {
            listen: '127.0.0.1:0' // port will be filled in by buildConfig
        }
    };

    // 可选的混淆 (obfuscation)
    const obfs = q.get('obfs');
    if (obfs) {
        config.obfs = {
            type: obfs,
            password: q.get('obfs-password') || ''
        };
    }

    // 可选的带宽参数
    const upMbps = q.get('up');
    const downMbps = q.get('down');
    if (upMbps) config.upMbps = parseInt(upMbps, 10);
    if (downMbps) config.downMbps = parseInt(downMbps, 10);

    return config;
}

function buildConfig(link, socksPort) {
    const cfg = parseHysteria2Link((link || '').trim());
    cfg.socks5.listen = `127.0.0.1:${socksPort}`;
    return cfg;
}

module.exports = { parseHysteria2Link, buildConfig };

// CLI 入口：仅在被直接执行时运行
if (require.main === module) {
    const link = (process.argv[2] || '').trim();
    const socksPort = parseInt(process.argv[3] || '10810', 10);
    const outPath = process.argv[4] || 'hysteria2-config.json';
    if (!link) {
        console.error('[hysteria2] 缺少分享链接');
        process.exit(1);
    }
    let config;
    try {
        config = buildConfig(link, socksPort);
    } catch (e) {
        console.error('[hysteria2] 配置生成失败:', e.message);
        process.exit(1);
    }
    fs.writeFileSync(outPath, JSON.stringify(config, null, 2));
    console.log(`[hysteria2] 已生成配置 ${outPath} (SOCKS5 入站=127.0.0.1:${socksPort})`);
}
