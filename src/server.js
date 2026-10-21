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
  // A store escolhe-se pelo ambiente (src/db.js): com DATABASE_URL usa
  // PostgreSQL (dados persistem); sem, mantém a memória dos testes locais.
  const { selecionarStore } = require('./db');

  selecionarStore()
    .then(({ store, usandoPg }) => {
      const { http, attach } = createServer({ store });
      // O hub WebSocket (presença, sessões de filme e chamadas — tarefas 5–8)
      // tem de estar montado no arranque; os testes chamam attach() à parte.
      const wss = attach();
      http.listen(port, () => {
        const onde = usandoPg ? 'Postgres' : 'memória';
        console.log(`Machine Video a escutar em http://localhost:${port} (store: ${onde})`);
      });

      // Render/infra mandam SIGTERM ao reiniciar o serviço: fecha WS, HTTP e
      // a ligação à base de dados antes de sair.
      async function encerrar() {
        wss.close();
        http.close();
        if (typeof store.close === 'function') await store.close();
        process.exit(0);
      }
      process.on('SIGTERM', () => encerrar().catch(() => process.exit(0)));
      process.on('SIGINT', () => encerrar().catch(() => process.exit(0)));
    })
    .catch((erro) => {
      // Ex.: DATABASE_URL mal formada ou Postgres inalcançável — falha visível
      // no arranque, não um servidor "vivo" com a API avariada.
      console.error('Falha ao arrancar o servidor:', erro.message);
      process.exit(1);
    });
}

module.exports = { createServer };
