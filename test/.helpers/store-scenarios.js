'use strict';

/**
 * Cenários partilhados do contrato `src/store.js` — Machine Video Social.
 *
 * Ficheiro numa pasta oculta (`.helpers`) porque o test runner do Node trata
 * TODOS os ficheiros dentro de `test/` como ficheiros de teste; aqui só
 * definimos uma função, nunca registamos testes por conta própria.
 *
 * Consumidores:
 *   - test/store.test.js    → store em memória (corrida sempre);
 *   - test/store-pg.test.js → store em PostgreSQL (Task 11; skip sem
 *     DATABASE_URL). Ambas passam EXATAMENTE os mesmos cenários.
 *
 * Todas as chamadas à store são `await`ed: a store em memória devolve valores
 * síncronos (await passa o valor), a store-pg devolve Promises — o mesmo
 * cenário serve às duas implementações.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { StoreError } = require('../../src/store');

function criaUser(store, username) {
  return store.createUser({
    username,
    passHash: `hash-${username}`,
    secQ: 'Qual o apelido da sua mãe?',
    secA: 'silva',
  });
}

/** Espera uma StoreError com o código indicado (síncrono ou assíncrono). */
async function erroDeCodigo(fn, code) {
  await assert.rejects(
    async () => fn(),
    (err) => err instanceof StoreError && err.code === code,
    `esperado StoreError com código ${code}`,
  );
}

/**
 * Regista o conjunto completo de cenários do contrato contra a store
 * fornecida.
 *
 * @param {object} opcoes
 * @param {() => Promise<object>|object} opcoes.createStore - devolve uma store
 *   isolada (vazia) por cenário.
 * @param {(store: object) => Promise<void>} [opcoes.closeStore] - fecha
 *   recursos da store no fim de cada cenário (ex.: pool pg).
 * @param {boolean|string} [opcoes.skip] - false (correr) ou motivo de skip.
 */
