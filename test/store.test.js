'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { StoreError } = require('../src/store');
const { createStoreMemory } = require('../src/store-memory');

function criaUser(store, username) {
  return store.createUser({
    username,
    passHash: `hash-${username}`,
    secQ: 'Qual o apelido da sua mãe?',
    secA: 'silva',
  });
}

function erroDeCodigo(fn, code) {
  assert.throws(
    fn,
    (err) => err instanceof StoreError && err.code === code,
    `esperado StoreError com código ${code}`,
  );
}

test('ciclo completo: 2 users, amizade, conversa e 2 mensagens', () => {
  const store = createStoreMemory();

  // 2 users
  const alice = criaUser(store, 'alice');
  const bob = criaUser(store, 'bob');
  assert.ok(alice.id, 'user criado tem id');
  assert.strictEqual(alice.username, 'alice');

  // E_DUP no username repetido
  erroDeCodigo(() => criaUser(store, 'alice'), 'E_DUP');

  // amizade: pedido + aceitação
  erroDeCodigo(() => store.createFriendRequest(alice.id, alice.id), 'E_SELF');
  const pedido = store.createFriendRequest(alice.id, bob.id);
  assert.ok(pedido.id, 'pedido de amizade tem id');
  erroDeCodigo(() => store.createFriendRequest(alice.id, bob.id), 'E_DUP');
  store.acceptFriendRequest(pedido.id, bob.id);

  assert.deepStrictEqual(
    store.listFriends(alice.id).map((u) => u.username),
    ['bob'],
  );
  assert.deepStrictEqual(
    store.listFriends(bob.id).map((u) => u.username),
    ['alice'],
  );
  assert.strictEqual(store.areFriends(alice.id, bob.id), true);
  assert.strictEqual(store.areFriends(bob.id, alice.id), true);

  // conversa direta
  const conv = store.createConversation([alice.id, bob.id], false, null);
  assert.ok(conv.id, 'conversa tem id');
  assert.strictEqual(store.isMember(conv.id, alice.id), true);
  assert.strictEqual(store.isMember(conv.id, bob.id), true);

  // 2 mensagens
  const m1 = store.appendMessage(conv.id, alice.id, 'primeira');
  const m2 = store.appendMessage(conv.id, bob.id, 'segunda');
  assert.ok(m1.id, 'mensagem tem id');
  assert.ok(m1.ts, 'mensagem tem ts');
  assert.ok(m2.id, 'mensagem tem id');

  // ordem: mais recentes primeiro
  const todas = store.listMessages(conv.id, 10, null);
  assert.deepStrictEqual(todas.map((m) => m.text), ['segunda', 'primeira']);

  // paginação por beforeId
  const pagina1 = store.listMessages(conv.id, 1, null);
  assert.deepStrictEqual(pagina1.map((m) => m.text), ['segunda']);
  const pagina2 = store.listMessages(conv.id, 1, pagina1[0].id);
  assert.deepStrictEqual(pagina2.map((m) => m.text), ['primeira']);
  const pagina3 = store.listMessages(conv.id, 1, pagina2[0].id);
  assert.deepStrictEqual(pagina3, []);
});

test('users: procura por username (exata) e por id; inexistente devolve null', () => {
  const store = createStoreMemory();
  const alice = criaUser(store, 'alice');

  assert.strictEqual(store.getUserByUsername('alice').id, alice.id);
  assert.strictEqual(store.getUserByUsername('Alice'), null); // comparação exata
  assert.strictEqual(store.getUserByUsername('nobody'), null);
  assert.strictEqual(store.getUserById(alice.id).username, 'alice');
  assert.strictEqual(store.getUserById('inexistente'), null);
});

test('updateUserPassword altera o passHash (aditivo da Task 3: recuperação)', () => {
  const store = createStoreMemory();
  const alice = criaUser(store, 'alice');

  const atualizado = store.updateUserPassword(alice.id, 'novo-hash');
  assert.strictEqual(atualizado.id, alice.id);
  assert.strictEqual(store.getUserById(alice.id).passHash, 'novo-hash');

  erroDeCodigo(() => store.updateUserPassword('inexistente', 'outro'), 'E_NOTFOUND');
});

