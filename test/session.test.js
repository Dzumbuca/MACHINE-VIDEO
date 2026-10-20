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

/** ana é anfitriã; bruno e carla são amigos dela; eva não é amiga de ninguém. */
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

  ana = store.createUser({ username: 'ses_ana', passHash: 'x', secQ: 'q', secA: 'a' });
  bruno = store.createUser({ username: 'ses_bruno', passHash: 'x', secQ: 'q', secA: 'a' });
  carla = store.createUser({ username: 'ses_carla', passHash: 'x', secQ: 'q', secA: 'a' });
  eva = store.createUser({ username: 'ses_eva', passHash: 'x', secQ: 'q', secA: 'a' });

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

// --- ajudantes ws (mesmo padrão de test/signal.test.js) -----------------------

const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function abrirCliente() {
  return new Promise((resolve) => {
    const ws = new WebSocket(urlWs);
    const cliente = {
      ws, mensagens: [], fechado: null, esperas: [], esperasFecho: [],
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
        if (!espera.filtro(msg)) return true;
        espera.resolve(msg);
        return false;
      });
    });
    ws.on('close', (code) => {
      cliente.fechado = { code };
      cliente.esperas.splice(0).forEach((espera) => espera.resolve(null));
      cliente.esperasFecho.splice(0).forEach((espera) => espera.resolve(cliente.fechado));
    });
  });
}

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

async function clienteAutenticado(user) {
  const cliente = await abrirCliente();
  cliente.enviar({ type: 'auth', token: store.createSession(user.id) });
  const resposta = await esperarNovaMensagem(cliente, (m) => m.type === 'auth_ok' || m.type === 'error');
  if (!resposta || resposta.type !== 'auth_ok') {
    throw new Error(`autenticação falhou: ${JSON.stringify(resposta)}`);
  }
  return cliente;
}

const mensagensDe = (cliente, filtro) => cliente.mensagens.filter(filtro);

/** Erro previsto (a ligação mantém-se viva): espera e valida o envelope. */
async function erroDe(cliente, code) {
  const erro = await esperarNovaMensagem(cliente, (m) => m.type === 'error');
  assert.deepStrictEqual(erro, { type: 'error', code });
}

/** Cria uma sessão da ana convidando o bruno e devolve o convite recebido. */
async function criarSessao(anaCli, brunoCli, opcoes = {}) {
  const promessa = esperarNovaMensagem(brunoCli, (m) => m.type === 'session_invite');
  anaCli.enviar({
    type: 'session_create', title: opcoes.title ?? 'Filme de Sexta', fileName: opcoes.fileName ?? 'filme.mp4',
    durationSec: opcoes.durationSec ?? 5400, toUserIds: [bruno.id],
  });
  return promessa;
}

/** Join do bruno (registando a promessa do anúncio ANTES do envio). */
async function juntarBruno(brunoCli, sessionId, fileMatches) {
  const promessa = esperarNovaMensagem(brunoCli, (m) => m.type === 'session_member');
  brunoCli.enviar({ type: 'session_join', sessionId, fileMatches });
  return promessa;
}

// --- 1. session_create → session_invite + session_created (R9) ------------------

test('session_create envia session_invite ao convidado com os campos exatos do brief (R2: 1 convidado chega)', async () => {
  const brunoCli = await clienteAutenticado(bruno);
  const anaCli = await clienteAutenticado(ana);

  const convite = await criarSessao(anaCli, brunoCli);
  assert.ok(typeof convite.sessionId === 'string' && convite.sessionId.length > 0);
  assert.deepStrictEqual(Object.keys(convite).sort(),
    ['durationSec', 'fileName', 'fromName', 'sessionId', 'title', 'type'],
    'o envelope tem exatamente os campos do brief');
  assert.deepStrictEqual({ ...convite, sessionId: '<id>' }, {
    type: 'session_invite', sessionId: '<id>', fromName: 'ses_ana',
    title: 'Filme de Sexta', fileName: 'filme.mp4', durationSec: 5400,
  });

  // A anfitriã não recebe convite ("aos convidados"); o ack dela é o session_created (R9).
  await dormir(250);
  assert.deepStrictEqual(mensagensDe(anaCli, (m) => m.type === 'session_invite'), []);

  // Destino repetido → um único convite (dedup, como no relay da Task 7).
  const promessaDup = esperarNovaMensagem(brunoCli,
    (m) => m.type === 'session_invite' && m.fileName === 'filme-dup.mp4');
  anaCli.enviar({
    type: 'session_create', title: 'Dup', fileName: 'filme-dup.mp4',
    durationSec: 60, toUserIds: [bruno.id, bruno.id],
  });
  await promessaDup;
  await dormir(150);
  assert.strictEqual(
    mensagensDe(brunoCli, (m) => m.type === 'session_invite' && m.fileName === 'filme-dup.mp4').length,
    1, 'destino repetido recebe um único convite',
  );

  await Promise.all([fecharCliente(anaCli), fecharCliente(brunoCli)]);
});

