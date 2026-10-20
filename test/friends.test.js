'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { createServer } = require('../src/server');
const { createStoreMemory } = require('../src/store-memory');

let http;
let baseUrl;

before(async () => {
  ({ http } = createServer({ store: createStoreMemory() }));
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${http.address().port}`;
});

after(async () => {
  await new Promise((resolve) => {
    http.close(() => resolve());
    http.closeAllConnections();
  });
});

const PERGUNTA = 'Qual o nome do seu primeiro animal de estimacao?';

function jsonFetch(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Regista e loga um utilizador; devolve { userId, token }. */
async function registarELogar(username) {
  const registro = await jsonFetch('/api/register', {
    method: 'POST',
    body: { username, password: 'senha123', secQuestion: PERGUNTA, secAnswer: 'rex' },
  });
  assert.strictEqual(registro.status, 200, `registro de ${username} falhou`);
  const { userId } = await registro.json();

  const login = await jsonFetch('/api/login', {
    method: 'POST',
    body: { username, password: 'senha123' },
  });
  assert.strictEqual(login.status, 200, `login de ${username} falhou`);
  const { token } = await login.json();
  return { userId, token };
}

test('ciclo completo: A pede a B, B aceita e ambos se listam como amigos', async () => {
  const a = await registarELogar('amz_ana');
  const b = await registarELogar('amz_bruno');

  // Antes de qualquer pedido, as listas começam vazias
  const inicio = await jsonFetch('/api/friends', { token: a.token });
  assert.strictEqual(inicio.status, 200);
  const corpoInicio = await inicio.json();
  assert.deepStrictEqual(
    Object.keys(corpoInicio).sort(),
    ['friends', 'pendingIn', 'pendingOut'],
    'resposta GET /api/friends tem as tres listas',
  );
  assert.deepStrictEqual(corpoInicio.friends, []);
  assert.deepStrictEqual(corpoInicio.pendingIn, []);
  assert.deepStrictEqual(corpoInicio.pendingOut, []);

  // A pede amizade a B
  const pedido = await jsonFetch('/api/friends/request', {
    method: 'POST',
    token: a.token,
    body: { username: 'amz_bruno' },
  });
  assert.strictEqual(pedido.status, 201);
  const corpoPedido = await pedido.json();
  assert.ok(corpoPedido.requestId, 'a criacao devolve o id do pedido');

  // B ve o pedido em pendingIn; A ve o mesmo pedido em pendingOut
  const listaB = await jsonFetch('/api/friends', { token: b.token });
  assert.strictEqual(listaB.status, 200);
  const corpoB = await listaB.json();
  assert.deepStrictEqual(corpoB.friends, [], 'ainda nao sao amigos');
  assert.strictEqual(corpoB.pendingIn.length, 1);
  assert.strictEqual(corpoB.pendingIn[0].id, corpoPedido.requestId);
  assert.deepStrictEqual(corpoB.pendingIn[0].from, {
    id: a.userId,
    username: 'amz_ana',
  });

  const listaA = await jsonFetch('/api/friends', { token: a.token });
  const corpoA = await listaA.json();
  assert.strictEqual(corpoA.pendingOut.length, 1);
  assert.strictEqual(corpoA.pendingOut[0].id, corpoPedido.requestId);
  assert.deepStrictEqual(corpoA.pendingOut[0].to, {
    id: b.userId,
    username: 'amz_bruno',
  });

  // B aceita
  const aceitar = await jsonFetch('/api/friends/accept', {
    method: 'POST',
    token: b.token,
    body: { requestId: corpoPedido.requestId },
  });
  assert.strictEqual(aceitar.status, 200);

  // Ambos se listam mutuamente como amigos e os pendentes desaparecem
  const finalB = await (await jsonFetch('/api/friends', { token: b.token })).json();
  assert.deepStrictEqual(finalB.friends, [{ id: a.userId, username: 'amz_ana' }]);
  assert.deepStrictEqual(finalB.pendingIn, []);
  assert.deepStrictEqual(finalB.pendingOut, []);

  const finalA = await (await jsonFetch('/api/friends', { token: a.token })).json();
  assert.deepStrictEqual(finalA.friends, [{ id: b.userId, username: 'amz_bruno' }]);
  assert.deepStrictEqual(finalA.pendingIn, []);
  assert.deepStrictEqual(finalA.pendingOut, []);
});

test('pedido duplicado responde 409, inclusive no sentido inverso', async () => {
  const a = await registarELogar('amz_dup_ana');
  const b = await registarELogar('amz_dup_bruno');

  const primeiro = await jsonFetch('/api/friends/request', {
    method: 'POST',
    token: a.token,
    body: { username: 'amz_dup_bruno' },
  });
  assert.strictEqual(primeiro.status, 201);

  // A repete o mesmo pedido
  const repetido = await jsonFetch('/api/friends/request', {
    method: 'POST',
    token: a.token,
    body: { username: 'amz_dup_bruno' },
  });
  assert.strictEqual(repetido.status, 409);

  // Com o pedido pendente, B tambem nao pode abrir um novo na direcao oposta
  const inverso = await jsonFetch('/api/friends/request', {
    method: 'POST',
    token: b.token,
    body: { username: 'amz_dup_ana' },
  });
  assert.strictEqual(inverso.status, 409);
});

test('pedido de amizade a si proprio responde 400', async () => {
  const a = await registarELogar('amz_auto_ana');
  const resposta = await jsonFetch('/api/friends/request', {
    method: 'POST',
    token: a.token,
    body: { username: 'amz_auto_ana' },
  });
  assert.strictEqual(resposta.status, 400);
  const corpo = await resposta.json();
  assert.strictEqual(corpo.ok, false);
});

test('aceitar pedido cujo destinatario e outro utilizador responde 403', async () => {
  const a = await registarELogar('amz_alh_ana');
  const b = await registarELogar('amz_alh_bruno');
  const c = await registarELogar('amz_alh_carla');

  const pedido = await jsonFetch('/api/friends/request', {
    method: 'POST',
    token: a.token,
    body: { username: 'amz_alh_bruno' },
  });
  assert.strictEqual(pedido.status, 201);
  const { requestId } = await pedido.json();

  // C nao e o destinatario do pedido de A para B
  const intrusa = await jsonFetch('/api/friends/accept', {
    method: 'POST',
    token: c.token,
    body: { requestId },
  });
  assert.strictEqual(intrusa.status, 403);

  // E a amizade nao ficou criada por engano
  const corpoC = await (await jsonFetch('/api/friends', { token: c.token })).json();
  assert.deepStrictEqual(corpoC.friends, []);
});

test('pedido para username desconhecido responde 404', async () => {
  const a = await registarELogar('amz_fant_ana');
  const resposta = await jsonFetch('/api/friends/request', {
    method: 'POST',
    token: a.token,
    body: { username: 'ninguem_com_este_nome' },
  });
  assert.strictEqual(resposta.status, 404);
  const corpo = await resposta.json();
  assert.strictEqual(corpo.ok, false);
});

test('sem token ou token invalido responde 401 nos endpoints de amizades', async () => {
  const lista = await jsonFetch('/api/friends');
  assert.strictEqual(lista.status, 401);

  const pedido = await jsonFetch('/api/friends/request', {
    method: 'POST',
    body: { username: 'qualquer' },
  });
  assert.strictEqual(pedido.status, 401);

  const aceitar = await jsonFetch('/api/friends/accept', {
    method: 'POST',
    token: 'f'.repeat(64),
    body: { requestId: 'x' },
  });
  assert.strictEqual(aceitar.status, 401);
});

test('aceitar o mesmo pedido duas vezes responde 409', async () => {
  const a = await registarELogar('amz_dpa_ana');
  const b = await registarELogar('amz_dpa_bruno');

  const pedido = await jsonFetch('/api/friends/request', {
    method: 'POST',
    token: a.token,
    body: { username: 'amz_dpa_bruno' },
  });
  assert.strictEqual(pedido.status, 201);
  const { requestId } = await pedido.json();

  const primeira = await jsonFetch('/api/friends/accept', {
    method: 'POST',
    token: b.token,
    body: { requestId },
  });
  assert.strictEqual(primeira.status, 200);

  const segunda = await jsonFetch('/api/friends/accept', {
    method: 'POST',
    token: b.token,
    body: { requestId },
  });
  assert.strictEqual(segunda.status, 409);
});

test('aceitar pedido inexistente responde 404', async () => {
  const b = await registarELogar('amz_nop_bruno');
  const resposta = await jsonFetch('/api/friends/accept', {
    method: 'POST',
    token: b.token,
    body: { requestId: '00000000-0000-4000-8000-000000000000' },
  });
  assert.strictEqual(resposta.status, 404);
});
