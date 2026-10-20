'use strict';

const http = require('node:http');
const path = require('node:path');

const { createRouter } = require('./routes');
const { criarHub } = require('./ws');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function createServer({ store } = {}) {
  const handle = createRouter({ store, publicDir: PUBLIC_DIR });
  const server = http.createServer(handle);

  // Liga um servidor WebSocket ao HTTP existente e monta o hub (auth por
  // envelope, presença a amigos e robustez — Task 5). `authTimeoutMs` é
  // opcional (útil em testes); a produção usa os 5 s por omissão.
  function attach(wsOptions = {}) {
    const { authTimeoutMs, ...opcoesWss } = wsOptions;
    const { WebSocketServer } = require('ws');
    const wss = new WebSocketServer({ server, ...opcoesWss });
    criarHub({ store, wss, authTimeoutMs });
    return wss;
  }

  return { http: server, attach };
}

if (require.main === module) {
  const port = process.env.PORT || 3000;
  const { http } = createServer({ store: {} }); // store em memória por agora
  http.listen(port, () => {
    console.log(`Machine Video a escutar em http://localhost:${port}`);
  });
}

module.exports = { createServer };
