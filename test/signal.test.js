'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');

const { createServer } = require('../src/server');
const { createStoreMemory } = require('../src/store-memory');

// --- servidor partilhado (porta efêmera) -------------------------------------

let http;
let attach;
let urlWs;
let store;

/** ana é amiga de bruno e carla; eva não é amiga de ninguém. */
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
  urlWs = `ws://127.0.0.1:${http.address().port}`;
  attach({ authTimeoutMs: 300 });

  ana = store.createUser({ username: 'sig_ana', passHash: 'x', secQ: 'q', secA: 'a' });
  bruno = store.createUser({ username: 'sig_bruno', passHash: 'x', secQ: 'q', secA: 'a' });
  carla = store.createUser({ username: 'sig_carla', passHash: 'x', secQ: 'q', secA: 'a' });
  eva = store.createUser({ username: 'sig_eva', passHash: 'x', secQ: 'q', secA: 'a' });

  const pedidoBruno = store.createFriendRequest(ana.id, bruno.id);
  store.acceptFriendRequest(pedidoBruno.id, bruno.id);
  const pedidoCarla = store.createFriendRequest(ana.id, carla.id);
  store.acceptFriendRequest(pedidoCarla.id, carla.id);
});

after(async () => {
  await Promise.allSettled(clientes.map((c) => fecharCliente(c)));
  await new Promise((resolve) => {
    http.close(() => resolve());
    http.closeAllConnections();
  });
});

// --- ajudantes ws ---------------------------------------------------------------

