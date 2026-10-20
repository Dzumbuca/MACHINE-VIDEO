'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { createAuthHandlers } = require('./auth');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function createRouter({ store, publicDir }) {
  const auth = createAuthHandlers({ store });

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
      res.writeHead(200, { 'Content-Type': type });
      res.end(data);
    });
  }
}

module.exports = { createRouter };
