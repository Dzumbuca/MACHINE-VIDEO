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
    // maxPayload de 1 MiB por omissão: os frames são parseados ANTES da
    // autenticação e o default do ws (100 MiB) deixa qualquer anónimo
    // derrubar um container pequeno com alguns frames gigantes (OOM).
    // SDP/ICE e o chat (texto capado a 2000 caracteres) cabem de sobra;
    // as opções de quem chama podem sobrepor.
    const wss = new WebSocketServer({
      server,
      maxPayload: 1024 * 1024,
      ...opcoesWss,
    });
    // Ponte de tempo real (v1.1): com DATABASE_URL, envelopes atravessam
    // servidores (Render ↔ PC) via pg_notify — ver src/relay.js.
    const hub = criarHub({
      store,
      wss,
      authTimeoutMs,
      rele: process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : null,
    });
    // O fecho gracioso do rele fica no encerramento do processo (SIGTERM):
    // attach() pode ser chamado várias vezes nos testes — guardamos o parar
    // na própria instância wss para o require.main o alcançar.
    if (hub.rele) wss.rele = hub.rele;
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
        wss.rele?.parar(); // ponte de tempo real (v1.1)
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