const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Abre um cliente ws e devolve um saco de mensagens (JSON + brutas) com esperas. */
function abrirCliente() {
  return new Promise((resolve) => {
    const ws = new WebSocket(urlWs);
    const cliente = {
      ws,
      mensagens: [],
      brutos: [],
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
      const texto = dados.toString();
      cliente.brutos.push(texto);
      const msg = JSON.parse(texto);
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
async function clienteAutenticado(user) {
  const cliente = await abrirCliente();
  cliente.enviar({ type: 'auth', token: store.createSession(user.id) });
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

// --- 1. call_invite -----------------------------------------------------------------

test('call_invite entrega call_incoming ao amigo online e responde call_ack com delivered', async () => {
  const brunoCli = await clienteAutenticado(bruno);
  const anaCli = await clienteAutenticado(ana);

  anaCli.enviar({
    type: 'call_invite',
    callId: 'chamada-1',
    toUserIds: [bruno.id],
    media: 'av',
  });

  const incoming = await esperarNovaMensagem(brunoCli, (m) => m.type === 'call_incoming');
  assert.deepStrictEqual(incoming, {
    type: 'call_incoming',
    callId: 'chamada-1',
    fromUserId: ana.id,
    fromName: 'sig_ana',
    media: 'av',
  });
  assert.deepStrictEqual(
    Object.keys(incoming).sort(),
    ['callId', 'fromName', 'fromUserId', 'media', 'type'],
    'o envelope tem exatamente os campos do brief',
  );

  const ack = await esperarNovaMensagem(anaCli, (m) => m.type === 'call_ack');
  assert.deepStrictEqual(ack, {
    type: 'call_ack',
    callId: 'chamada-1',
    delivered: [bruno.id],
    missed: [],
  });

  await Promise.all([fecharCliente(anaCli), fecharCliente(brunoCli)]);
});

test('call_invite com destinos duplicados entrega uma única vez (ack deduplicado)', async () => {
  const brunoCli = await clienteAutenticado(bruno);
  const anaCli = await clienteAutenticado(ana);

  // O ack é esperado ANTES do envio: chega em milissegundos, durante a espera
  // do call_incoming — esperar só depois dele perderia a mensagem (o auxiliar
  // espera apenas por mensagens futuras, ignora o histórico recebido).
  const promessaAck = esperarNovaMensagem(anaCli, (m) => m.type === 'call_ack');

  anaCli.enviar({
    type: 'call_invite',
    callId: 'chamada-dup',
    toUserIds: [bruno.id, bruno.id],
    media: 'av',
  });

  await esperarNovaMensagem(brunoCli, (m) => m.type === 'call_incoming');
  await dormir(150);
  assert.strictEqual(
    mensagensDe(brunoCli, (m) => m.type === 'call_incoming').length,
    1,
    'apenas um call_incoming apesar do destino repetido',
  );

  const ack = await promessaAck;
  assert.deepStrictEqual(ack.delivered, [bruno.id]);
  assert.deepStrictEqual(ack.missed, []);

  await Promise.all([fecharCliente(anaCli), fecharCliente(brunoCli)]);
});

test('call_invite a amigo offline vai para missed no ack (sem entrega, sem erro)', async () => {
  // O bruno não tem ligação aberta neste teste.
  const anaCli = await clienteAutenticado(ana);

  anaCli.enviar({
    type: 'call_invite',
    callId: 'chamada-perdida',
    toUserIds: [bruno.id],
    media: 'av',
  });

  const ack = await esperarNovaMensagem(anaCli, (m) => m.type === 'call_ack');
  assert.deepStrictEqual(ack, {
    type: 'call_ack',
    callId: 'chamada-perdida',
    delivered: [],
    missed: [bruno.id],
  });

  // Nada ficou guardado: quando o bruno se liga depois, não chega convite.
  const brunoCli = await clienteAutenticado(bruno);
  await dormir(250);
  assert.deepStrictEqual(mensagensDe(brunoCli, (m) => m.type === 'call_incoming'), []);

  await Promise.all([fecharCliente(anaCli), fecharCliente(brunoCli)]);
});

test('call_invite de grupo: delivered e missed separados, pela ordem dos destinos', async () => {
  const brunoCli = await clienteAutenticado(bruno); // a carla fica offline
  const anaCli = await clienteAutenticado(ana);

  anaCli.enviar({
    type: 'call_invite',
    callId: 'chamada-grupo',
    toUserIds: [bruno.id, carla.id],
    media: 'av',
  });

  const noBruno = await esperarNovaMensagem(brunoCli, (m) => m.type === 'call_incoming');
  assert.deepStrictEqual(noBruno, {
    type: 'call_incoming',
    callId: 'chamada-grupo',
    fromUserId: ana.id,
    fromName: 'sig_ana',
    media: 'av',
  });

  const ack = await esperarNovaMensagem(anaCli, (m) => m.type === 'call_ack');
  assert.deepStrictEqual(ack, {
    type: 'call_ack',
    callId: 'chamada-grupo',
    delivered: [bruno.id],
    missed: [carla.id],
  });

  await Promise.all([fecharCliente(anaCli), fecharCliente(brunoCli)]);
});

test('call_invite: não-amigo → E_FORBIDDEN; desconhecido → E_NOTFOUND; ligação mantém-se viva', async () => {
  const anaCli = await clienteAutenticado(ana);

  anaCli.enviar({ type: 'call_invite', callId: 'c1', toUserIds: [eva.id], media: 'av' });
  const primeiro = await esperarNovaMensagem(anaCli, (m) => m.type === 'error');
  assert.deepStrictEqual(primeiro, { type: 'error', code: 'E_FORBIDDEN' });

  // Sem fecho: um segundo envio também é respondido (padrão Review Focus 3).
  anaCli.enviar({ type: 'call_invite', callId: 'c2', toUserIds: [eva.id], media: 'av' });
  const segundo = await esperarNovaMensagem(anaCli, (m) => m.type === 'error');
  assert.deepStrictEqual(segundo, { type: 'error', code: 'E_FORBIDDEN' });
  assert.strictEqual(anaCli.fechado, null, 'a ligação não foi fechada');

  anaCli.enviar({
    type: 'call_invite',
    callId: 'c3',
    toUserIds: ['00000000-0000-4000-8000-000000000000'],
    media: 'av',
  });
  assert.deepStrictEqual(
    await esperarNovaMensagem(anaCli, (m) => m.type === 'error'),
    { type: 'error', code: 'E_NOTFOUND' },
  );

  // Convidar-se a si própria também é E_FORBIDDEN: ninguém é amigo de si
  // (store) e o controller manda falhar QUALQUER destino não-amigo.
  anaCli.enviar({ type: 'call_invite', callId: 'c4', toUserIds: [ana.id], media: 'av' });
  assert.deepStrictEqual(
    await esperarNovaMensagem(anaCli, (m) => m.type === 'error'),
    { type: 'error', code: 'E_FORBIDDEN' },
  );

  await fecharCliente(anaCli);
});

test('call_invite com um destino mau não entrega a NINGUÉM (validação antes do envio)', async () => {
  const brunoCli = await clienteAutenticado(bruno);
  const anaCli = await clienteAutenticado(ana);

  anaCli.enviar({
    type: 'call_invite',
    callId: 'c-parcial',
    toUserIds: [bruno.id, eva.id],
    media: 'av',
  });
  assert.deepStrictEqual(
    await esperarNovaMensagem(anaCli, (m) => m.type === 'error'),
    { type: 'error', code: 'E_FORBIDDEN' },
  );

  await dormir(250);
  assert.deepStrictEqual(mensagensDe(brunoCli, (m) => m.type === 'call_incoming'), []);
  assert.deepStrictEqual(mensagensDe(anaCli, (m) => m.type === 'call_ack'), []);

  await Promise.all([fecharCliente(anaCli), fecharCliente(brunoCli)]);
});

// --- 2. call_signal -----------------------------------------------------------------

test('call_signal é retransmitido intacto (byte-a-byte) ao amigo online', async () => {
  const brunoCli = await clienteAutenticado(bruno);
  const anaCli = await clienteAutenticado(ana);

  // data é opaco: objeto aninhado com unicode, aspas, null e booleanos, com
  // uma ordem de chaves pouco convencional — o servidor não pode tocá-lo.
  const DATA_JSON = '{"zz":1,"aa":{"b":2,"a":[3,null,"café ☕ \\"entre aspas\\""],"ok":true}}';
  anaCli.enviar(
    `{"type":"call_signal","callId":"s-1","toUserId":"${bruno.id}","data":${DATA_JSON}}`,
  );

  const recebido = await esperarNovaMensagem(brunoCli, (m) => m.type === 'call_signal');
  assert.strictEqual(recebido.callId, 's-1');
  assert.strictEqual(recebido.fromUserId, ana.id);
  assert.deepStrictEqual(
    Object.keys(recebido).sort(),
    ['callId', 'data', 'fromUserId', 'type'],
    'o envelope retransmitido tem exatamente os campos do brief',
  );
  assert.deepStrictEqual(recebido.data, JSON.parse(DATA_JSON));

  // Byte-a-byte: a serialização de data no frame recebido é idêntica à enviada.
  assert.ok(
    brunoCli.brutos.some((texto) => texto.includes(`"data":${DATA_JSON}`)),
    'os bytes de data chegam intactos ao destino',
  );

  await Promise.all([fecharCliente(anaCli), fecharCliente(brunoCli)]);
});

test('call_signal multi-aba: chega a todas as abas do destino', async () => {
  const brunoAba1 = await clienteAutenticado(bruno);
  const brunoAba2 = await clienteAutenticado(bruno);
  const anaCli = await clienteAutenticado(ana);

  anaCli.enviar({
    type: 'call_signal',
    callId: 's-tabs',
    toUserId: bruno.id,
    data: { ice: 'candidata' },
  });

  const naAba1 = await esperarNovaMensagem(brunoAba1, (m) => m.type === 'call_signal');
  const naAba2 = await esperarNovaMensagem(brunoAba2, (m) => m.type === 'call_signal');
  assert.deepStrictEqual(naAba1.data, { ice: 'candidata' });
  assert.deepStrictEqual(naAba2.data, { ice: 'candidata' });
  assert.strictEqual(naAba2.fromUserId, ana.id);

  await Promise.all([fecharCliente(anaCli), fecharCliente(brunoAba1), fecharCliente(brunoAba2)]);
});

test('call_signal: desconhecido → E_NOTFOUND; offline → E_NOTFOUND; não-amigo → E_FORBIDDEN', async () => {
  const anaCli = await clienteAutenticado(ana);

  anaCli.enviar({
    type: 'call_signal',
    callId: 's2',
    toUserId: '00000000-0000-4000-8000-000000000000',
    data: {},
  });
  assert.deepStrictEqual(
    await esperarNovaMensagem(anaCli, (m) => m.type === 'error'),
    { type: 'error', code: 'E_NOTFOUND' },
  );

  // O bruno está offline neste teste → E_NOTFOUND (decisão do controller).
  anaCli.enviar({ type: 'call_signal', callId: 's3', toUserId: bruno.id, data: {} });
  assert.deepStrictEqual(
    await esperarNovaMensagem(anaCli, (m) => m.type === 'error'),
    { type: 'error', code: 'E_NOTFOUND' },
  );

  anaCli.enviar({ type: 'call_signal', callId: 's4', toUserId: eva.id, data: {} });
  assert.deepStrictEqual(
    await esperarNovaMensagem(anaCli, (m) => m.type === 'error'),
    { type: 'error', code: 'E_FORBIDDEN' },
  );

  assert.strictEqual(anaCli.fechado, null, 'a ligação não foi fechada');
  await fecharCliente(anaCli);
});

// --- 3. call_end ----------------------------------------------------------------------

test('call_end chega ao destinatário com os campos do relay', async () => {
  const brunoCli = await clienteAutenticado(bruno);
  const anaCli = await clienteAutenticado(ana);

  anaCli.enviar({ type: 'call_end', callId: 'chamada-1', toUserIds: [bruno.id] });

  const fim = await esperarNovaMensagem(brunoCli, (m) => m.type === 'call_end');
  assert.deepStrictEqual(fim, {
    type: 'call_end',
    callId: 'chamada-1',
    fromUserId: ana.id,
  });
  assert.deepStrictEqual(Object.keys(fim).sort(), ['callId', 'fromUserId', 'type']);

  await Promise.all([fecharCliente(anaCli), fecharCliente(brunoCli)]);
});

test('call_end: sem toUserIds → E_INVALID (v1 exige lista); não-amigo → E_FORBIDDEN', async () => {
  const anaCli = await clienteAutenticado(ana);

  anaCli.enviar({ type: 'call_end', callId: 'c-fim' });
  assert.deepStrictEqual(
    await esperarNovaMensagem(anaCli, (m) => m.type === 'error'),
    { type: 'error', code: 'E_INVALID' },
  );

  anaCli.enviar({ type: 'call_end', callId: 'c-fim', toUserIds: [eva.id] });
  assert.deepStrictEqual(
    await esperarNovaMensagem(anaCli, (m) => m.type === 'error'),
    { type: 'error', code: 'E_FORBIDDEN' },
  );

  await fecharCliente(anaCli);
});

// --- 4. validação e robustez ------------------------------------------------------------

test('campos obrigatórios malformados → E_INVALID', async () => {
  const anaCli = await clienteAutenticado(ana);

  anaCli.enviar({ type: 'call_invite', toUserIds: [bruno.id], media: 'av' }); // sem callId
  anaCli.enviar({ type: 'call_invite', callId: 'x', toUserIds: [], media: 'av' }); // lista vazia
  anaCli.enviar({ type: 'call_invite', callId: 'x', toUserIds: bruno.id, media: 'av' }); // não é lista
  anaCli.enviar({ type: 'call_invite', callId: 'x', toUserIds: [42], media: 'av' }); // destino não-string
  anaCli.enviar({ type: 'call_signal', toUserId: bruno.id, data: {} }); // sem callId
  anaCli.enviar({ type: 'call_signal', callId: 'x', toUserId: 42, data: {} }); // destino não-string
  anaCli.enviar({ type: 'call_end', callId: 'x', toUserIds: 'todos' }); // não é lista

  await dormir(250);
  const erros = mensagensDe(anaCli, (m) => m.type === 'error');
  assert.strictEqual(erros.length, 7, 'os sete envelopes maus são respondidos');
  assert.ok(erros.every((m) => m.code === 'E_INVALID'), 'todos os erros são E_INVALID');

  await fecharCliente(anaCli);
});

test('tipo de chamada desconhecido continua E_UNKNOWN_TYPE (handlers não capturam o resto)', async () => {
  const anaCli = await clienteAutenticado(ana);

  anaCli.enviar({ type: 'call_xpto', callId: 'x', toUserIds: [bruno.id] });
  assert.deepStrictEqual(
    await esperarNovaMensagem(anaCli, (m) => m.type === 'error'),
    { type: 'error', code: 'E_UNKNOWN_TYPE' },
  );

  await fecharCliente(anaCli);
});