test('sessões: token válido, eliminado e inexistente', () => {
  const store = createStoreMemory();
  const alice = criaUser(store, 'alice');

  const token = store.createSession(alice.id);
  assert.strictEqual(typeof token, 'string');
  assert.ok(token.length > 0);
  assert.strictEqual(store.getUserByToken(token).id, alice.id);

  store.deleteSession(token);
  assert.strictEqual(store.getUserByToken(token), null);
  assert.strictEqual(store.getUserByToken('token-falso'), null);

  erroDeCodigo(() => store.createSession('user-inexistente'), 'E_NOTFOUND');
});

test('pedidos de amizade: só o destinatário aceita e não se processa duas vezes', () => {
  const store = createStoreMemory();
  const alice = criaUser(store, 'alice');
  const bob = criaUser(store, 'bob');
  const carol = criaUser(store, 'carol');

  const pedido = store.createFriendRequest(alice.id, bob.id);
  erroDeCodigo(() => store.acceptFriendRequest(pedido.id, carol.id), 'E_FORBIDDEN');
  store.acceptFriendRequest(pedido.id, bob.id);
  erroDeCodigo(() => store.acceptFriendRequest(pedido.id, bob.id), 'E_DUP');

  // já são amigos → novo pedido (em qualquer sentido) é E_DUP
  erroDeCodigo(() => store.createFriendRequest(bob.id, alice.id), 'E_DUP');
});

test('conversas: grupo com título, listConversations e fronteiras de acesso', () => {
  const store = createStoreMemory();
  const alice = criaUser(store, 'alice');
  const bob = criaUser(store, 'bob');
  const carol = criaUser(store, 'carol');

  erroDeCodigo(() => store.createConversation([], true, 'vazia'), 'E_INVALID');

  const grupo = store.createConversation([alice.id, bob.id, carol.id], true, 'Turma');
  assert.strictEqual(grupo.isGroup, true);
  assert.strictEqual(grupo.title, 'Turma');
  const direta = store.createConversation([alice.id, bob.id], false, null);
  assert.strictEqual(direta.isGroup, false);
  assert.strictEqual(direta.title, null);

  assert.strictEqual(store.isMember(grupo.id, alice.id), true);
  assert.strictEqual(store.isMember(direta.id, carol.id), false);
  assert.strictEqual(store.isMember('conv-inexistente', alice.id), false);

  assert.deepStrictEqual(
    store.listConversations(alice.id).map((c) => c.id),
    [grupo.id, direta.id],
  );
  assert.deepStrictEqual(store.listConversations(carol.id).map((c) => c.id), [grupo.id]);
  erroDeCodigo(() => store.listConversations('user-inexistente'), 'E_NOTFOUND');

  erroDeCodigo(() => store.appendMessage(direta.id, carol.id, 'olá'), 'E_FORBIDDEN');
  erroDeCodigo(() => store.appendMessage('conv-inexistente', alice.id, 'olá'), 'E_NOTFOUND');
  erroDeCodigo(() => store.appendMessage(direta.id, alice.id, ''), 'E_INVALID');
});

test('objetos devolvidos são cópias (mutação externa não afeta o store)', () => {
  const store = createStoreMemory();
  const alice = criaUser(store, 'alice');
  const bob = criaUser(store, 'bob');
  const conv = store.createConversation([alice.id, bob.id], false, null);
  store.appendMessage(conv.id, alice.id, 'olá');

  const copiaUser = store.getUserById(alice.id);
  copiaUser.username = 'hacked';
  assert.strictEqual(store.getUserById(alice.id).username, 'alice');

  const [msg] = store.listMessages(conv.id, 1, null);
  msg.text = 'hacked';
  assert.strictEqual(store.listMessages(conv.id, 1, null)[0].text, 'olá');

  // conversas: mutar memberIds da conv devolvida não corrompe a membership
  const devolvida = store.listConversations(alice.id)[0];
  devolvida.memberIds.push('intruso');
  assert.strictEqual(store.isMember(conv.id, 'intruso'), false);

  const criada = store.createConversation([alice.id, bob.id], true, 'outro');
  criada.memberIds.push('intruso');
  assert.strictEqual(store.isMember(criada.id, 'intruso'), false);
  assert.strictEqual(store.listConversations(alice.id).length, 2);
});
