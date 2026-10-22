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

async function registarUtilizador(username, password) {
  const resposta = await jsonFetch('/api/register', {
    method: 'POST',
    body: { username, password, secQuestion: PERGUNTA, secAnswer: 'rex' },
  });
  assert.strictEqual(resposta.status, 200, `registro de ${username} falhou`);
  return resposta.json();
}

test('ciclo completo: registra, loga, /api/me com Bearer e logout invalida o token', async () => {
  const registro = await registarUtilizador('ana_ciclo', 'senha123');
  assert.deepStrictEqual(Object.keys(registro).sort(), ['userId']);
  assert.ok(registro.userId, 'registro devolve userId');

  const loginRes = await jsonFetch('/api/login', {
    method: 'POST',
    body: { username: 'ana_ciclo', password: 'senha123' },
  });
  assert.strictEqual(loginRes.status, 200);
  const login = await loginRes.json();
  assert.match(login.token, /^[0-9a-f]{64}$/, 'token sao 32 bytes em hex');
  assert.deepStrictEqual(Object.keys(login.user).sort(), ['id', 'phone', 'username']);
  assert.strictEqual(login.user.id, registro.userId);
  assert.strictEqual(login.user.username, 'ana_ciclo');

  const meRes = await jsonFetch('/api/me', { token: login.token });
  assert.strictEqual(meRes.status, 200);
  assert.deepStrictEqual(await meRes.json(), {
    user: { id: registro.userId, username: 'ana_ciclo', phone: null },
  });

  const logoutRes = await jsonFetch('/api/logout', { method: 'POST', token: login.token });
  assert.strictEqual(logoutRes.status, 200);
  assert.deepStrictEqual(await logoutRes.json(), { ok: true });

  const meDepois = await jsonFetch('/api/me', { token: login.token });
  assert.strictEqual(meDepois.status, 401, 'token invalido apos logout');
});

test('registro com username duplicado responde 409', async () => {
  await registarUtilizador('dup_user', 'senha123');
  const resposta = await jsonFetch('/api/register', {
    method: 'POST',
    body: { username: 'dup_user', password: 'outra456', secQuestion: PERGUNTA, secAnswer: 'rex' },
  });
  assert.strictEqual(resposta.status, 409);
  const corpo = await resposta.json();
  assert.strictEqual(corpo.ok, false);
  assert.match(corpo.erro, /existe/i);
});

test('login com senha errada ou utilizador desconhecido responde 401', async () => {
  await registarUtilizador('login_user', 'senha123');

  const senhaErrada = await jsonFetch('/api/login', {
    method: 'POST',
    body: { username: 'login_user', password: 'errada999' },
  });
  assert.strictEqual(senhaErrada.status, 401);

  const desconhecido = await jsonFetch('/api/login', {
    method: 'POST',
    body: { username: 'ninguem_aqui', password: 'senha123' },
  });
  assert.strictEqual(desconhecido.status, 401);
});

test('registro com senha curta (menos de 6) responde 400', async () => {
  const resposta = await jsonFetch('/api/register', {
    method: 'POST',
    body: { username: 'curta_user', password: 'abc12', secQuestion: PERGUNTA, secAnswer: 'rex' },
  });
  assert.strictEqual(resposta.status, 400);
});

test('recuperacao troca a senha e a antiga deixa de logar', async () => {
  await registarUtilizador('rita_rec', 'velha123');

  const resposta = await jsonFetch('/api/recover', {
    method: 'POST',
    body: { username: 'rita_rec', secAnswer: 'rex', newPassword: 'nova456' },
  });
  assert.strictEqual(resposta.status, 200);
  assert.deepStrictEqual(await resposta.json(), { ok: true });

  const comVelha = await jsonFetch('/api/login', {
    method: 'POST',
    body: { username: 'rita_rec', password: 'velha123' },
  });
  assert.strictEqual(comVelha.status, 401, 'senha antiga nao loga mais');

  const comNova = await jsonFetch('/api/login', {
    method: 'POST',
    body: { username: 'rita_rec', password: 'nova456' },
  });
  assert.strictEqual(comNova.status, 200, 'senha nova loga');
});

test('recuperacao com resposta de seguranca errada responde 401', async () => {
  await registarUtilizador('carl_rec', 'senha123');
  const resposta = await jsonFetch('/api/recover', {
    method: 'POST',
    body: { username: 'carl_rec', secAnswer: 'errada', newPassword: 'nova456' },
  });
  assert.strictEqual(resposta.status, 401);
});

test('recuperacao de utilizador desconhecido responde 404', async () => {
  const resposta = await jsonFetch('/api/recover', {
    method: 'POST',
    body: { username: 'fantasma', secAnswer: 'rex', newPassword: 'nova456' },
  });
  assert.strictEqual(resposta.status, 404);
});

test('recuperacao com senha nova curta responde 400', async () => {
  await registarUtilizador('dora_rec', 'senha123');
  const resposta = await jsonFetch('/api/recover', {
    method: 'POST',
    body: { username: 'dora_rec', secAnswer: 'rex', newPassword: '123' },
  });
  assert.strictEqual(resposta.status, 400);
});

test('sessao em falta ou token invalido responde 401 em /api/me e /api/logout', async () => {
  const meSemToken = await jsonFetch('/api/me');
  assert.strictEqual(meSemToken.status, 401);

  const meTokenFalso = await jsonFetch('/api/me', { token: 'f'.repeat(64) });
  assert.strictEqual(meTokenFalso.status, 401);

  const logoutTokenFalso = await jsonFetch('/api/logout', {
    method: 'POST',
    token: 'f'.repeat(64),
  });
  assert.strictEqual(logoutTokenFalso.status, 401);
});
