'use strict';

/**
 * Testes do username PROVISÓRIO (v1.1): contas Google nascem com username
 * do email + usernameProvisorio=true e DEVEM escolher o definitivo:
 * POST /api/me/username (valida formato, 409 em duplicado, /api/me reflete).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { createServer } = require('../src/server');
const { createStoreMemory } = require('../src/store-memory');

async function arranque() {
  const store = createStoreMemory();
  const { http, attach } = createServer({ store });
  attach();
  await new Promise((resolver) => http.listen(0, '127.0.0.1', resolver));
  const base = `http://127.0.0.1:${http.address().port}`;
  return { store, base, fechar: async () => { http.closeAllConnections?.(); await new Promise((r) => http.close(r)); } };
}

const authHeaders = (token) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });

test('store: Google cria usernameProvisorio; setUsername limpa e valida E_DUP', () => {
  const store = createStoreMemory();
  const u = store.createUserWithGoogle({ username: 'joaquim', email: 'j@gmail.com', googleId: 'sub-1' });
  assert.equal(u.usernameProvisorio, true);
  const novo = store.setUsername(u.id, 'joaquimzumbuca');
  assert.equal(novo.username, 'joaquimzumbuca');
  assert.equal(novo.usernameProvisorio, false);
  // duplicado de OUTRO utilizador → E_DUP; o MESMO utilizador → idempotente
  const outro = store.createUser({ username: 'maria', passHash: 'h', secQ: 'q', secA: 'a' });
  assert.throws(() => store.setUsername(outro.id, 'joaquimzumbuca'), /já existe/);
  assert.equal(store.setUsername(u.id, 'joaquimzumbuca').username, 'joaquimzumbuca');
  // o nome antigo ficou LIVRE para novos registos
  assert.equal(store.createUser({ username: 'joaquim', passHash: 'h', secQ: 'q', secA: 'a' }).username, 'joaquim');
});

test('HTTP: /api/me/username — formato inválido 400, duplicado 409, sucesso reflete no /api/me', async () => {
  const app = await arranque();
  try {
    const store = app.store;
    const u = store.createUserWithGoogle({ username: 'provisorio', email: 'p@gmail.com', googleId: 'sub-p' });
    const token = store.createSession(u.id);

    // formato inválido → 400
    const mau = await fetch(`${app.base}/api/me/username`, {
      method: 'POST', headers: authHeaders(token),
      body: JSON.stringify({ username: 'nome com espaços!' }),
    });
    assert.equal(mau.status, 400);

    // duplicado → 409
    store.createUser({ username: 'ocupado', passHash: 'h', secQ: 'q', secA: 'a' });
    const dup = await fetch(`${app.base}/api/me/username`, {
      method: 'POST', headers: authHeaders(token),
      body: JSON.stringify({ username: 'ocupado' }),
    });
    assert.equal(dup.status, 409);

    // sucesso → usernameProvisorio false no /api/me
    const ok = await (await fetch(`${app.base}/api/me/username`, {
      method: 'POST', headers: authHeaders(token),
      body: JSON.stringify({ username: 'nomefinal' }),
    })).json();
    assert.equal(ok.user.username, 'nomefinal');
    assert.equal(ok.user.usernameProvisorio, false);
    const me = await (await fetch(`${app.base}/api/me`, { headers: authHeaders(token) })).json();
    assert.equal(me.user.usernameProvisorio, false);
  } finally {
    await app.fechar();
  }
});
