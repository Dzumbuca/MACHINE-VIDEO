'use strict';

const { utilizadorPublico } = require('./http-util');
const { criarPresenca } = require('./presence');
const { createChatHandlers } = require('./chat');
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

function criarHub({ store, wss, authTimeoutMs = TEMPO_LIMITE_AUTH_MS_PADRAO }) {
  const presenca = criarPresenca({ store });

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
  }

  /** Difunde a presença do utilizador afetado — e só aos amigos dele. */
  function anunciarPresenca(userId, online) {
    const envelope = { type: 'presence', userId, online: Boolean(online) };
    for (const destino of presenca.destinosPresenca(userId)) {
      enviarPara(destino, envelope);
    }
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

    ws.on('message', (dados) => {
      let envelope;
      try {
        envelope = JSON.parse(dados.toString());
      } catch {
        enviarDireto(ws, { type: 'error', code: 'E_BADJSON' });
        if (!estado.autenticado) fechar(ws); // sem auth não há segunda hipótese
        return;
      }

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
          user = store.getUserByToken(token);
        } catch {
          user = null; // store indisponível trata-se como token inválido
        }
        if (!user) {
          fechar(ws); // token inválido → fechado, sem resposta
          return;
        }
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
          chat.handleEnvelope(envelope, estado.user, ws) ||
          sinal.handleEnvelope(envelope, estado.user, ws) ||
          sessoes.handleEnvelope(envelope, estado.user, ws);
      } catch {
        // O handler não devia lançar; se lançar, o processo não pode morrer.
        tratado = true;
        enviarDireto(ws, { type: 'error', code: 'E_INTERNAL' });
      }
      if (!tratado) {
        enviarDireto(ws, { type: 'error', code: 'E_UNKNOWN_TYPE' });
      }
    });
  });

  // Erros do próprio servidor WebSocket (upgrade, etc.) não derrubam o processo.
  wss.on('error', () => {});
}

module.exports = { criarHub };
