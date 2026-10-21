'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');

const { createServer } = require('../src/server');
const { createStoreMemory } = require('../src/store-memory');

// --- servidor partilhado (porta efêmera) -------------------------------------

let http;
let attach;
let baseUrl;
let urlWs;
let store;

/** Utilizadores { userId, token, username }: ana-bruno e ana-carla são amigos; eva não é amiga de ninguém. */
let ana;
let bruno;
let carla;
let eva;

/** Clientes ws abertos durante os testes; o after() fecha os que sobrarem. */
const clientes = [];

before(async () => {
  store = createStoreMemory();
  ({ http, attach } = createServer({ store }));
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${http.address().port}`;
  urlWs = `ws://127.0.0.1:${http.address().port}`;
  attach({ authTimeoutMs: 300 });

  ana = await registarELogar('chat_ana');
  bruno = await registarELogar('chat_bruno');
  carla = await registarELogar('chat_carla');
  eva = await registarELogar('chat_eva');
  await tornarAmigos(ana, bruno);
  await tornarAmigos(ana, carla);
});

after(async () => {
  await Promise.allSettled(clientes.map((c) => fecharCliente(c)));
  await new Promise((resolve) => {
    http.close(() => resolve());
    http.closeAllConnections();
  });
});

// --- ajudantes REST -------------------------------------------------------------

const PERGUNTA = 'Qual o nome do seu primeiro animal de estimacao?';

function jsonFetch(caminho, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}${caminho}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Regista e loga um utilizador; devolve { userId, token, username }. */
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
  return { userId, token, username };
}

/** Torna a e b amigos pelos endpoints REST (a pede, b aceita). */
async function tornarAmigos(a, b) {
  const pedido = await jsonFetch('/api/friends/request', {
    method: 'POST',
    token: a.token,
    body: { username: b.username },
  });
  assert.strictEqual(pedido.status, 201, `pedido de amizade ${a.username}->${b.username} falhou`);
  const { requestId } = await pedido.json();
  const aceitar = await jsonFetch('/api/friends/accept', {
    method: 'POST',
    token: b.token,
    body: { requestId },
  });
  assert.strictEqual(aceitar.status, 200);
}

/** Cria uma conversa por REST e devolve o conversationId. */
async function criarConversaRest(criadora, memberIds, title) {
  const corpo = title === undefined ? { memberIds } : { memberIds, title };
  const resposta = await jsonFetch('/api/conversations', {
    method: 'POST',
    token: criadora.token,
    body: corpo,
  });
  assert.strictEqual(resposta.status, 201, 'criação da conversa falhou');
  const criada = await resposta.json();
  return criada.conversationId;
}

/** Caminho do histórico de mensagens de uma conversa. */
function urlHistorico(conversationId) {
  return `/api/conversations/${conversationId}/messages`;
}

/** Lê o histórico de uma conversa por REST e devolve o corpo JSON. */
async function lerHistorico(token, conversationId) {
  return (await jsonFetch(urlHistorico(conversationId), { token })).json();
}

// --- ajudantes ws ---------------------------------------------------------------

const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Abre um cliente ws e devolve um saco de mensagens com esperas. */
function abrirCliente() {
  return new Promise((resolve) => {
    const ws = new WebSocket(urlWs);
    const cliente = {
      ws,
      mensagens: [],
      fechado: null,
      esperas: [],
      esperasFecho: [],
      enviar(pacote) {
        ws.send(typeof pacote === 'string' ? pacote : JSON.stringify(pacote));
      },
    };
    clientes.push(cliente);
    ws.on('open', () => resolve(cliente));
    ws.on('error', () => {}); // erros de cliente não podem derrubar os testes
    ws.on('message', (dados) => {
      const msg = JSON.parse(dados.toString());
      cliente.mensagens.push(msg);
      cliente.esperas = cliente.esperas.filter((espera) => {
        if (espera.filtro(msg)) {
          espera.resolve(msg);
          return false;
        }
        return true;
      });
    });
    ws.on('close', (code) => {
      cliente.fechado = { code };
      cliente.esperas.splice(0).forEach((espera) => espera.resolve(null));
      cliente.esperasFecho.splice(0).forEach((espera) => espera.resolve(cliente.fechado));
    });
  });
}