function runStoreContractTests({ createStore, closeStore, skip = false } = {}) {
  // Envolve cada cenário: cria a store, corre e fecha recursos no fim.
  function cenario(nome, corpo) {
    test(nome, { skip }, async () => {
      const store = await createStore();
      try {
        await corpo(store);
      } finally {
        if (closeStore) await closeStore(store);
      }
    });
  }

  cenario('ciclo completo: 2 users, amizade, conversa e 2 mensagens', async (store) => {
    // 2 users
    const alice = await criaUser(store, 'alice');
    const bob = await criaUser(store, 'bob');
    assert.ok(alice.id, 'user criado tem id');
    assert.strictEqual(alice.username, 'alice');

    // E_DUP no username repetido
    await erroDeCodigo(() => criaUser(store, 'alice'), 'E_DUP');

    // amizade: pedido + aceitação
    await erroDeCodigo(() => store.createFriendRequest(alice.id, alice.id), 'E_SELF');
    const pedido = await store.createFriendRequest(alice.id, bob.id);
    assert.ok(pedido.id, 'pedido de amizade tem id');
    await erroDeCodigo(() => store.createFriendRequest(alice.id, bob.id), 'E_DUP');
    await store.acceptFriendRequest(pedido.id, bob.id);

    assert.deepStrictEqual(
      (await store.listFriends(alice.id)).map((u) => u.username),
      ['bob'],
    );
    assert.deepStrictEqual(
      (await store.listFriends(bob.id)).map((u) => u.username),
      ['alice'],
    );
    assert.strictEqual(await store.areFriends(alice.id, bob.id), true);
    assert.strictEqual(await store.areFriends(bob.id, alice.id), true);

    // conversa direta
    const conv = await store.createConversation([alice.id, bob.id], false, null);
    assert.ok(conv.id, 'conversa tem id');
    assert.strictEqual(await store.isMember(conv.id, alice.id), true);
    assert.strictEqual(await store.isMember(conv.id, bob.id), true);

    // 2 mensagens
    const m1 = await store.appendMessage(conv.id, alice.id, 'primeira');
    const m2 = await store.appendMessage(conv.id, bob.id, 'segunda');
    assert.ok(m1.id, 'mensagem tem id');
    assert.ok(m1.ts, 'mensagem tem ts');
    assert.ok(m2.id, 'mensagem tem id');

    // ordem: mais recentes primeiro
    const todas = await store.listMessages(conv.id, 10, null);
    assert.deepStrictEqual(todas.map((m) => m.text), ['segunda', 'primeira']);

    // paginação por beforeId
    const pagina1 = await store.listMessages(conv.id, 1, null);
    assert.deepStrictEqual(pagina1.map((m) => m.text), ['segunda']);
    const pagina2 = await store.listMessages(conv.id, 1, pagina1[0].id);
    assert.deepStrictEqual(pagina2.map((m) => m.text), ['primeira']);
    const pagina3 = await store.listMessages(conv.id, 1, pagina2[0].id);
    assert.deepStrictEqual(pagina3, []);
  });

  cenario('users: procura por username (exata) e por id; inexistente devolve null', async (store) => {
    const alice = await criaUser(store, 'alice');

    assert.strictEqual((await store.getUserByUsername('alice')).id, alice.id);
    assert.strictEqual(await store.getUserByUsername('Alice'), null); // comparação exata
    assert.strictEqual(await store.getUserByUsername('nobody'), null);
    assert.strictEqual((await store.getUserById(alice.id)).username, 'alice');
    assert.strictEqual(await store.getUserById('inexistente'), null);
  });

  cenario('updateUserPassword altera o passHash (aditivo da Task 3: recuperação)', async (store) => {
    const alice = await criaUser(store, 'alice');

    const atualizado = await store.updateUserPassword(alice.id, 'novo-hash');
    assert.strictEqual(atualizado.id, alice.id);
    assert.strictEqual((await store.getUserById(alice.id)).passHash, 'novo-hash');

    await erroDeCodigo(() => store.updateUserPassword('inexistente', 'outro'), 'E_NOTFOUND');
  });

  cenario('sessões: token válido, eliminado e inexistente', async (store) => {
    const alice = await criaUser(store, 'alice');

    const token = await store.createSession(alice.id);
    assert.strictEqual(typeof token, 'string');
    assert.ok(token.length > 0);
    assert.strictEqual((await store.getUserByToken(token)).id, alice.id);

    await store.deleteSession(token);
    assert.strictEqual(await store.getUserByToken(token), null);
    assert.strictEqual(await store.getUserByToken('token-falso'), null);

    await erroDeCodigo(() => store.createSession('user-inexistente'), 'E_NOTFOUND');
  });

  cenario('pedidos de amizade: só o destinatário aceita e não se processa duas vezes', async (store) => {
    const alice = await criaUser(store, 'alice');
    const bob = await criaUser(store, 'bob');
    const carol = await criaUser(store, 'carol');

    const pedido = await store.createFriendRequest(alice.id, bob.id);
    await erroDeCodigo(() => store.acceptFriendRequest(pedido.id, carol.id), 'E_FORBIDDEN');
    await store.acceptFriendRequest(pedido.id, bob.id);
    await erroDeCodigo(() => store.acceptFriendRequest(pedido.id, bob.id), 'E_DUP');

    // já são amigos → novo pedido (em qualquer sentido) é E_DUP
    await erroDeCodigo(() => store.createFriendRequest(bob.id, alice.id), 'E_DUP');
  });

  cenario('conversas: grupo com título, listConversations e fronteiras de acesso', async (store) => {
    const alice = await criaUser(store, 'alice');
    const bob = await criaUser(store, 'bob');
    const carol = await criaUser(store, 'carol');

    await erroDeCodigo(() => store.createConversation([], true, 'vazia'), 'E_INVALID');

    const grupo = await store.createConversation([alice.id, bob.id, carol.id], true, 'Turma');
    assert.strictEqual(grupo.isGroup, true);
    assert.strictEqual(grupo.title, 'Turma');
    const direta = await store.createConversation([alice.id, bob.id], false, null);
    assert.strictEqual(direta.isGroup, false);
    assert.strictEqual(direta.title, null);

    assert.strictEqual(await store.isMember(grupo.id, alice.id), true);
    assert.strictEqual(await store.isMember(direta.id, carol.id), false);
    assert.strictEqual(await store.isMember('conv-inexistente', alice.id), false);

    assert.deepStrictEqual(
      (await store.listConversations(alice.id)).map((c) => c.id),
      [grupo.id, direta.id],
    );
    assert.deepStrictEqual((await store.listConversations(carol.id)).map((c) => c.id), [grupo.id]);
    await erroDeCodigo(() => store.listConversations('user-inexistente'), 'E_NOTFOUND');

    await erroDeCodigo(() => store.appendMessage(direta.id, carol.id, 'olá'), 'E_FORBIDDEN');
    await erroDeCodigo(() => store.appendMessage('conv-inexistente', alice.id, 'olá'), 'E_NOTFOUND');
    await erroDeCodigo(() => store.appendMessage(direta.id, alice.id, ''), 'E_INVALID');
  });

  cenario('objetos devolvidos são cópias (mutação externa não afeta o store)', async (store) => {
    const alice = await criaUser(store, 'alice');
    const bob = await criaUser(store, 'bob');
    const conv = await store.createConversation([alice.id, bob.id], false, null);
    await store.appendMessage(conv.id, alice.id, 'olá');

    const copiaUser = await store.getUserById(alice.id);
    copiaUser.username = 'hacked';
    assert.strictEqual((await store.getUserById(alice.id)).username, 'alice');

    const [msg] = await store.listMessages(conv.id, 1, null);
    msg.text = 'hacked';
    assert.strictEqual((await store.listMessages(conv.id, 1, null))[0].text, 'olá');

    // conversas: mutar memberIds da conv devolvida não corrompe a membership
    const devolvida = (await store.listConversations(alice.id))[0];
    devolvida.memberIds.push('intruso');
    assert.strictEqual(await store.isMember(conv.id, 'intruso'), false);

    const criada = await store.createConversation([alice.id, bob.id], true, 'outro');
    criada.memberIds.push('intruso');
    assert.strictEqual(await store.isMember(criada.id, 'intruso'), false);
    assert.strictEqual((await store.listConversations(alice.id)).length, 2);
  });

  // --- aditivo Task 11: listFriendRequests (pendências sobrevivem a restart) ---

  cenario('listFriendRequests devolve pendentes recebidos e enviados com usernames', async (store) => {
    const alice = await criaUser(store, 'alice');
    const bob = await criaUser(store, 'bob');
    const carol = await criaUser(store, 'carol');

    const pedido1 = await store.createFriendRequest(alice.id, bob.id);
    const pedido2 = await store.createFriendRequest(carol.id, bob.id);

    // Bob recebeu dois pedidos, por ordem de criação
    const deBob = await store.listFriendRequests(bob.id);
    assert.deepStrictEqual(
      deBob.pendingIn.map((p) => p.id),
      [pedido1.id, pedido2.id],
      'pendingIn por ordem de criação',
    );
    assert.strictEqual(deBob.pendingIn[0].fromUserId, alice.id);
    assert.strictEqual(deBob.pendingIn[0].fromUsername, 'alice');
    assert.strictEqual(typeof deBob.pendingIn[0].createdAt, 'string');
    assert.deepStrictEqual(deBob.pendingOut, []);

    // Alice só vê o seu pedido enviado; Carol o dela
    const deAlice = await store.listFriendRequests(alice.id);
    assert.deepStrictEqual(deAlice.pendingIn, []);
    assert.deepStrictEqual(deAlice.pendingOut.map((p) => p.id), [pedido1.id]);
    assert.strictEqual(deAlice.pendingOut[0].toUserId, bob.id);
    assert.strictEqual(deAlice.pendingOut[0].toUsername, 'bob');

    const deCarol = await store.listFriendRequests(carol.id);
    assert.deepStrictEqual(deCarol.pendingIn, []);
    assert.deepStrictEqual(deCarol.pendingOut.map((p) => p.id), [pedido2.id]);
    assert.strictEqual(deCarol.pendingOut[0].toUserId, bob.id);
    assert.strictEqual(deCarol.pendingOut[0].toUsername, 'bob');
  });

  cenario('listFriendRequests: pedido aceite sai das listas; user desconhecido e E_NOTFOUND', async (store) => {
    const alice = await criaUser(store, 'alice');
    const bob = await criaUser(store, 'bob');

    const pedido = await store.createFriendRequest(alice.id, bob.id);
    await store.acceptFriendRequest(pedido.id, bob.id);

    // Aceitou → deixa de aparecer em qualquer lista
    const deBob = await store.listFriendRequests(bob.id);
    assert.deepStrictEqual(deBob.pendingIn, []);
    assert.deepStrictEqual(deBob.pendingOut, []);
    const deAlice = await store.listFriendRequests(alice.id);
    assert.deepStrictEqual(deAlice.pendingIn, []);
    assert.deepStrictEqual(deAlice.pendingOut, []);

    // Já são amigos: nada em pendentes (a amizade vive em listFriends)
    assert.deepStrictEqual((await store.listFriends(bob.id)).map((u) => u.username), ['alice']);

    await erroDeCodigo(() => store.listFriendRequests('user-inexistente'), 'E_NOTFOUND');
  });
}

module.exports = { runStoreContractTests };