test('session_create responde session_created ao anfitrião (R9) com o sessionId do convite', async () => {
  const brunoCli = await clienteAutenticado(bruno);
  const anaCli = await clienteAutenticado(ana);

  // Promessas registadas ANTES do envio: ack do anfitrião e convite do convidado.
  const promessaAck = esperarNovaMensagem(anaCli, (m) => m.type === 'session_created');
  const convite = await criarSessao(anaCli, brunoCli);
  const ack = await promessaAck;

  assert.strictEqual(ack.sessionId, convite.sessionId, 'o mesmo sessionId que chega ao convidado');
  assert.deepStrictEqual(Object.keys(ack).sort(),
    ['durationSec', 'fileName', 'sessionId', 'title', 'type'], 'campos exatos do R9');
  assert.deepStrictEqual({ ...ack, sessionId: '<id>' }, {
    type: 'session_created', sessionId: '<id>',
    title: 'Filme de Sexta', fileName: 'filme.mp4', durationSec: 5400,
  });

  // Prova fim-a-fim: com o sessionId do ack, o controlo do anfitrião é aceite.
  const noBruno = esperarNovaMensagem(brunoCli, (m) => m.type === 'session_control');
  anaCli.enviar({
    type: 'session_control', sessionId: ack.sessionId,
    action: 'play', positionSec: 7, atMs: 42,
  });
  assert.strictEqual((await noBruno).positionSec, 7);

  await Promise.all([fecharCliente(anaCli), fecharCliente(brunoCli)]);
});

// --- 2. session_join → session_member --------------------------------------------

test('session_join de membro anuncia session_member a todos os membros (anfitriã incluída)', async () => {
  const brunoCli = await clienteAutenticado(bruno);
  const anaCli = await clienteAutenticado(ana);
  const convite = await criarSessao(anaCli, brunoCli);

  // Ambas as promessas registadas ANTES do envio (a difusão chega já).
  const noBruno = esperarNovaMensagem(brunoCli, (m) => m.type === 'session_member');
  const naAna = esperarNovaMensagem(anaCli, (m) => m.type === 'session_member');
  brunoCli.enviar({ type: 'session_join', sessionId: convite.sessionId, fileMatches: true });
  const membroBruno = await noBruno;

  assert.deepStrictEqual(membroBruno, {
    type: 'session_member', sessionId: convite.sessionId,
    userId: bruno.id, username: 'ses_bruno', fileMatches: true,
  });
  assert.deepStrictEqual(await naAna, membroBruno, 'a anfitriã recebe o mesmo anúncio');

  await Promise.all([fecharCliente(anaCli), fecharCliente(brunoCli)]);
});

// --- 3. session_control (anfitriã autoritativa) ------------------------------------

test('session_control da anfitriã chega a todos os membros com os campos exatos do brief', async () => {
  const brunoCli = await clienteAutenticado(bruno);
  const anaCli = await clienteAutenticado(ana);
  const convite = await criarSessao(anaCli, brunoCli);
  await juntarBruno(brunoCli, convite.sessionId, true);

  const noBruno = esperarNovaMensagem(brunoCli, (m) => m.type === 'session_control');
  const naAna = esperarNovaMensagem(anaCli, (m) => m.type === 'session_control');
  anaCli.enviar({
    type: 'session_control', sessionId: convite.sessionId, action: 'play', positionSec: 12, atMs: 345,
  });
  const controleBruno = await noBruno;
  assert.deepStrictEqual(controleBruno, {
    type: 'session_control', sessionId: convite.sessionId,
    action: 'play', positionSec: 12, atMs: 345,
  });
  assert.deepStrictEqual(Object.keys(controleBruno).sort(),
    ['action', 'atMs', 'positionSec', 'sessionId', 'type'],
    'o envelope tem exatamente os campos do brief');
  assert.deepStrictEqual(await naAna, controleBruno, 'a anfitriã também recebe (multi-aba)');

  // Um segundo controlo (seek) chega pela mesma ordem a ambos.
  const noBruno2 = esperarNovaMensagem(brunoCli, (m) => m.type === 'session_control');
  const naAna2 = esperarNovaMensagem(anaCli, (m) => m.type === 'session_control');
  anaCli.enviar({
    type: 'session_control', sessionId: convite.sessionId, action: 'seek', positionSec: 90, atMs: 678,
  });
  assert.strictEqual((await noBruno2).action, 'seek');
  assert.strictEqual((await naAna2).action, 'seek');

  await Promise.all([fecharCliente(anaCli), fecharCliente(brunoCli)]);
});

