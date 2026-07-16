/* Live read-only chain data for the docs pages. No dependencies, no backend:
   these are plain JSON-RPC calls against the public Robinhood Chain RPC, so
   they work directly on GitHub Pages. Payment safety: this file NEVER signs,
   sends, or constructs a spend - it only reads block height and the USDG
   token's decimals/symbol. */
(function () {
  'use strict';

  var NETWORKS = {
    mainnet: {
      chainId: 4663,
      rpc: 'https://rpc.mainnet.chain.robinhood.com',
      usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
      explorer: 'https://robinhoodchain.blockscout.com'
    },
    testnet: {
      chainId: 46630,
      rpc: 'https://rpc.testnet.chain.robinhood.com',
      usdg: '0x7E955252E15c84f5768B83c41a71F9eba181802F',
      explorer: 'https://explorer.testnet.chain.robinhood.com'
    }
  };

  function rpc(url, method, params) {
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: params || [] })
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.error) throw new Error(j.error.message || 'rpc error');
        return j.result;
      });
  }

  // Decode an ABI-encoded uint8 (decimals) from a 32-byte hex word.
  function decodeUint(hex) {
    return parseInt(hex, 16);
  }

  // Decode an ABI-encoded dynamic string (offset, length, bytes).
  function decodeString(hex) {
    var data = hex.slice(2);
    var len = parseInt(data.slice(64, 128), 16);
    var bytes = data.slice(128, 128 + len * 2);
    var out = '';
    for (var i = 0; i < bytes.length; i += 2) out += String.fromCharCode(parseInt(bytes.substr(i, 2), 16));
    return out;
  }

  function setText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function blockHeight(name) {
    var net = NETWORKS[name];
    return rpc(net.rpc, 'eth_blockNumber').then(function (hex) {
      return parseInt(hex, 16);
    });
  }

  function usdgInfo(name) {
    var net = NETWORKS[name];
    // decimals() selector 0x313ce567, symbol() selector 0x95d89b41
    return Promise.all([
      rpc(net.rpc, 'eth_call', [{ to: net.usdg, data: '0x313ce567' }, 'latest']),
      rpc(net.rpc, 'eth_call', [{ to: net.usdg, data: '0x95d89b41' }, 'latest'])
    ]).then(function (r) {
      return { decimals: decodeUint(r[0]), symbol: decodeString(r[1]) };
    });
  }

  // Public API for pages that want raw access.
  window.HoodPayLive = { NETWORKS: NETWORKS, rpc: rpc, blockHeight: blockHeight, usdgInfo: usdgInfo };

  // Auto-populate the status strip if present.
  function refreshStrip() {
    blockHeight('mainnet').then(function (n) {
      setText('mainnet-block', '#' + n.toLocaleString());
    }).catch(function () { setText('mainnet-block', 'unreachable'); });

    blockHeight('testnet').then(function (n) {
      setText('testnet-block', '#' + n.toLocaleString());
    }).catch(function () { setText('testnet-block', 'unreachable'); });

    usdgInfo('mainnet').then(function (info) {
      setText('usdg-info', info.symbol + ' · ' + info.decimals + ' decimals');
    }).catch(function () { setText('usdg-info', 'unreachable'); });
  }

  if (document.getElementById('mainnet-block') || document.getElementById('usdg-info')) {
    document.addEventListener('DOMContentLoaded', function () {
      refreshStrip();
      setInterval(refreshStrip, 12000);
    });
  }
})();
