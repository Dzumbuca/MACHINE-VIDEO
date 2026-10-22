'use strict';

const { utilizadorPublico } = require('./http-util');
const { criarPresenca } = require('./presence');
const { createChatHandlers } = require('./chat');
const { criarRele } = require('./relay');
const { createSignalHandlers } = require('./signal');
const { createSessionHandlers } = require('./session');

/**
 * Hub WebSocket — Machine Video Social (Task 5).
 *
 * Máquina de estados por ligação:
 *   ligada → "à espera de auth" (fecha após 5 s sem auth) → "autenticada" → fechada
 *
 * Envelopes JSON, com os tipos exatos do enunciado:
 *   C→S {type:"auth", token}
 *     → S→C {type:"auth_ok", user:{id,username}}      token válido
 *     → ligação fechada, sem resposta                 token mau/inexistente
 *   S→C {type:"presence", userId, online:bool}        difundido aos amigos,
 *                                                     na 1.ª ligação (online) e
 *                                                     na última (offline)
 *   frame não-JSON → S→C {type:"error", code:"E_BADJSON"}
 *       socket autenticado mantém-se vivo; socket sem auth é fechado em seguida
 *   pós-auth: os tipos registados pelas tarefas seguintes são tratados por
 *       handlers próprios (Task 6: chat — src/chat.js; Task 7: sinalização
 *       WebRTC — src/signal.js; Task 8: sessões de filme — src/session.js)
 *   tipo desconhecido (autenticado) → {type:"error", code:"E_UNKNOWN_TYPE"},
 *       sem fechar (Review Focus: os tipos novos chegam nas Tasks 6–8)
 *   outro tipo antes de autenticar → ligação fechada (Review Focus 2)
 *
 * Notas:
 *   - A autenticação é SEMPRE o primeiro envelope {type:"auth", token} — nunca
 *     o cabeçalho HTTP Bearer (`exigirSessao` é específico do HTTP e não se
 *     aplica aqui); a validação usa `store.getUserByToken` diretamente.
 *   - O mapa multi-aba `userId → Set<socket>` vive em src/presence.js.
 *   - 'auth' num socket já autenticado não re-autentica: é tratado como tipo
 *     desconhecido (responde E_UNKNOWN_TYPE e mantém a ligação).
 */

const TEMPO_LIMITE_AUTH_MS_PADRAO = 5000;

