'use strict';

/**
 * Testes dos perfis PÚBLICO/PRIVADO (v1.1):
 *   - store: default 'publico', setVisibilidade valida valores;
 *   - HTTP: utilizador PRIVADO não é encontrado por NOME (404) mas é
 *     encontrado por EMAIL (201) — a regra da descoberta em src/friends.js.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { createServer } = require('../src/server');
const { createStoreMemory } = require('../src/store-memory');

test('store: default publico; setVisibilidade valida valores', () => {
  const store = createStoreMemory();
  const u = store.createUser({ username: 'ana', passHash: 'h', secQ: 'q', secA: 'a' });
  assert.equal(u.visibilidade, 'publico');
  assert.equal(store.setVisibilidade(u.id, 'privado').visibilidade, 'privado');
  assert.throws(() => store.setVisibilidade(u.id, 'secreto'), /Visibilidade inválida/);
  assert.throws(() => store.setVisibilidade('nao-existe', 'publico'), /não encontrado|Utilizador/);
});

async function arranque() {
  const store = createStoreMemory();
  const { http } = createServer({ store });
  await new Promise((resolver) => http.listen(0, '127.0.0.1', resolver));
  const base = `http://127.0.0.1:${http.address().port}`;
  return { store, base, fechar: async () => { http.closeAllConnections?.(); await new Promise((r) => http.close(r)); } };
}

async function registarEEntrar(base, username) {
  const registrar = await fetch(`${base}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'senha123', secQuestion: 'q?', secAnswer: 'a' }),
  });
  assert.equal(registrar.status, 200);
  const login = await (await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'senha123' }),
  })).json();
  return { token: login.token, user: login.user };
}

const pedido = (base, token, contacto) => fetch(`${base}/api/friends/request`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ contacto }),
});

test('utilizador PRIVADO: invisível por NOME, encontrável por EMAIL', async () => {
  const app = await arranque();
  try {
    const a = await registarEEntrar(app.base, 'vis_ana');
    const b = await registarEEntrar(app.base, 'vis_bruno');

    // Ana torna-se privada e recebe um email (conta clássica ligada ao Google).
    assert.equal((await store(app).setVisibilidade(a.user.id, 'privado')).visibilidade, 'privado');
    await store(app).linkGoogleToUser(a.user.id, {
      googleId: 'sub-vis-ana', email: 'vis_ana@gmail.com',
    });

    // Por NOME: 404 — privado não aparece.
    const porNome = await pedido(app.base, b.token, 'vis_ana');
    assert.equal(porNome.status, 404, 'privado não é encontrável por username');

    // Por EMAIL: 201 — quem tem o email encontra.
    const porEmail = await pedido(app.base, b.token, 'vis_ana@gmail.com');
    assert.equal(porEmail.status, 201, 'privado é encontrável pelo email');

    // Sem sessão: 401.
    const semSessao = await pedido(app.base, 'token-invalido', 'vis_ana');
    assert.equal(semSessao.status, 401);
  } finally {
    await app.fechar();
  }
});

// Acesso à store do servidor de teste (o arranque devolve-a).
function store(app) { return app.store; }
