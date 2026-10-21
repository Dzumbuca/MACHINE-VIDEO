'use strict';

/**
 * Smoke test do cliente web — Machine Video (Task 9).
 *
 * Arranca o servidor real (store em memória + hub WS) e percorre o fluxo
 * completo com os MÓDULOS DO CLIENTE de public/:
 *   GET / serve a nova interface → registar 2 utilizadores → amizade
 *   (pedido, aceitação, erros previstos) → 2 clientes WebSocket autenticados →
 *   mensagem entregue em tempo real (+ eco ao remetente) → histórico REST →
 *   presença (online/offline) → tipo desconhecido → backoff de reconexão.
 *
 * Shims mínimos de browser (localStorage/WebSocket) antes do import dinâmico
 * dos módulos ES do cliente.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { WebSocket } = require('ws');

// --- ambiente de browser suficiente para os módulos do cliente ---------------

globalThis.localStorage = {
  _dados: {},
  getItem(chave) {
    return Object.prototype.hasOwnProperty.call(this._dados, chave) ? this._dados[chave] : null;
  },
  setItem(chave, valor) {
    this._dados[chave] = String(valor);
  },
  removeItem(chave) {
    delete this._dados[chave];
  },
};
globalThis.WebSocket = WebSocket;

// --- servidor real + módulos do cliente ----------------------------------------

const { createServer } = require('../src/server');
const { createStoreMemory } = require('../src/store-memory');

let http;
let wss;
let baseUrl;
let wsUrl;

let api;
let lerToken;
let guardarToken;
let WsClient;

const SENHA = 'senha-secreta-123';

function esperarCondicao(condicao, mensagem, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const inicio = Date.now();
    const tentar = () => {
      const valor = condicao();
      if (valor) return resolve(valor);
      if (Date.now() - inicio > timeoutMs) return reject(new Error(mensagem));
      setTimeout(tentar, 15);
    };
    tentar();
  });
}

function aguardarEnvelope(cliente, tipo, predicado, mensagem, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const temporizador = setTimeout(() => {
      anular();
      reject(new Error(mensagem));
    }, timeoutMs);
    const anular = cliente.on(tipo, (envelope) => {
      if (!predicado || predicado(envelope)) {
        clearTimeout(temporizador);
        anular();
        resolve(envelope);
      }
    });
  });
}

before(async () => {
  const servidor = createServer({ store: createStoreMemory() });
  ({ http } = servidor);
  wss = servidor.attach(); // hub WebSocket no mesmo porto (Tasks 5–8)
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address();
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;

  // No browser os módulos do cliente usam caminhos relativos ao servidor de
  // origem; aqui encaminhamos esses caminhos para o servidor de teste.
  const fetchReal = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' && input.startsWith('/') ? baseUrl + input : input;
    return fetchReal(url, init);
  };

  ({ api, lerToken, guardarToken } = await import('../public/api.js'));
  ({ WsClient } = await import('../public/ws.js'));
});

after(async () => {
  // Fecha primeiro os clientes: o hub não termina o fecho enquanto houver
  // ligações abertas, e um after() pendurado congelaria o processo inteiro.
  clienteA?.close();
  clienteB?.close();
  await new Promise((resolve) => wss.close(() => resolve()));
  await new Promise((resolve) => {
    http.close(() => resolve());
    http.closeAllConnections();
  });
});

// --- testes ----------------------------------------------------------------------

let tokenA;
let tokenB;
let userA;
let userB;
let conversationId;
let clienteA;
let clienteB;

test('GET / serve a nova interface Machine Video', async () => {
  const resposta = await fetch(`${baseUrl}/`);
  assert.strictEqual(resposta.status, 200);
  assert.match(resposta.headers.get('content-type'), /text\/html/);
  const corpo = await resposta.text();
  assert.match(corpo, /Machine Video/);
  assert.match(corpo, /app\.js/); // shell novo carrega o módulo principal
  assert.match(corpo, /id="app"/);
  assert.match(corpo, /lang="pt"/);
});

test('ficheiros estáticos do cliente são servidos com o MIME certo', async () => {
  for (const [caminho, tipo] of [
    ['/style.css', /text\/css/],
    ['/ui/shell.css', /text\/css/],
    ['/ui/chat.css', /text\/css/],
    ['/ui/chamada.css', /text\/css/],
    ['/ui/filme.css', /text\/css/],
    ['/app.js', /text\/javascript/],
    ['/api.js', /text\/javascript/],
    ['/ws.js', /text\/javascript/],
    ['/call.js', /text\/javascript/],
    ['/movie.js', /text\/javascript/],
  ]) {
    const resposta = await fetch(`${baseUrl}${caminho}`);
    assert.strictEqual(resposta.status, 200, caminho);
    assert.match(resposta.headers.get('content-type'), tipo, caminho);
  }
});

test('registo e início de sessão de dois utilizadores via api.js', async () => {
  await api.registar({
    username: 'ana_2026',
    password: SENHA,
    secQuestion: 'Qual é o seu filme preferido?',
    secAnswer: 'Tubarão',
  });
  await api.registar({
    username: 'bruno_2026',
    password: SENHA,
    secQuestion: 'Qual é a sua cidade?',
    secAnswer: 'Luanda',
  });

  const entradaA = await api.entrar('ana_2026', SENHA);
  guardarToken(entradaA.token); // como faz ui/auth.js no browser
  tokenA = lerToken();
  userA = entradaA.user;

  const entradaB = await api.entrar('bruno_2026', SENHA);
  guardarToken(entradaB.token);
  tokenB = lerToken();
  userB = entradaB.user;

  assert.ok(tokenA && tokenB && tokenA !== tokenB);
  const perfil = await api.eu(); // token atual é o de B
  assert.strictEqual(perfil.user.username, 'bruno_2026');
});

test('amizade: pedido, 404 para desconhecido, aceitação', async () => {
  guardarToken(tokenA);
  const pedido = await api.pedirAmizade('bruno_2026');
  assert.ok(pedido.requestId);

  await assert.rejects(
    () => api.pedirAmizade('nao_existe_99'),
    (e) => e instanceof Error && e.status === 404,
  );

  guardarToken(tokenB);
  const dados = await api.amigos();
  assert.strictEqual(dados.pendingIn.length, 1);
  assert.strictEqual(dados.pendingIn[0].from.username, 'ana_2026');
  await api.aceitarAmizade(dados.pendingIn[0].id);

  guardarToken(tokenA);
  const amigosDeA = await api.amigos();
  assert.deepStrictEqual(
    amigosDeA.friends.map((f) => f.username),
    ['bruno_2026'],
  );
  assert.strictEqual(amigosDeA.pendingIn.length, 0);
});

test('conversa 1:1 criada e listada', async () => {
  guardarToken(tokenA);
  const criada = await api.criarConversa([userB.id]);
  conversationId = criada.conversationId;

  const { conversations } = await api.conversas();
  assert.strictEqual(conversations.length, 1);
  assert.ok(conversations[0].memberIds.includes(userA.id));
  assert.ok(conversations[0].memberIds.includes(userB.id));
  assert.strictEqual(conversations[0].isGroup, false);
});

test('mensagem em tempo real: entrega a B e eco ao remetente', async () => {
  clienteA = new WsClient({ url: wsUrl });
  clienteB = new WsClient({ url: wsUrl });

  clienteA.connect(tokenA);
  clienteB.connect(tokenB);
  await esperarCondicao(
    () => clienteA.status === 'online' && clienteB.status === 'online',
    'clientes não autenticaram no hub',
  );

  const entregaB = aguardarEnvelope(
    clienteB,
    'chat_message',
    (m) => m.text === 'Olá bruno, tudo bem?',
    'B não recebeu a mensagem em tempo real',
  );
  const eco = aguardarEnvelope(
    clienteA,
    'chat_message',
    (m) => m.text === 'Olá bruno, tudo bem?',
    'A não recebeu o eco da própria mensagem',
  );

  assert.ok(clienteA.send({ type: 'chat_send', conversationId, text: 'Olá bruno, tudo bem?' }));

  const recebida = await entregaB;
  assert.strictEqual(recebida.fromUserId, userA.id);
  assert.strictEqual(recebida.fromName, 'ana_2026');
  assert.strictEqual(recebida.conversationId, conversationId);

  const minha = await eco;
  assert.strictEqual(minha.fromUserId, userA.id);
});

test('tipo desconhecido devolve erro sem fechar a ligação', async () => {
  const erro = aguardarEnvelope(
    clienteA,
    'error',
    (e) => e.code === 'E_UNKNOWN_TYPE',
    'não recebeu E_UNKNOWN_TYPE',
  );
  clienteA.send({ type: 'tipo_que_nao_existe' });
  await erro;
  assert.strictEqual(clienteA.status, 'online'); // ligação mantém-se viva
});

test('histórico REST devolve a mensagem (mais recente primeiro)', async () => {
  guardarToken(tokenB);
  const { messages } = await api.mensagens(conversationId);
  assert.ok(messages.length >= 1);
  assert.strictEqual(messages[0].text, 'Olá bruno, tudo bem?');
  assert.strictEqual(messages[0].userId, userA.id);
});

test('presença: amigo online ao ligar e offline ao desligar', async () => {
  const offline = aguardarEnvelope(
    clienteB,
    'presence',
    (p) => p.userId === userA.id && p.online === false,
    'B não foi avisado de que A ficou offline',
  );
  clienteA.close(); // fecho manual → presença offline para os amigos
  await offline;
  assert.strictEqual(clienteA.status, 'idle');

  const online = aguardarEnvelope(
    clienteB,
    'presence',
    (p) => p.userId === userA.id && p.online === true,
    'B não foi avisado de que A voltou a ficar online',
  );
  clienteA.connect(tokenA); // religa — B volta a ser avisado
  await online;
  await esperarCondicao(() => clienteA.status === 'online', 'reconexão não autenticou');
});

test('backoff de reconexão tenta de novo contra um porto morto', async () => {
  const cliente = new WsClient({
    url: 'ws://127.0.0.1:1/ws',
    backoffInicialMs: 25,
    backoffMaxMs: 60,
  });
  cliente.connect('token-qualquer');
  await esperarCondicao(
    () => cliente._falhas >= 2,
    'cliente não tentou religar pelo menos duas vezes',
    2500,
  );
  cliente.close(); // para o ciclo de reconexão do teste
});

// --- Task 10: envelopes de chamada e sessão de filme (consumidos por call.js/movie.js) ---

test('chamada: convite com ack, sinal relayado intacto e fim', async () => {
  const callId = 'call-teste-1';
  const incoming = aguardarEnvelope(clienteB, 'call_incoming', (e) => e.callId === callId, 'B não recebeu call_incoming');
  const ack = aguardarEnvelope(clienteA, 'call_ack', (e) => e.callId === callId, 'A não recebeu call_ack');
  clienteA.send({ type: 'call_invite', callId, toUserIds: [userB.id], media: 'av' });

  const convite = await incoming;
  assert.strictEqual(convite.fromUserId, userA.id);
  assert.strictEqual(convite.fromName, 'ana_2026');
  assert.strictEqual(convite.media, 'av');

  const confirma = await ack;
  assert.deepStrictEqual(confirma.delivered, [userB.id]);
  assert.deepStrictEqual(confirma.missed, []);

  // offer vai DENTRO de call_signal.data e chega intacta (relay opaco)
  const oferta = aguardarEnvelope(
    clienteB,
    'call_signal',
    (e) => e.callId === callId && e.data?.kind === 'offer',
    'B não recebeu a oferta pela call_signal',
  );
  clienteA.send({
    type: 'call_signal', callId, toUserId: userB.id,
    data: { kind: 'offer', payload: { type: 'offer', sdp: 'sdp-de-teste' } },
  });
  const sinalB = await oferta;
  assert.strictEqual(sinalB.fromUserId, userA.id);
  assert.deepStrictEqual(sinalB.data, { kind: 'offer', payload: { type: 'offer', sdp: 'sdp-de-teste' } });

  const resposta = aguardarEnvelope(
    clienteA,
    'call_signal',
    (e) => e.data?.kind === 'answer',
    'A não recebeu a resposta',
  );
  clienteB.send({
    type: 'call_signal', callId, toUserId: userA.id,
    data: { kind: 'answer', payload: { type: 'answer', sdp: 'sdp-resposta' } },
  });
  await resposta;

  // recusa de quem nunca entrou: call_end ao originador
  const recusa = aguardarEnvelope(
    clienteA,
    'call_end',
    (e) => e.callId === callId && e.fromUserId === userB.id,
    'A não recebeu o call_end da recusa',
  );
  clienteB.send({ type: 'call_end', callId, toUserIds: [userA.id] });
  await recusa;
});

test('sessão de filme: criação, join, controlo do anfitrião e fim', async () => {
  const criada = aguardarEnvelope(clienteA, 'session_created', null, 'A não recebeu session_created');
  const convite = aguardarEnvelope(clienteB, 'session_invite', null, 'B não recebeu session_invite');
  clienteA.send({
    type: 'session_create', title: 'Noite de filme', fileName: 'filme.mp4',
    durationSec: 3600, toUserIds: [userB.id],
  });

  const criadoEnv = await criada;
  const sessionId = criadoEnv.sessionId;
  assert.ok(sessionId);
  assert.strictEqual(criadoEnv.fileName, 'filme.mp4');
  assert.strictEqual(criadoEnv.durationSec, 3600);

  const conviteEnv = await convite;
  assert.strictEqual(conviteEnv.fromName, 'ana_2026');
  assert.strictEqual(conviteEnv.title, 'Noite de filme');
  assert.strictEqual(conviteEnv.durationSec, 3600);

  // join sem ficheiro: eco ao próprio + anúncio ao anfitrião
  const membroB = aguardarEnvelope(
    clienteB,
    'session_member',
    (e) => e.userId === userB.id,
    'B não recebeu o eco do session_member',
  );
  const membroA = aguardarEnvelope(
    clienteA,
    'session_member',
    (e) => e.userId === userB.id,
    'A não foi avisado do session_member',
  );
  clienteB.send({ type: 'session_join', sessionId, fileMatches: false });
  const ecoB = await membroB;
  assert.strictEqual(ecoB.fileMatches, false);
  await membroA;

  // controlo do anfitrião: eco ao próprio + entrega ao convidado
  const controleA = aguardarEnvelope(
    clienteA,
    'session_control',
    (e) => e.action === 'play',
    'A não recebeu o eco do session_control',
  );
  const controleB = aguardarEnvelope(
    clienteB,
    'session_control',
    (e) => e.action === 'play',
    'B não recebeu o session_control',
  );
  clienteA.send({ type: 'session_control', sessionId, action: 'play', positionSec: 12.5, atMs: Date.now() });
  await controleA;
  const recebidoB = await controleB;
  assert.strictEqual(recebidoB.positionSec, 12.5);

  // convidado não controla: E_NOT_HOST e nada é difundido
  const negado = aguardarEnvelope(clienteB, 'error', (e) => e.code === 'E_NOT_HOST', 'B não recebeu E_NOT_HOST');
  clienteB.send({ type: 'session_control', sessionId, action: 'seek', positionSec: 60, atMs: Date.now() });
  await negado;

  // anfitrião sai: session_ended host_left a todos
  const fimA = aguardarEnvelope(clienteA, 'session_ended', (e) => e.reason === 'host_left', 'A não recebeu session_ended');
  const fimB = aguardarEnvelope(clienteB, 'session_ended', (e) => e.reason === 'host_left', 'B não recebeu session_ended');
  clienteA.send({ type: 'session_leave', sessionId });
  await fimA;
  await fimB;
});

test('helpers do cliente: matching de ficheiro, drift e regra de oferta', async () => {
  const { avaliarFicheiro, esperadoPosicao, driftSegundos, rotuloDuracao } = await import('../public/movie.js');
  const { devoOferecer } = await import('../public/call.js');

  // nome + duração dentro da tolerância ±2 s → compatível
  const ok = avaliarFicheiro({ nome: 'filme.mp4', duracaoSec: 600 }, { nome: 'filme.mp4', duracaoSec: 601 });
  assert.strictEqual(ok.fileMatches, true);
  assert.deepStrictEqual(ok.divergencias, []);

  // nome E duração divergentes → aviso claro, mas pode entrar
  const divergente = avaliarFicheiro({ nome: 'outro.mp4', duracaoSec: 700 }, { nome: 'filme.mp4', duracaoSec: 600 });
  assert.strictEqual(divergente.fileMatches, false);
  assert.strictEqual(divergente.divergencias.length, 2);

  // regra anti-glare da malha: apenas o ID MENOR oferece
  assert.strictEqual(devoOferecer('b', 'c'), true);
  assert.strictEqual(devoOferecer('c', 'b'), false);
  assert.strictEqual(devoOferecer('x', 'x'), false);

  // drift: último "play" em 10 s há 3 s → esperado 13 s; 14,6 s diverge 1,6 s (≥1,5 → corrige)
  const ultimo = { action: 'play', positionSec: 10, atMs: 1000 };
  assert.strictEqual(esperadoPosicao(ultimo, 4000), 13);
  const d1 = driftSegundos(14.6, ultimo, 4000);
  assert.ok(Math.abs(d1 - 1.6) < 1e-9);
  assert.ok(d1 >= 1.5);
  assert.ok(driftSegundos(13.1, ultimo, 4000) < 1.5); // dentro da tolerância

  // pausa: a posição esperada fica parada em positionSec
  const pausado = { action: 'pause', positionSec: 10, atMs: 1000 };
  assert.strictEqual(esperadoPosicao(pausado, 9000), 10);
  const d2 = driftSegundos(11.6, pausado, 9000);
  assert.ok(Math.abs(d2 - 1.6) < 1e-9);

  // rótulos de duração em PT
  assert.strictEqual(rotuloDuracao(154), '2:34');
  assert.strictEqual(rotuloDuracao(3725), '1:02:05');
  assert.strictEqual(rotuloDuracao(null), '—');
});
