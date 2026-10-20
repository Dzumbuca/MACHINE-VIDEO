'use strict';

const http = require('node:http');
const path = require('node:path');

const { createRouter } = require('./routes');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function createServer({ store } = {}) {
  const handle = createRouter({ store, publicDir: PUBLIC_DIR });
  const server = http.createServer(handle);

  // Liga um servidor WebSocket ao HTTP existente (usado pelas tarefas seguintes).
  function attach(wsOptions = {}) {
    const { WebSocketServer } = require('ws');
    return new WebSocketServer({ server, ...wsOptions });
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
