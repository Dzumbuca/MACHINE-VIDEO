'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');

const { createServer } = require('../src/server');
const { createStoreMemory } = require('../src/store-memory');

// --- servidor partilhado (porta efêmera) -------------------------------------

let http;
let attach;
let wss;
let urlWs;
let store;
let tokenAna;
let tokenBruno;
let tokenCarla;
let idAna;

/** Clientes abertos durante os testes; o after() fecha os que sobrarem. */
const clientes = [];

before(async () => {
  store = createStoreMemory();
  ({ http, attach } = createServer({ store }));
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  urlWs = `ws://127.0.0.1:${http.address().port}`;

  // Tempo-limite de auth curto nos testes (a produção usa os 5 s por omissão).
  wss = attach({ authTimeoutMs: 300 });

  // Ana e Bruno são amigos; Carla não é amiga de ninguém.
  const ana = store.createUser({ username: 'ana_ws', passHash: 'x', secQ: 'q', secA: 'a' });
  const bruno = store.createUser({ username: 'bruno_ws', passHash: 'x', secQ: 'q', secA: 'a' });
  const carla = store.createUser({ username: 'carla_ws', passHash: 'x', secQ: 'q', secA: 'a' });
  idAna = ana.id;
  const pedido = store.createFriendRequest(ana.id, bruno.id);
  store.acceptFriendRequest(pedido.id, bruno.id);
  tokenAna = store.createSession(ana.id);
  tokenBruno = store.createSession(bruno.id);
  tokenCarla = store.createSession(carla.id);
});

after(async () => {
  await Promise.allSettled(clientes.map((c) => fecharCliente(c)));
  await new Promise((resolve) => {
    http.close(() => resolve());
    http.closeAllConnections();
  });
});

// --- ajudantes -----------------------------------------------------------------

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

/** Igual a esperarNovaMensagem mas aceita mensagem já recebida no histórico. */
function esperarMensagem(cliente, filtro, timeoutMs = 1500) {
  const existente = cliente.mensagens.find(filtro);
  if (existente) return Promise.resolve(existente);
  return esperarNovaMensagem(cliente, filtro, timeoutMs);
}

/** Espera o fecho da ligação (imediato se já fechou). */
function esperarFecho(cliente, timeoutMs = 2000) {
  if (cliente.fechado) return Promise.resolve(cliente.fechado);
  return new Promise((resolve, reject) => {
    const espera = {
      resolve: (fecho) => {
        clearTimeout(temporizador);
        resolve(fecho);
      },
    };
    const temporizador = setTimeout(() => {
      cliente.esperasFecho = cliente.esperasFecho.filter((e) => e !== espera);
      reject(new Error('tempo esgotado à espera do fecho da ligação'));
    }, timeoutMs);
    cliente.esperasFecho.push(espera);
  });
}

/** Envia {type:"auth"} e devolve o auth_ok (lança se chegar outra coisa). */
async function autenticar(cliente, token) {
  cliente.enviar({ type: 'auth', token });
  const resposta = await esperarNovaMensagem(
    cliente,
    (m) => m.type === 'auth_ok' || m.type === 'error',
  );
  if (!resposta || resposta.type !== 'auth_ok') {
    throw new Error(`autenticação falhou: ${JSON.stringify(resposta)}`);
  }
  return resposta;
}

async function fecharCliente(cliente) {
  if (cliente.fechado) return;
  cliente.ws.close();
  await esperarFecho(cliente);
}

function mensagensDe(cliente, filtro) {
  return cliente.mensagens.filter(filtro);
}

// --- 1. autenticação ------------------------------------------------------------

test('auth com token válido responde auth_ok com o utilizador público', async () => {
  const cliente = await abrirCliente();
  cliente.enviar({ type: 'auth', token: tokenAna });
  const resposta = await esperarNovaMensagem(cliente, (m) => m.type === 'auth_ok');
  assert.deepStrictEqual(resposta, {
    type: 'auth_ok',
    user: { id: idAna, username: 'ana_ws', phone: null, visibilidade: 'publico' },
  });
  await fecharCliente(cliente);
});

test('token inválido fecha a ligação sem responder', async () => {
  const cliente = await abrirCliente();
  cliente.enviar({ type: 'auth', token: 'f'.repeat(64) });
  const fecho = await esperarFecho(cliente);
  assert.ok(fecho, 'a ligação foi fechada');
  assert.deepStrictEqual(cliente.mensagens, [], 'nenhuma resposta antes do fecho');
});

test('socket sem auth que envia outro tipo é fechado', async () => {
  const cliente = await abrirCliente();
  cliente.enviar({ type: 'chat_send', text: 'olá' });
  const fecho = await esperarFecho(cliente);
  assert.ok(fecho, 'a ligação foi fechada por enviar outro tipo antes do auth');
});

test('ligação sem autenticação é fechada por tempo-limite', async () => {
  const cliente = await abrirCliente();
  const fecho = await esperarFecho(cliente, 2000);
  assert.ok(fecho, 'o tempo-limite de auth fechou a ligação');
});