/** Espera (ignorando o histórico) até chegar uma mensagem que satisfaça o filtro. */
function esperarNovaMensagem(cliente, filtro, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const espera = { filtro, resolve: null };
    const temporizador = setTimeout(() => {
      cliente.esperas = cliente.esperas.filter((e) => e !== espera);
      reject(new Error('tempo esgotado à espera de mensagem'));
    }, timeoutMs);
    espera.resolve = (msg) => {
      clearTimeout(temporizador);
      resolve(msg);
    };
    cliente.esperas.push(espera);
  });
}

/** Fecha o cliente e espera o fecho (imediato se já fechou). */
async function fecharCliente(cliente, timeoutMs = 2000) {
  if (cliente.fechado) return;
  await new Promise((resolve, reject) => {
    const espera = { resolve: null };
    const temporizador = setTimeout(() => {
      cliente.esperasFecho = cliente.esperasFecho.filter((e) => e !== espera);
      reject(new Error('tempo esgotado à espera do fecho da ligação'));
    }, timeoutMs);
    espera.resolve = (fecho) => {
      clearTimeout(temporizador);
      resolve(fecho);
    };
    cliente.esperasFecho.push(espera);
    cliente.ws.close();
  });
}

/** Abre um cliente ws, autentica-o e devolve o saco de mensagens. */
async function clienteAutenticado(token) {
  const cliente = await abrirCliente();
  cliente.enviar({ type: 'auth', token });
  const resposta = await esperarNovaMensagem(
    cliente,
    (m) => m.type === 'auth_ok' || m.type === 'error',
  );
  if (!resposta || resposta.type !== 'auth_ok') {
    throw new Error(`autenticação falhou: ${JSON.stringify(resposta)}`);
  }
  return cliente;
}

function mensagensDe(cliente, filtro) {
  return cliente.mensagens.filter(filtro);
}

// --- 1. REST: conversas ---------------------------------------------------------

test('POST /api/conversations cria 1:1 entre amigos e ambos os membros a listam', async () => {
  const conversationId = await criarConversaRest(ana, [bruno.userId]);
  assert.ok(conversationId, 'a criação devolve o id da conversa');

  const listaAna = await (await jsonFetch('/api/conversations', { token: ana.token })).json();
  const conv = listaAna.conversations.find((c) => c.id === conversationId);
  assert.ok(conv, 'a criadora vê a conversa na sua lista');
  assert.strictEqual(conv.isGroup, false, 'conversa com 2 membros não é grupo');
  assert.strictEqual(conv.title, null);
  assert.strictEqual(conv.memberIds.length, 2);
  assert.ok(conv.memberIds.includes(ana.userId), 'a criadora fica como membro');
  assert.ok(conv.memberIds.includes(bruno.userId), 'o amigo convidado fica como membro');

  const listaBruno = await (await jsonFetch('/api/conversations', { token: bruno.token })).json();
  assert.ok(
    listaBruno.conversations.some((c) => c.id === conversationId),
    'o amigo convidado também vê a conversa',
  );
});

test('POST com membro que não é amigo → 403', async () => {
  const resposta = await jsonFetch('/api/conversations', {
    method: 'POST',
    token: ana.token,
    body: { memberIds: [eva.userId] }, // eva não é amiga da ana
  });
  assert.strictEqual(resposta.status, 403);
  const corpo = await resposta.json();
  assert.strictEqual(corpo.ok, false);

  // No outro sentido também: eva (não-amiga) tenta criar com o bruno.
  const inverso = await jsonFetch('/api/conversations', {
    method: 'POST',
    token: eva.token,
    body: { memberIds: [bruno.userId] },
  });
  assert.strictEqual(inverso.status, 403);
});