test('session_control de membro não-anfitriã → E_NOT_HOST e NADA é difundido (Review Focus 4)', async () => {
  const brunoCli = await clienteAutenticado(bruno);
  const anaCli = await clienteAutenticado(ana);
  const convite = await criarSessao(anaCli, brunoCli);
  await juntarBruno(brunoCli, convite.sessionId, true);

  brunoCli.enviar({
    type: 'session_control', sessionId: convite.sessionId, action: 'pause', positionSec: 5, atMs: 1,
  });
  await erroDe(brunoCli, 'E_NOT_HOST');

  await dormir(250);
  assert.deepStrictEqual(mensagensDe(anaCli, (m) => m.type === 'session_control'), [], 'nada difundido à anfitriã');
  assert.deepStrictEqual(mensagensDe(brunoCli, (m) => m.type === 'session_control'), [], 'nada difundido ao próprio');

  // A ligação mantém-se viva: um segundo envio também é respondido.
  brunoCli.enviar({
    type: 'session_control', sessionId: convite.sessionId, action: 'play', positionSec: 0, atMs: 0,
  });
  await erroDe(brunoCli, 'E_NOT_HOST');

  await Promise.all([fecharCliente(anaCli), fecharCliente(brunoCli)]);
});

// --- 4. membros, não-membros e sessões desconhecidas --------------------------------

test('não-membro → E_FORBIDDEN (join e control); sessão desconhecida → E_NOTFOUND; ligação mantém-se', async () => {
  const brunoCli = await clienteAutenticado(bruno);
  const anaCli = await clienteAutenticado(ana);
  const carlaCli = await clienteAutenticado(carla);
  const evaCli = await clienteAutenticado(eva);
  const convite = await criarSessao(anaCli, brunoCli);

  // carla é amiga da anfitriã mas NÃO foi convidada → não é membro.
  carlaCli.enviar({ type: 'session_join', sessionId: convite.sessionId, fileMatches: true });
  await erroDe(carlaCli, 'E_FORBIDDEN');

  // eva não é amiga nem membro: join → E_FORBIDDEN...
  evaCli.enviar({ type: 'session_join', sessionId: convite.sessionId, fileMatches: true });
  await erroDe(evaCli, 'E_FORBIDDEN');
  // ...e control → E_FORBIDDEN: o gate de membresia vem antes do gate de
  // anfitriã (não-membro → E_FORBIDDEN vale para join/controlar/receber).
  evaCli.enviar({
    type: 'session_control', sessionId: convite.sessionId, action: 'play', positionSec: 0, atMs: 0,
  });
  await erroDe(evaCli, 'E_FORBIDDEN');

  // Sessão desconhecida → E_NOTFOUND, em join e em control.
  brunoCli.enviar({ type: 'session_join', sessionId: 'sessao-inexistente', fileMatches: true });
  await erroDe(brunoCli, 'E_NOTFOUND');
  brunoCli.enviar({
    type: 'session_control', sessionId: 'sessao-inexistente', action: 'play', positionSec: 0, atMs: 0,
  });
  await erroDe(brunoCli, 'E_NOTFOUND');

  assert.strictEqual(evaCli.fechado, null, 'a ligação não foi fechada');
  evaCli.enviar({ type: 'session_join', sessionId: convite.sessionId, fileMatches: true });
  await erroDe(evaCli, 'E_FORBIDDEN'); // um segundo envio também é respondido

  await Promise.all([anaCli, brunoCli, carlaCli, evaCli].map((c) => fecharCliente(c)));
});

// --- 5. session_leave -----------------------------------------------------------------

