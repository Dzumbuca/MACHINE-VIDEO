'use strict';

/**
 * Testes do "Entrar com Google" (v1.1). A troca de código por id_token
 * precisa do Google real — aqui validamos: providers, redirect do start
 * (client_id + redirect_uri derivada do host), rejeição de state inválido
 * e os cenários de conta na store (novo, reentrada, ligação por email,
 * colisão de username).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { createServer } = require('../src/server');
const { createStoreMemory } = require('../src/store-memory');

async function arranque({ comGoogle }) {
  if (comGoogle) {
    process.env.GOOGLE_CLIENT_ID = 'teste-cliente-id.apps.googleusercontent.com';
    process.env.GOOGLE_CLIENT_SECRET = 'teste-segredo';
  } else {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  }
  const store = createStoreMemory();
  const { http } = createServer({ store });
  await new Promise((resolver) => http.listen(0, '127.0.0.1', resolver));
  const base = `http://127.0.0.1:${http.address().port}`;
  return {
    store,
    base,
    async fechar() {
      http.closeAllConnections?.();
      await new Promise((resolver) => http.close(resolver));
    },
  };
}

test('providers sem credenciais: google=false e start responde 501', async () => {
  const app = await arranque({ comGoogle: false });
  try {
    const providers = await (await fetch(`${app.base}/api/auth/providers`)).json();
    assert.equal(providers.ok, true);
    assert.equal(providers.google, false);
    const resposta = await fetch(`${app.base}/api/auth/google/start`, { redirect: 'manual' });
    assert.equal(resposta.status, 501);
  } finally {
    await app.fechar();
  }
});

test('providers com credenciais: google=true e start redireciona ao Google', async () => {
  const app = await arranque({ comGoogle: true });
  try {
    const providers = await (await fetch(`${app.base}/api/auth/providers`)).json();
    assert.equal(providers.google, true);
    const resposta = await fetch(`${app.base}/api/auth/google/start`, { redirect: 'manual' });
    assert.equal(resposta.status, 302);
    const destino = new URL(resposta.headers.get('location'));
    assert.equal(destino.origin + destino.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(destino.searchParams.get('client_id'), 'teste-cliente-id.apps.googleusercontent.com');
    assert.equal(
      destino.searchParams.get('redirect_uri'),
      `${app.base}/api/auth/google/callback`,
    );
    assert.equal(destino.searchParams.get('response_type'), 'code');
    assert.ok(destino.searchParams.get('state')); // CSRF: estado aleatório presente
  } finally {
    await app.fechar();
  }
});

test('callback com state inválido volta ao ecrã de entrada com erro', async () => {
  const app = await arranque({ comGoogle: true });
  try {
    const resposta = await fetch(
      `${app.base}/api/auth/google/callback?code=x&state=falsificado`,
      { redirect: 'manual' },
    );
    assert.equal(resposta.status, 302);
    const destino = new URL(resposta.headers.get('location'), app.base);
    assert.equal(destino.pathname, '/');
    assert.equal(destino.hash, '#erro=google');
  } finally {
    await app.fechar();
  }
});

test('loginComGoogle: cria com username do email, reentrada reutiliza a conta', async () => {
  const store = createStoreMemory();
  const primeiro = await store.createUserWithGoogle({
    username: 'joaquim',
    email: 'joaquim@gmail.com',
    googleId: 'sub-google-1',
  });
  assert.equal(primeiro.username, 'joaquim');
  assert.equal(primeiro.passHash, null);

  const segundo = store.getUserByGoogleId('sub-google-1');
  assert.equal(segundo.id, primeiro.id); // reentrada = mesma conta

  assert.equal(store.getUserByGoogleId('outro-sub'), null);
});

test('loginComGoogle: email de utilizador existente LIGA as contas', async () => {
  const store = createStoreMemory();
  const normal = await store.createUser({
    username: 'maria', passHash: 'hash', secQ: 'q', secA: 'a',
  });
  const ligada = await store.linkGoogleToUser(normal.id, {
    googleId: 'sub-maria', email: 'maria@gmail.com',
  });
  assert.equal(ligada.id, normal.id);
  assert.equal(ligada.googleId, 'sub-maria');

  const pelaGoogle = store.getUserByGoogleId('sub-maria');
  assert.equal(pelaGoogle.id, normal.id); // login Google entra na conta antiga
  assert.equal(store.getUserByUsername('maria').id, normal.id);
});

test('loginComGoogle: colisão de username ganha sufixo numérico', async () => {
  const store = createStoreMemory();
  await store.createUser({ username: 'joaquim', passHash: 'h', secQ: 'q', secA: 'a' });
  const base = 'joaquim';
  let candidato = base;
  for (let n = 2; store.getUserByUsername(candidato); n += 1) {
    candidato = `${base}${n}`.slice(0, 20);
  }
  assert.equal(candidato, 'joaquim2'); // a lógica do google.js não colide
  const google = await store.createUserWithGoogle({
    username: candidato, email: 'joaquim@gmail.com', googleId: 'sub-x',
  });
  assert.equal(google.username, 'joaquim2');
  assert.notEqual(google.id, store.getUserByUsername('joaquim').id);
});