test('POST exige sessão (401) e valida memberIds (400); utilizador desconhecido → 404', async () => {
  const semSessao = await jsonFetch('/api/conversations', {
    method: 'POST',
    body: { memberIds: [bruno.userId] },
  });
  assert.strictEqual(semSessao.status, 401);

  const vazio = await jsonFetch('/api/conversations', {
    method: 'POST',
    token: ana.token,
    body: { memberIds: [] },
  });
  assert.strictEqual(vazio.status, 400);

  const naoLista = await jsonFetch('/api/conversations', {
    method: 'POST',
    token: ana.token,
    body: { memberIds: bruno.userId },
  });
  assert.strictEqual(naoLista.status, 400);

  const desconhecido = await jsonFetch('/api/conversations', {
    method: 'POST',
    token: ana.token,
    body: { memberIds: ['00000000-0000-4000-8000-000000000000'] },
  });
  assert.strictEqual(desconhecido.status, 404);
});

test('grupo com dois amigos convidados: isGroup e título', async () => {
  const conversationId = await criarConversaRest(
    ana,
    [bruno.userId, carla.userId],
    'Sessão de sexta',
  );

  const lista = await (await jsonFetch('/api/conversations', { token: ana.token })).json();
  const conv = lista.conversations.find((c) => c.id === conversationId);
  assert.ok(conv, 'conversa de grupo listada');
  assert.strictEqual(conv.isGroup, true, '3 membros → grupo');
  assert.strictEqual(conv.title, 'Sessão de sexta');
  assert.strictEqual(conv.memberIds.length, 3);
});

// --- 2. REST: histórico -----------------------------------------------------------

test('histórico: mais recentes primeiro e paginação via before', async () => {
  const conversationId = await criarConversaRest(ana, [bruno.userId]);
  const gravadas = [];
  for (let i = 1; i <= 5; i += 1) {
    gravadas.push(store.appendMessage(conversationId, ana.userId, `msg-${i}`));
  }

  const base = `/api/conversations/${conversationId}/messages`;

  const pagina1 = await (await jsonFetch(`${base}?limit=2`, { token: ana.token })).json();
  assert.deepStrictEqual(pagina1.messages.map((m) => m.text), ['msg-5', 'msg-4']);

  const pagina2 = await (
    await jsonFetch(`${base}?limit=2&before=${gravadas[3].id}`, { token: ana.token })
  ).json();
  assert.deepStrictEqual(pagina2.messages.map((m) => m.text), ['msg-3', 'msg-2']);

  // Sem limit: devolve tudo o que é mais antigo que o cursor (por omissão 50).
  const pagina3 = await (
    await jsonFetch(`${base}?before=${gravadas[3].id}`, { token: ana.token })
  ).json();
  assert.deepStrictEqual(pagina3.messages.map((m) => m.text), ['msg-3', 'msg-2', 'msg-1']);

  // Cursor na mensagem mais antiga: nada mais antigo → lista vazia.
  const fim = await (
    await jsonFetch(`${base}?before=${gravadas[0].id}`, { token: ana.token })
  ).json();
  assert.deepStrictEqual(fim.messages, []);
});

test('parâmetros inválidos → 400; cursor válido desconhecido → lista vazia', async () => {
  const conversationId = await criarConversaRest(ana, [bruno.userId]);
  store.appendMessage(conversationId, ana.userId, 'única');

  const base = `/api/conversations/${conversationId}/messages`;
  assert.strictEqual((await jsonFetch(`${base}?limit=banana`, { token: ana.token })).status, 400);
  assert.strictEqual((await jsonFetch(`${base}?limit=0`, { token: ana.token })).status, 400);
  assert.strictEqual((await jsonFetch(`${base}?limit=-1`, { token: ana.token })).status, 400);
  assert.strictEqual((await jsonFetch(`${base}?before=banana`, { token: ana.token })).status, 400);

  // Formato válido mas cursor fora do intervalo → [] (regra vinculante da store).
  const vazia = await (
    await jsonFetch(`${base}?before=00000000-0000-4000-8000-000000000000`, { token: ana.token })
  ).json();
  assert.deepStrictEqual(vazia.messages, []);
});

