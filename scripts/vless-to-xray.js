/**
 * 将 vless:// 链接（TLS + WebSocket）解析为本地 Xray-core 配置文件。
 * 生成后会在本机监听 127.0.0.1:1080 的 Socks5 代理。
 *
 * 用法：
 *   VLESS_LINK="vless://uuid@host:port?...#remark" node scripts/vless-to-xray.js
 * 会在当前目录生成 xray-config.json
 */

const fs = require('fs');

function parseVless(link) {
  const url = new URL(link);
  if (url.protocol !== 'vless:') {
    throw new Error('这不是一个有效的 vless:// 链接');
  }

  const uuid = decodeURIComponent(url.username);
  const address = url.hostname;
  const port = Number(url.port);
  const params = url.searchParams;

  const encryption = params.get('encryption') || 'none';
  const security = params.get('security') || 'none';
  const network = params.get('type') || 'tcp';
  const sni = params.get('sni') || params.get('host') || address;
  const fp = params.get('fp') || '';
  const alpnParam = params.get('alpn');
  const path = decodeURIComponent(params.get('path') || '/');
  const wsHost = params.get('host') || sni;

  const outbound = {
    protocol: 'vless',
    tag: 'proxy',
    settings: {
      vnext: [
        {
          address,
          port,
          users: [{ id: uuid, encryption, level: 0 }]
        }
      ]
    },
    streamSettings: {
      network
    }
  };

  if (network === 'ws') {
    outbound.streamSettings.wsSettings = {
      path,
      headers: { Host: wsHost }
    };
  }

  if (security === 'tls') {
    outbound.streamSettings.security = 'tls';
    outbound.streamSettings.tlsSettings = {
      serverName: sni,
      allowInsecure: false
    };
    if (fp) outbound.streamSettings.tlsSettings.fingerprint = fp;
    if (alpnParam) outbound.streamSettings.tlsSettings.alpn = alpnParam.split(',');
  }

  return {
    log: { loglevel: 'warning' },
    inbounds: [
      {
        listen: '127.0.0.1',
        port: 1080,
        protocol: 'socks',
        settings: { udp: true, auth: 'noauth' }
      }
    ],
    outbounds: [
      outbound,
      { protocol: 'freedom', tag: 'direct' },
      { protocol: 'blackhole', tag: 'block' }
    ]
  };
}

const link = process.env.VLESS_LINK;
if (!link || !link.trim()) {
  console.log('未提供 VLESS_LINK，跳过生成 Xray 配置（将使用直连模式）。');
  process.exit(0);
}

try {
  const config = parseVless(link.trim());
  fs.writeFileSync('xray-config.json', JSON.stringify(config, null, 2));
  console.log('✅ xray-config.json 已生成。');
} catch (err) {
  console.error('❌ 解析 VLESS 链接失败：', err.message);
  process.exit(1);
}
