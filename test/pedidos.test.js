'use strict';

/**
 * Testes do ciclo COMPLETO de pedidos de amizade (v1.1): recusar o recebido,
 * cancelar o enviado, terceiros bloqueados e o par liberado para novo pedido.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { createServer } = require('../src/server');
const { createStoreMemory } = require('../src/store-memory');

async function arranque() {
  const store = createStoreMemory();
  const { http } = createServer({ store });
  await new Promise((resolver) => http.listen(0, '127.0.0.1', resolver));
  const base = `http://127.0.0.1:${http.address().port}`;
  return { store, base, fechar: async () => { http.closeAllConnections?.(); await new Promise((r) => http.close(r)); } };
}

async function registarEEntrar(base, username) {
  await fetch(`${base}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'senha123', secQuestion: 'q?', secAnswer: 'a' }),
  });
  return (await (await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'senha123' }),
  })).json());
}

const pedidoAmizade = (base, token, contacto) => fetch(`${base}/api/friends/request`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ contacto }),
});

const acao = (base, token, rid) => fetch(`${base}/api/friends/reject`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ requestId: rid }),
});

const amigosDe = async (base, token) =>
  (await (await fetch(`${base}/api/friends`, { headers: { Authorization: `Bearer ${token}` } })).json());

test('ciclo completo: recusar o recebido limpa as duas listas e LIBERA novo pedido', async () => {
  const app = await arranque();
  try {
    const a = await registarEEntrar(app.base, 'cic_ana');
    const b = await registarEEntrar(app.base, 'cic_bruno');

    const pedido = await (await pedidoAmizade(app.base, a.token, 'cic_bruno')).json();
    const amigosB = await amigosDe(app.base, b.token);
    const rid = amigosB.pendingIn[0].id;

    // BRUNO RECUSA.
    assert.equal((await acao(app.base, b.token, rid)).status, 200);
    const depoisB = await amigosDe(app.base, b.token);
    assert.equal(depoisB.pendingIn.length, 0, 'pendentesIn limpo');
    const depoisA = await amigosDe(app.base, a.token);
    assert.equal(depoisA.pendingOut.length, 0, 'pendentesOut limpo');
    assert.equal(depoisB.friends.length, 0, 'não viraram amigos');

    // O par fica LIVRE: novo pedido funciona.
    assert.equal((await pedidoAmizade(app.base, a.token, 'cic_bruno')).status, 201);
  } finally {
    await app.fechar();
  }
});

test('cancelar o pedido ENVIADO: o remetente também pode remover', async () => {
  const app = await arranque();
  try {
    const a = await registarEEntrar(app.base, 'can_ana');
    await registarEEntrar(app.base, 'can_bruno');
    const envio = await (await pedidoAmizade(app.base, a.token, 'can_bruno')).json();
    const meus = await amigosDe(app.base, a.token);
    const rid = meus.pendingOut[0].id;
    assert.equal(envio.requestId, rid);

    assert.equal((await acao(app.base, a.token, rid)).status, 200);
    const depois = await amigosDe(app.base, a.token);
    assert.equal(depois.pendingOut.length, 0, 'pedido cancelado');
  } finally {
    await app.fechar();
  }
});

test('terceiro alheio → E_FORBIDDEN (403); pedido aceite → E_DUP (409)', async () => {
  const app = await arranque();
  try {
    const a = await registarEEntrar(app.base, 'for_ana');
    const b = await registarEEntrar(app.base, 'for_bruno');
    const carla = await registarEEntrar(app.base, 'for_carla');

    await pedidoAmizade(app.base, a.token, 'for_bruno');
    const amigosB = await amigosDe(app.base, b.token);
    const rid = amigosB.pendingIn[0].id;

    // Carla não é parte do pedido.
    assert.equal((await acao(app.base, carla.token, rid)).status, 403);

    // Aceite → recusar depois é E_DUP (a amizade já existe).
    await fetch(`${app.base}/api/friends/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${b.token}` },
      body: JSON.stringify({ requestId: rid }),
    });
    assert.equal((await acao(app.base, b.token, rid)).status, 409);
  } finally {
    await app.fechar();
  }
});