test('não-membro não lê o histórico (403)', async () => {
  const conversationId = await criarConversaRest(ana, [bruno.userId]);
  store.appendMessage(conversationId, ana.userId, 'secreta');

  const resposta = await jsonFetch(urlHistorico(conversationId), { token: eva.token });
  assert.strictEqual(resposta.status, 403);
});

// --- 3. WS: chat_send -------------------------------------------------------------

test('chat_send grava e o segundo membro online recebe chat_message', async () => {
  const conversationId = await criarConversaRest(ana, [bruno.userId]);
  const brunoCli = await clienteAutenticado(bruno.token);
  const anaCli = await clienteAutenticado(ana.token);

  anaCli.enviar({ type: 'chat_send', conversationId, text: 'olá bruno' });

  const recebida = await esperarNovaMensagem(brunoCli, (m) => m.type === 'chat_message');
  assert.strictEqual(recebida.type, 'chat_message');
  assert.strictEqual(recebida.conversationId, conversationId);
  assert.strictEqual(recebida.fromUserId, ana.userId);
  assert.strictEqual(recebida.fromName, 'chat_ana');
  assert.strictEqual(recebida.text, 'olá bruno');
  assert.strictEqual(typeof recebida.ts, 'string');
  assert.deepStrictEqual(
    Object.keys(recebida).sort(),
    ['conversationId', 'fromName', 'fromUserId', 'text', 'ts', 'type'],
    'o envelope tem exatamente os campos do brief',
  );

  // O remetente recebe o próprio eco UMA vez (via a sua ação), sem duplicação.
  await dormir(200);
  assert.strictEqual(
    mensagensDe(anaCli, (m) => m.type === 'chat_message').length,
    1,
    'remetente: exatamente um chat_message',
  );

  // A mensagem ficou gravada no histórico.
  const historico = await lerHistorico(ana.token, conversationId);
  assert.deepStrictEqual(historico.messages.map((m) => m.text), ['olá bruno']);

  await Promise.all([fecharCliente(anaCli), fecharCliente(brunoCli)]);
});

test('multi-aba: todas as abas do destinatário e do remetente recebem (eco multi-dispositivo)', async () => {
  const conversationId = await criarConversaRest(ana, [bruno.userId]);
  const brunoAba1 = await clienteAutenticado(bruno.token);
  const brunoAba2 = await clienteAutenticado(bruno.token);
  const anaAba1 = await clienteAutenticado(ana.token);
  const anaAba2 = await clienteAutenticado(ana.token);

  anaAba1.enviar({ type: 'chat_send', conversationId, text: 'para todas as abas' });

  const noBruno1 = await esperarNovaMensagem(brunoAba1, (m) => m.type === 'chat_message');
  const noBruno2 = await esperarNovaMensagem(brunoAba2, (m) => m.type === 'chat_message');
  assert.strictEqual(noBruno1.text, 'para todas as abas');
  assert.strictEqual(noBruno2.text, 'para todas as abas');

  await dormir(200);
  assert.strictEqual(
    mensagensDe(anaAba1, (m) => m.type === 'chat_message').length,
    1,
    'aba remetente: exatamente o eco da própria ação',
  );
  assert.strictEqual(
    mensagensDe(anaAba2, (m) => m.type === 'chat_message').length,
    1,
    'outra aba do remetente também recebe o eco (mesma conta em outro socket)',
  );

  await Promise.all([
    fecharCliente(brunoAba1), fecharCliente(brunoAba2), fecharCliente(anaAba1), fecharCliente(anaAba2),
  ]);
});