test('anfitriã sai → session_ended a todos os membros e a sessão é removida do mapa', async () => {
  const brunoCli = await clienteAutenticado(bruno);
  const anaCli = await clienteAutenticado(ana);
  const convite = await criarSessao(anaCli, brunoCli);
  await juntarBruno(brunoCli, convite.sessionId, true);

  const noBruno = esperarNovaMensagem(brunoCli, (m) => m.type === 'session_ended');
  const naAna = esperarNovaMensagem(anaCli, (m) => m.type === 'session_ended');
  anaCli.enviar({ type: 'session_leave' }); // sem sessionId: sai de todas as suas sessões
  const fimBruno = await noBruno;
  assert.deepStrictEqual(fimBruno, { type: 'session_ended', reason: 'host_left' });
  assert.deepStrictEqual(Object.keys(fimBruno).sort(), ['reason', 'type']);
  assert.deepStrictEqual(await naAna, { type: 'session_ended', reason: 'host_left' },
    'a própria anfitriã também recebe (membro)');

  // A sessão deixou de existir no servidor: join → E_NOTFOUND.
  brunoCli.enviar({ type: 'session_join', sessionId: convite.sessionId, fileMatches: true });
  await erroDe(brunoCli, 'E_NOTFOUND');

  await Promise.all([fecharCliente(anaCli), fecharCliente(brunoCli)]);
});

test('convidado que sai é removido em silêncio; a sessão continua e ele não volta a juntar-se (v1)', async () => {
  const brunoCli = await clienteAutenticado(bruno);
  const anaCli = await clienteAutenticado(ana);
  const convite = await criarSessao(anaCli, brunoCli);
  await juntarBruno(brunoCli, convite.sessionId, true);

  brunoCli.enviar({ type: 'session_leave' }); // convidado: sai sem difusão
  await dormir(250);
  assert.deepStrictEqual(mensagensDe(brunoCli, (m) => m.type === 'error'), [], 'saída sem erro');
  assert.deepStrictEqual(mensagensDe(anaCli, (m) => m.type === 'session_ended'), [], 'a sessão NÃO acaba');
  assert.strictEqual(
    mensagensDe(anaCli, (m) => m.type === 'session_member').length, 1,
    'nenhum anúncio novo além do join (o brief não define member_left)',
  );

  // Deixou de ser membro: join de volta → E_FORBIDDEN (v1: só membros podem join).
  brunoCli.enviar({ type: 'session_join', sessionId: convite.sessionId, fileMatches: true });
  await erroDe(brunoCli, 'E_FORBIDDEN');

  // E deixa de receber os controles do anfitrião.
  const naAna = esperarNovaMensagem(anaCli, (m) => m.type === 'session_control');
  anaCli.enviar({
    type: 'session_control', sessionId: convite.sessionId, action: 'pause', positionSec: 0, atMs: 0,
  });
  await naAna;
  await dormir(150);
  assert.deepStrictEqual(mensagensDe(brunoCli, (m) => m.type === 'session_control'), [], 'quem saiu não recebe');

  await Promise.all([fecharCliente(anaCli), fecharCliente(brunoCli)]);
});

// --- 6. modo só-conversa e dup join -----------------------------------------------------

test('session_join com fileMatches:false entra em modo só-conversa e continua a receber controles', async () => {
  const brunoCli = await clienteAutenticado(bruno);
  const anaCli = await clienteAutenticado(ana);
  const convite = await criarSessao(anaCli, brunoCli);

  const anuncio = await juntarBruno(brunoCli, convite.sessionId, false);
  assert.strictEqual(anuncio.fileMatches, false, 'o servidor marca o membro como sem-ficheiro');

  // O membro sem-ficheiro CONTINUA a receber os controles do anfitrião.
  const controle = esperarNovaMensagem(brunoCli, (m) => m.type === 'session_control');
  anaCli.enviar({
    type: 'session_control', sessionId: convite.sessionId, action: 'play', positionSec: 0, atMs: 0,
  });
  assert.strictEqual((await controle).action, 'play', 'o cliente sem ficheiro decide o que fazer');

  await Promise.all([fecharCliente(anaCli), fecharCliente(brunoCli)]);
});

test('dup join do mesmo membro é idempotente: atualiza fileMatches, sem duplicar na lista', async () => {
  const brunoCli = await clienteAutenticado(bruno);
  const anaCli = await clienteAutenticado(ana);
  const convite = await criarSessao(anaCli, brunoCli);

  assert.strictEqual((await juntarBruno(brunoCli, convite.sessionId, true)).fileMatches, true);
  assert.strictEqual(
    (await juntarBruno(brunoCli, convite.sessionId, false)).fileMatches, false,
    'o segundo join ATUALIZA o estado do membro',
  );
  await dormir(150);
  assert.strictEqual(
    mensagensDe(brunoCli, (m) => m.type === 'session_member').length, 2,
    'um anúncio por join — sem entradas duplicadas',
  );

  // Sem duplicação na lista de membros: um controlo chega UMA vez ao membro.
  const controle = esperarNovaMensagem(brunoCli, (m) => m.type === 'session_control');
  anaCli.enviar({
    type: 'session_control', sessionId: convite.sessionId, action: 'seek', positionSec: 30, atMs: 9,
  });
  await controle;
  await dormir(150);
  assert.strictEqual(
    mensagensDe(brunoCli, (m) => m.type === 'session_control').length, 1,
    'o membro continua único na lista (entrega única)',
  );

  await Promise.all([fecharCliente(anaCli), fecharCliente(brunoCli)]);
});