function criarHub({ store, wss, authTimeoutMs = TEMPO_LIMITE_AUTH_MS_PADRAO, rele: opcoesRele = null }) {
  const presenca = criarPresenca({ store });

  // Ponte de tempo real (v1.1): com DATABASE_URL, os envelopes dirigidos a
  // um utilizador atravessam servidores via pg_notify — o Render e o PC
  // tornam-se UMA rede (ver src/relay.js).
  let rele = null;
  if (opcoesRele?.connectionString) {
    rele = criarRele({
      connectionString: opcoesRele.connectionString,
      aoReceber: (dados) => {
        // Entrega LOCAL da ponte — sem re-publicar (o `origem` da ponte
        // evita que o servidor de origem receba o seu próprio envelope).
        for (const ws of presenca.sockets(dados.userId)) {
          enviarDireto(ws, dados.envelope);
        }
      },
    });
  }

  /** Envia um envelope JSON a um único socket, sem nunca lançar. */
  function enviarDireto(ws, envelope) {
    try {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(envelope));
    } catch {
      // socket a morrer a meio do envio — o handler de 'close' trata do resto
    }
  }

  /** Envia um envelope a todos os sockets autenticados do utilizador. */
  function enviarPara(userId, envelope) {
    for (const ws of presenca.sockets(userId)) {
      enviarDireto(ws, envelope);
    }
    rele?.publicar({ userId, envelope }); // atravessa servidores (v1.1)
  }

  /**
   * Difunde a presença do utilizador afetado — e só aos amigos dele.
   *
   * Os anúncios do MESMO utilizador são SERIALIZADOS (cadeia de promises por
   * userId): com a store-pg assíncrona, um anúncio "online" (auth) e um
   * "offline" (fecho imediato / reconexão) sobrepostos podiam completar fora
   * de ordem e os amigos ficariam com o estado antigo. Serializados, o último
   * anúncio entregue reflete sempre o estado MAIS RECENTE. Nunca lança — os
   * destinos vêm de destinosPresenca (que engole falhas da store) e a cadeia
   * engole o resto; presença é best-effort e não bloqueia os envelopes.
   *
   * @returns {Promise<void>} promise do anúncio (fire-and-forget nos call sites)
   */
  const cadeiasPresenca = new Map(); // userId → último anúncio em curso

  async function difundirPresenca(userId, online) {
    const envelope = { type: 'presence', userId, online: Boolean(online) };
    for (const destino of await presenca.destinosPresenca(userId)) {
      enviarPara(destino, envelope);
    }
  }

  function anunciarPresenca(userId, online) {
    const anterior = cadeiasPresenca.get(userId) ?? Promise.resolve();
    const proxima = anterior.then(() => difundirPresenca(userId, online)).catch(() => {});
    cadeiasPresenca.set(userId, proxima);
    // Libertar a entrada quando este for o último anúncio da cadeia do user.
    proxima.then(() => {
      if (cadeiasPresenca.get(userId) === proxima) cadeiasPresenca.delete(userId);
    });
    return proxima;
  }

  // Handlers pós-auth registados pelas tarefas seguintes. Task 6: o chat
  // reutiliza enviarDireto/enviarPara (best-effort, readyState + try/catch).
  const chat = createChatHandlers({ store, enviarDireto, enviarPara });

  // Task 7: a sinalização WebRTC é relay puro e sem estado — usa os mesmos
  // helpers de envio e o mapa de presença (sockets) para separar
  // delivered/missed no ack de call_invite.
  const sinal = createSignalHandlers({
    store,
    enviarDireto,
    enviarPara,
    sockets: presenca.sockets,
  });

  // Task 8: as sessões de filme mantêm estado NO servidor (anfitrião-
  // autoritativa) e usam os mesmos helpers de envio best-effort.
  const sessoes = createSessionHandlers({ store, enviarDireto, enviarPara });

  /** Fecha com o handshake de fecho; nunca lança se já estiver a fechar. */
  function fechar(ws) {
    try {
      ws.close();
    } catch {
      // já em fecho ou socket morto — nada a fazer
    }
  }

  wss.on('connection', (ws) => {
    const estado = { autenticado: false, user: null };

    // Sem handler de 'error', um erro de socket termina o processo — evitar.
    ws.on('error', () => {});

    // Tempo-limite de autenticação: sem auth bem-sucedida, fecha a ligação.
    const temporizador = setTimeout(() => {
      if (!estado.autenticado) fechar(ws);
    }, authTimeoutMs);

    ws.on('close', () => {
      clearTimeout(temporizador);
      if (!estado.autenticado || !estado.user) return;
      const eraUltima = presenca.remover(estado.user.id, ws);
      if (eraUltima) anunciarPresenca(estado.user.id, false);
    });

    // Envelopes do MESMO socket são tratados EM SÉRIE, pela ordem de chegada:
    // com a store-pg (assíncrona, Task 11), tratar em paralelo podia trocar a
    // ordem das respostas/efeitos que o cliente vê para os seus próprios
    // pedidos. A store em memória mantém o comportamento síncrono anterior.
    let cadeia = Promise.resolve();

    /** Trata um envelope já parseado — auth ou um tipo pós-auth. */
    async function tratarEnvelope(envelope) {
      if (!estado.autenticado) {
        // Só {type:"auth", token} mantém a ligação viva; qualquer outro
        // envelope (ou payload malformado) fecha-a em silêncio.
        const objeto = envelope && typeof envelope === 'object';
        const tipo = objeto ? envelope.type : null;
        const token = objeto ? envelope.token : null;
        if (tipo !== 'auth' || typeof token !== 'string') {
          fechar(ws);
          return;
        }
        let user = null;
        try {
          user = await store.getUserByToken(token);
        } catch {
          user = null; // store indisponível trata-se como token inválido
        }
        if (!user) {
          fechar(ws); // token inválido → fechado, sem resposta
          return;
        }
        if (ws.readyState !== ws.OPEN) return; // fechou entretanto
        estado.autenticado = true;
        estado.user = user;
        clearTimeout(temporizador);
        enviarDireto(ws, { type: 'auth_ok', user: utilizadorPublico(user) });
        if (presenca.adicionar(user.id, ws)) anunciarPresenca(user.id, true);
        return;
      }

      // Autenticado: os tipos registados pelas tarefas seguintes são tratados
      // pelos handlers próprios (Task 6: chat; Task 7: sinalização WebRTC;
      // Task 8: sessões de filme). O resto é desconhecido — responde com
      // erro SEM fechar ('auth' nunca re-autentica).
      let tratado = false;
      try {
        tratado =
          (await chat.handleEnvelope(envelope, estado.user, ws)) ||
          (await sinal.handleEnvelope(envelope, estado.user, ws)) ||
          (await sessoes.handleEnvelope(envelope, estado.user, ws));
      } catch {
        // O handler não devia lançar; se lançar, o processo não pode morrer.
        tratado = true;
        enviarDireto(ws, { type: 'error', code: 'E_INTERNAL' });
      }
      if (!tratado) {
        enviarDireto(ws, { type: 'error', code: 'E_UNKNOWN_TYPE' });
      }
    }

    ws.on('message', (dados) => {
      let envelope;
      try {
        envelope = JSON.parse(dados.toString());
      } catch {
        enviarDireto(ws, { type: 'error', code: 'E_BADJSON' });
        if (!estado.autenticado) fechar(ws); // sem auth não há segunda hipótese
        return;
      }
      cadeia = cadeia
        .then(() => tratarEnvelope(envelope))
        .catch(() => {
          // Última rede de segurança: nenhum erro de tratamento pode matar
          // a cadeia (nem os envelopes seguintes deste socket).
          enviarDireto(ws, { type: 'error', code: 'E_INTERNAL' });
        });
    });
  });

  // Erros do próprio servidor WebSocket (upgrade, etc.) não derrubam o processo.
  wss.on('error', () => {});

  return { rele }; // o encerramento gracioso (server.js) usa rele.parar()
}

module.exports = { criarHub };
