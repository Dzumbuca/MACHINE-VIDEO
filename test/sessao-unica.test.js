'use strict';

/**
 * Testes da REGRA DE SESSÃO ÚNICA (v1.2, com MV_SESSAO_UNICA=1):
 *   - o segundo session_create recebe session_active (com título/anfitrião);
 *   - session_state devolve a sessão ativa (ou null);
 *   - convite tardio do anfitrião entrega o session_invite ao amigo;
 *   - corrida: dois creates quase simultâneos → só uma sessão nasce.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { createServer } = require('../src/server');
const { createStoreMemory } = require('../src/store-memory');

process.env.MV_SESSAO_UNICA = '1';

async function arranque() {
  const store = createStoreMemory();
  const { http, attach } = createServer({ store });
  attach();
  await new Promise((resolver) => http.listen(0, '127.0.0.1', resolver));
  const base = `http://127.0.0.1:${http.address().port}`;
  return { store, base, fechar: async () => { http.closeAllConnections?.(); await new Promise((r) => http.close(r)); } };
}

// Clientes WS mínimos (padrão test/session.test.js).
const { WebSocket } = require('ws');

function abrirCliente(base) {
  return new Promise((resolver, rejeitar) => {
    const ws = new WebSocket(base.replace('http', 'ws'));
    const mensagens = [];
    ws.on('message', (d) => mensagens.push(JSON.parse(d.toString())));
    ws.once('open', () => resolver({ ws, mensagens, enviar: (e) => ws.send(JSON.stringify(e)) }));
    ws.once('error', rejeitar);
  });
}

function esperarNova(mensagens, filtro, ms = 2000) {
  return new Promise((resolver, rejeitar) => {
    const existente = mensagens.find(filtro);
    if (existente) return resolver(existente);
    const t = setTimeout(() => rejeitar(new Error('tempo esgotado à espera de mensagem')), ms);
    mensagens.push = function (m) { Array.prototype.push.call(this, m); if (filtro(m)) { clearTimeout(t); resolver(m); } return this.length; };
  });
}

test('sessão única: segundo create recebe session_active com anfitrião e título', async () => {
  const app = await arranque();
  const a = { fechar() {} };
  const b = { fechar() {} };
  try {
    const ana = app.store.createUser({ username: 'u_ana', passHash: 'x', secQ: 'q', secA: 'a' });
    const bruno = app.store.createUser({ username: 'u_bruno', passHash: 'x', secQ: 'q', secA: 'a' });
    // AMIGOS: o protocolo exige amizade nos convites (validarConvidados).
    const pedido = app.store.createFriendRequest(ana.id, bruno.id);
    app.store.acceptFriendRequest(pedido.id, bruno.id);

    const ca = await abrirCliente(app.base);
    const cb = await abrirCliente(app.base);
    a.fechar = () => ca.ws.close();
    b.fechar = () => cb.ws.close();
    ca.ws.send(JSON.stringify({ type: 'auth', token: app.store.createSession(ana.id) }));
    cb.ws.send(JSON.stringify({ type: 'auth', token: app.store.createSession(bruno.id) }));
    await new Promise((r) => setTimeout(r, 250));

    // Ana cria a primeira sessão (convida bruno).
    ca.enviar({ type: 'session_create', title: 'Noite 1', fileName: 'f.mp4', durationSec: 100, toUserIds: [bruno.id] });
    await esperarNova(ca.mensagens, (m) => m.type === 'session_created');

    // Bruno tenta criar a SEGUNDA → recebe session_active (não cria).
    cb.enviar({ type: 'session_create', title: 'Noite 2', fileName: 'g.mp4', durationSec: 100, toUserIds: [ana.id] });
    const ativa = await esperarNova(cb.mensagens, (m) => m.type === 'session_active');
    assert.equal(ativa.title, 'Noite 1');
    assert.equal(ativa.hostName, 'u_ana');
    assert.equal(ativa.origem, 'ficheiro');
  } finally {
    a.fechar(); b.fechar();
    await app.fechar();
  }
});

test('session_state devolve a ativa (com origem link) e late-invite entrega o convite', async () => {
  const app = await arranque();
  const a = { fechar() {} };
  const b = { fechar() {} };
  try {
    const ana = app.store.createUser({ username: 's_ana', passHash: 'x', secQ: 'q', secA: 'a' });
    const bruno = app.store.createUser({ username: 's_bruno', passHash: 'x', secQ: 'q', secA: 'a' });
    // Ana e Bruno são AMIGOS (o late-invite exige amizade).
    const pedidoCriado = app.store.createFriendRequest(ana.id, bruno.id);
    app.store.acceptFriendRequest(pedidoCriado.id, bruno.id);

    const ca = await abrirCliente(app.base);
    const cb = await abrirCliente(app.base);
    a.fechar = () => ca.ws.close();
    b.fechar = () => cb.ws.close();
    ca.ws.send(JSON.stringify({ type: 'auth', token: app.store.createSession(ana.id) }));
    cb.ws.send(JSON.stringify({ type: 'auth', token: app.store.createSession(bruno.id) }));
    await new Promise((r) => setTimeout(r, 250));

    // Sessão com LINK (origem link — os convidados entram sem ficheiro),
    // convidando o bruno (toUserIds tem de ser não-vazio no protocolo).
    ca.enviar({
      type: 'session_create', title: 'Clássico', fileName: 'c.mp4', durationSec: 60,
      toUserIds: [bruno.id], movieUrl: 'https://archive.org/download/his_girl_friday/his_girl_friday_512kb.mp4',
    });
    await esperarNova(ca.mensagens, (m) => m.type === 'session_created');

    // Consulta de estado.
    ca.enviar({ type: 'session_state' });
    const estado = await esperarNova(ca.mensagens, (m) => m.type === 'session_state');
    assert.equal(estado.ativa.title, 'Clássico');
    assert.equal(estado.ativa.origem, 'link');

    // Convite tardio ao amigo Bruno — chega o session_invite COM o movieUrl.
    ca.enviar({ type: 'session_invite_late', sessionId: estado.ativa.sessionId, toUserId: bruno.id });
    const convite = await esperarNova(cb.mensagens, (m) => m.type === 'session_invite');
    assert.equal(convite.movieUrl, 'https://archive.org/download/his_girl_friday/his_girl_friday_512kb.mp4');

    // Late-invite de NÃO-anfitrião → E_FORBIDDEN.
    cb.enviar({ type: 'session_invite_late', sessionId: estado.ativa.sessionId, toUserId: ana.id });
    await esperarNova(cb.mensagens, (m) => m.type === 'error' && m.code === 'E_FORBIDDEN');
  } finally {
    a.fechar(); b.fechar();
    await app.fechar();
  }
});