// --- 7. validação e robustez -------------------------------------------------------------

test('campos obrigatórios malformados → E_INVALID; destino mau falha a criação inteira', async () => {
  const brunoCli = await clienteAutenticado(bruno);
  const evaCli = await clienteAutenticado(eva);
  const anaCli = await clienteAutenticado(ana);

  anaCli.enviar({ type: 'session_create', fileName: 'f.mp4', durationSec: 60, toUserIds: [bruno.id] }); // sem title
  anaCli.enviar({ type: 'session_create', title: 't', durationSec: 60, toUserIds: [bruno.id] }); // sem fileName
  anaCli.enviar({ type: 'session_create', title: 't', fileName: 'f.mp4', toUserIds: [bruno.id] }); // sem durationSec
  anaCli.enviar({ type: 'session_create', title: 't', fileName: 'f.mp4', durationSec: '60', toUserIds: [bruno.id] }); // não numérica
  anaCli.enviar({ type: 'session_create', title: 't', fileName: 'f.mp4', durationSec: 60 }); // sem toUserIds
  anaCli.enviar({ type: 'session_create', title: 't', fileName: 'f.mp4', durationSec: 60, toUserIds: [] }); // vazio (R2: ≥1)
  anaCli.enviar({ type: 'session_create', title: 't', fileName: 'f.mp4', durationSec: 60, toUserIds: [eva.id] }); // não-amiga
  anaCli.enviar({ type: 'session_create', title: 't', fileName: 'f.mp4', durationSec: 60, toUserIds: ['00000000-0000-4000-8000-000000000000'] }); // desconhecido
  anaCli.enviar({ type: 'session_join', fileMatches: true }); // sem sessionId
  anaCli.enviar({ type: 'session_join', sessionId: 's-1' }); // sem fileMatches
  anaCli.enviar({ type: 'session_join', sessionId: 's-1', fileMatches: 'sim' }); // não boolean
  anaCli.enviar({ type: 'session_control', sessionId: 's-1', action: 'skip', positionSec: 0, atMs: 0 }); // action fora
  anaCli.enviar({ type: 'session_control', sessionId: 's-1', action: 'play', atMs: 0 }); // sem positionSec
  anaCli.enviar({ type: 'session_control', sessionId: 's-1', action: 'play', positionSec: 0 }); // sem atMs

  await dormir(400);
  assert.deepStrictEqual(
    mensagensDe(anaCli, (m) => m.type === 'error').map((m) => m.code),
    [
      'E_INVALID', 'E_INVALID', 'E_INVALID', 'E_INVALID', 'E_INVALID', 'E_INVALID',
      'E_FORBIDDEN', // destino não-amigo (eva)
      'E_NOTFOUND', // destino desconhecido
      'E_INVALID', 'E_INVALID', 'E_INVALID', // joins maus
      'E_INVALID', 'E_INVALID', 'E_INVALID', // controles maus
    ],
    'os erros seguem a ordem e o código previstos',
  );

  // Um destino mau falha o pedido INTEIRO: sem sessão criada, sem convite parcial (regra da T7).
  anaCli.enviar({
    type: 'session_create', title: 't', fileName: 'parcial.mp4',
    durationSec: 60, toUserIds: [bruno.id, eva.id],
  });
  await erroDe(anaCli, 'E_FORBIDDEN');
  await dormir(150);
  assert.deepStrictEqual(
    mensagensDe(brunoCli, (m) => m.type === 'session_invite' && m.fileName === 'parcial.mp4'),
    [], 'o convidado válido NÃO recebe convite quando outro destino falha',
  );

  await Promise.all([fecharCliente(anaCli), fecharCliente(brunoCli), fecharCliente(evaCli)]);
});

test('tipo de sessão desconhecido continua E_UNKNOWN_TYPE (handlers não capturam o resto)', async () => {
  const anaCli = await clienteAutenticado(ana);

  anaCli.enviar({ type: 'session_xpto', sessionId: 'x' });
  await erroDe(anaCli, 'E_UNKNOWN_TYPE');

  await fecharCliente(anaCli);
});