test('chat_send de não-membro → E_FORBIDDEN e a ligação mantém-se viva', async () => {
  const conversationId = await criarConversaRest(ana, [bruno.userId]);
  const carlaCli = await clienteAutenticado(carla.token);

  carlaCli.enviar({ type: 'chat_send', conversationId, text: 'posso entrar?' });
  const primeiro = await esperarNovaMensagem(carlaCli, (m) => m.type === 'error');
  assert.deepStrictEqual(primeiro, { type: 'error', code: 'E_FORBIDDEN' });

  // Sem fecho: um segundo envio também é respondido (Review Focus 3).
  carlaCli.enviar({ type: 'chat_send', conversationId, text: 'continuo ligada?' });
  const segundo = await esperarNovaMensagem(carlaCli, (m) => m.type === 'error');
  assert.deepStrictEqual(segundo, { type: 'error', code: 'E_FORBIDDEN' });
  assert.strictEqual(carlaCli.fechado, null, 'a ligação não foi fechada');

  // Nada foi gravado pela não-membro.
  const historico = await lerHistorico(ana.token, conversationId);
  assert.deepStrictEqual(historico.messages, []);

  await fecharCliente(carlaCli);
});

test('chat_send com text inválido → E_INVALID; conversa desconhecida → E_FORBIDDEN', async () => {
  const conversationId = await criarConversaRest(ana, [bruno.userId]);
  const anaCli = await clienteAutenticado(ana.token);

  anaCli.enviar({ type: 'chat_send', conversationId, text: '' });
  assert.deepStrictEqual(
    await esperarNovaMensagem(anaCli, (m) => m.type === 'error'),
    { type: 'error', code: 'E_INVALID' },
  );

  anaCli.enviar({ type: 'chat_send', conversationId, text: 42 });
  assert.deepStrictEqual(
    await esperarNovaMensagem(anaCli, (m) => m.type === 'error'),
    { type: 'error', code: 'E_INVALID' },
  );

  // Conversa inexistente: ana não é membro dela → E_FORBIDDEN (não E_UNKNOWN_TYPE).
  anaCli.enviar({
    type: 'chat_send',
    conversationId: '00000000-0000-4000-8000-000000000000',
    text: 'olá?',
  });
  assert.deepStrictEqual(
    await esperarNovaMensagem(anaCli, (m) => m.type === 'error'),
    { type: 'error', code: 'E_FORBIDDEN' },
  );

  await dormir(200);
  assert.strictEqual(mensagensDe(anaCli, (m) => m.type === 'error').length, 3);

  // Nada dos frames inválidos ficou gravado.
  const historico = await lerHistorico(ana.token, conversationId);
  assert.deepStrictEqual(historico.messages, []);

  await fecharCliente(anaCli);
});

test('grupo: a mensagem chega a todos os outros membros online', async () => {
  const conversationId = await criarConversaRest(ana, [bruno.userId, carla.userId]);
  const brunoCli = await clienteAutenticado(bruno.token);
  const carlaCli = await clienteAutenticado(carla.token);
  const anaCli = await clienteAutenticado(ana.token);

  anaCli.enviar({ type: 'chat_send', conversationId, text: 'bem-vindos ao grupo' });

  const noBruno = await esperarNovaMensagem(brunoCli, (m) => m.type === 'chat_message');
  const naCarla = await esperarNovaMensagem(carlaCli, (m) => m.type === 'chat_message');
  assert.strictEqual(noBruno.fromName, 'chat_ana');
  assert.strictEqual(naCarla.text, 'bem-vindos ao grupo');

  await Promise.all([fecharCliente(anaCli), fecharCliente(brunoCli), fecharCliente(carlaCli)]);
});
