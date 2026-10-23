'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { createAuthHandlers } = require('./auth');
const { createFriendsHandlers } = require('./friends');
const { createChatHandlers } = require('./chat');
const { createGoogleHandlers } = require('./google');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, body) {
  // no-store: respostas de API (providers, /api/me…) nunca podem vir de
  // cache do navegador — um client velho esconde o botão do Google etc.
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function createRouter({ store, publicDir, wsNotificar = null }) {
  const auth = createAuthHandlers({ store });
  const friends = createFriendsHandlers({ store, notificar: wsNotificar });
  const chat = createChatHandlers({ store });
  const google = createGoogleHandlers({ store });


  // Despacho async com rede de segurança: um pedido abortado não pode
  // derrubar o processo (o handler sync anterior era protegido pelo Node).
  return function handle(req, res) {
    processar(req, res).catch(() => res.destroy());
  };

  async function processar(req, res) {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      sendJson(res, 400, { ok: false, erro: 'Pedido inválido' });
      return;
    }

    // Rotas REST de autenticação (Task 3): POST register/login/logout/recover
    // e GET me — ver src/auth.js.
    const rotaAuth = auth.match(req.method, pathname);
    if (rotaAuth) {
      const { status, body } = await rotaAuth(req);
      sendJson(res, status, body);
      return;
    }

    // Login com Google (v1.1): providers → estado; start/callback → redirects
    // (manipulam o res diretamente — não passam pelo despacho JSON).
    if (pathname === '/api/auth/providers') {
      sendJson(res, 200, { ok: true, ...google.providers() });
      return;
    }
    if (pathname === '/api/auth/google/start') {
      await google.iniciar(req, res);
      return;
    }
    if (pathname === '/api/auth/google/callback') {
      await google.callback(req, res, new URL(req.url, 'http://localhost'));
      return;
    }

    // Rotas REST de amizades (Task 4): GET /api/friends,
    // POST /api/friends/request e /api/friends/accept — ver src/friends.js.
    const rotaAmigos = friends.match(req.method, pathname);
    if (rotaAmigos) {
      const { status, body } = await rotaAmigos(req);
      sendJson(res, status, body);
      return;
    }

    // Rotas REST do chat (Task 6): conversas e histórico de mensagens —
    // ver src/chat.js.
    const rotaChat = chat.match(req.method, pathname);
    if (rotaChat) {
      const { status, body } = await rotaChat(req);
      sendJson(res, status, body);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, {
        'Content-Type': 'application/json; charset=utf-8',
        Allow: 'GET, HEAD',
      });
      res.end(JSON.stringify({ ok: false, erro: 'Método não permitido' }));
      return;
    }

    if (pathname === '/api/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    let relative;
    try {
      relative = decodeURIComponent(pathname);
    } catch {
      sendJson(res, 400, { ok: false, erro: 'Caminho inválido' });
      return;
    }

    relative = relative === '/' ? 'index.html' : relative.replace(/^\/+|\/+$/g, '');
    if (relative === '') {
      relative = 'index.html';
    }

    const filePath = path.normalize(path.join(publicDir, relative));
    if (filePath !== publicDir && !filePath.startsWith(publicDir + path.sep)) {
      sendJson(res, 403, { ok: false, erro: 'Acesso proibido' });
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        const status = err.code === 'ENOENT' ? 404 : 500;
        sendJson(res, status, {
          ok: false,
          erro: status === 404 ? 'Não encontrado' : 'Erro interno',
        });
        return;
      }
      const type = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      // no-cache no HTML/JS/CSS: depois de cada deploy o cliente carrega a
      // versão nova (o token vive em localStorage, não perde sessão).
      res.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  }
}

module.exports = { createRouter };