// --- 2. robustez -----------------------------------------------------------------

test('frame não-JSON num socket autenticado responde E_BADJSON e a ligação continua', async () => {
  const cliente = await abrirCliente();
  await autenticar(cliente, tokenAna);

  cliente.enviar('isto não é JSON');
  const primeiro = await esperarNovaMensagem(cliente, (m) => m.type === 'error');
  assert.deepStrictEqual(primeiro, { type: 'error', code: 'E_BADJSON' });

  // A ligação mantém-se viva: um segundo frame inválido também é respondido.
  cliente.enviar('continuo vivo?');
  const segundo = await esperarNovaMensagem(cliente, (m) => m.type === 'error');
  assert.deepStrictEqual(segundo, { type: 'error', code: 'E_BADJSON' });
  assert.notStrictEqual(segundo, primeiro);
  await fecharCliente(cliente);

  // O servidor sobreviveu e aceita novas ligações (Review Focus 5).
  const nova = await abrirCliente();
  const resposta = await autenticar(nova, tokenBruno);
  assert.strictEqual(resposta.user.username, 'bruno_ws');
  await fecharCliente(nova);
});

test('frame não-JSON antes de autenticar informa E_BADJSON e fecha', async () => {
  const cliente = await abrirCliente();
  cliente.enviar('lixo');
  const erro = await esperarNovaMensagem(cliente, (m) => m.type === 'error');
  assert.deepStrictEqual(erro, { type: 'error', code: 'E_BADJSON' });
  const fecho = await esperarFecho(cliente);
  assert.ok(fecho, 'o socket não-autenticado é fechado');
});

test('tipo desconhecido num socket autenticado responde E_UNKNOWN_TYPE sem fechar', async () => {
  const cliente = await abrirCliente();
  await autenticar(cliente, tokenAna);

  cliente.enviar({ type: 'tipo_do_futuro' }); // chat_send passou a ser tratado pela Task 6
  const primeiro = await esperarNovaMensagem(cliente, (m) => m.type === 'error');
  assert.deepStrictEqual(primeiro, { type: 'error', code: 'E_UNKNOWN_TYPE' });

  // Continua a processar mensagens — a ligação não foi fechada.
  cliente.enviar({ type: 'outro' });
  const segundo = await esperarNovaMensagem(cliente, (m) => m.type === 'error');
  assert.deepStrictEqual(segundo, { type: 'error', code: 'E_UNKNOWN_TYPE' });
  assert.notStrictEqual(segundo, primeiro);
  await fecharCliente(cliente);
});

// --- 3. presença ------------------------------------------------------------------

test('presença online chega ao amigo ligado e não chega a quem não é amigo', async () => {
  const bruno = await abrirCliente();
  await autenticar(bruno, tokenBruno);
  const carla = await abrirCliente();
  await autenticar(carla, tokenCarla);

  const ana = await abrirCliente();
  await autenticar(ana, tokenAna);

  const aviso = await esperarMensagem(bruno, (m) => m.type === 'presence');
  assert.deepStrictEqual(aviso, { type: 'presence', userId: idAna, online: true });

  // Carla não é amiga da Ana e a própria Ana não recebe o próprio aviso.
  await dormir(250);
  assert.deepStrictEqual(mensagensDe(carla, (m) => m.type === 'presence'), []);
  assert.deepStrictEqual(mensagensDe(ana, (m) => m.type === 'presence'), []);

  await Promise.all([fecharCliente(ana), fecharCliente(bruno), fecharCliente(carla)]);
});

test('multi-aba: aviso de presença só na primeira ligação e no último fecho', async () => {
  const bruno = await abrirCliente();
  await autenticar(bruno, tokenBruno);

  const aba1 = await abrirCliente();
  await autenticar(aba1, tokenAna);
  const online = await esperarMensagem(
    bruno,
    (m) => m.type === 'presence' && m.userId === idAna,
  );
  assert.deepStrictEqual(online, { type: 'presence', userId: idAna, online: true });

  // Segunda aba da Ana: mais nenhum aviso para o Bruno.
  const aba2 = await abrirCliente();
  await autenticar(aba2, tokenAna);
  await dormir(250);
  assert.strictEqual(
    mensagensDe(bruno, (m) => m.type === 'presence' && m.userId === idAna).length,
    1,
    'apenas um aviso online apesar de duas abas',
  );

  // Fecha a primeira aba: continua online (a segunda aba mantém a presença).
  await fecharCliente(aba1);
  await dormir(250);
  assert.strictEqual(
    mensagensDe(bruno, (m) => m.type === 'presence' && m.userId === idAna).length,
    1,
    'sem aviso offline enquanto há outra aba',
  );

  // Fecha a última aba → o amigo recebe o offline.
  await fecharCliente(aba2);
  const offline = await esperarMensagem(
    bruno,
    (m) => m.type === 'presence' && m.userId === idAna && m.online === false,
  );
  assert.deepStrictEqual(offline, { type: 'presence', userId: idAna, online: false });

  await fecharCliente(bruno);
});
