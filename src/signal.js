'use strict';

/**
 * Sinalização WebRTC — Machine Video Social (Task 7).
 *
 * Relay PURO e SEM ESTADO: o servidor não guarda nada sobre as chamadas
 * (nem callIds, nem participantes, nem SDP/ICE). Cada envelope é validado
 * apenas no que é preciso para o encaminhamento e depois retransmitido.
 *
 * WS (pós-auth; registado pelo hub em src/ws.js via handleEnvelope):
 *   C→S {type:"call_invite", callId, toUserIds[], media}
 *     → cada destino ONLINE recebe {type:"call_incoming", callId, fromUserId,
 *       fromName, media} em todas as abas, e a origem recebe o ACK
 *       {type:"call_ack", callId, delivered:[userIds], missed:[userIds]}
 *       (adição do controller ao brief: o cliente UI usa delivered/missed
 *       para a lógica de "chamada perdida"; a v1 NÃO guarda convites —
 *       amigo offline vai para missed, sem erro).
 *   C→S {type:"call_signal", callId, toUserId, data}
 *     → o destino recebe {type:"call_signal", callId, fromUserId, data},
 *       com `data` INTACTO — o relay é dumb: nunca lê nem valida o conteúdo
 *       (offer/answer/ICE são opacos); qualquer valor JSON segue tal como
 *       chegou, incl. ausente.
 *   C→S {type:"call_end", callId, toUserIds}
 *     → cada destino recebe {type:"call_end", callId, fromUserId}. A v1
 *       EXIGE toUserIds: sem estado no servidor não há "participantes" a
 *       derivar (decisão do controller — o enunciado traz toUserIds?).
 *
 * Erros (envelope {type:"error", code}, sem fechar a ligação):
 *   E_INVALID   - callId/toUserIds/toUserId malformados (não dá p/ encaminhar)
 *   E_NOTFOUND  - destino desconhecido; em call_signal, destino sem socket
 *   E_FORBIDDEN - destino que não é amigo (regra do brief: apenas amigos).
 *                 QUALQUER destino mau falha o pedido INTEIRO, avaliado
 *                 ANTES de qualquer entrega (nunca entrega parcial); o
 *                 remetente incluído em toUserIds também falha (não é amigo
 *                 de si — store.areFriends(a,a) é falso).
 *   E_INTERNAL  - falha inesperada da store ou do handler (rede de segurança)
 *
 * Notas:
 *   - a amizade é confirmada com store.areFriends antes de retransmitir,
 *     também em call_signal e call_end — barato e impede abuso do relay;
 *   - destino desconhecido é avaliado antes da amizade (E_NOTFOUND primeiro);
 *   - `media` (call_invite) e `data` (call_signal) são opacos e seguem sem
 *     validação — o servidor só toca nos campos de encaminhamento;
 *   - destinos duplicados são deduplicados (uma entrega, uma entrada no ack);
 *   - em call_end, destino offline fica sem entrega e sem erro (best-effort):
 *     terminar uma chamada não precisa de confirmar que o par estava ligado;
 *   - o ACK de call_invite usa o mapa de presença (sockets) para separar
 *     delivered/missed; a entrega em si continua best-effort via enviarPara.
 */

/**
 * @param {object} entrada
 * @param {object} entrada.store - implementação do contrato src/store.js
 * @param {Function} entrada.enviarDireto - (ws, envelope) envio a 1 socket
 * @param {Function} entrada.enviarPara - (userId, envelope) envio a todas as
 *   abas do utilizador (best-effort)
 * @param {Function} entrada.sockets - (userId) → sockets autenticados
 *   (snapshot da presença do hub, src/presence.js)
 */
function createSignalHandlers({ store, enviarDireto, enviarPara, sockets }) {
  /** Erro previsto ao socket; a ligação mantém-se viva. */
  function erro(ws, code) {
    enviarDireto(ws, { type: 'error', code });
  }

  /** callId válido: string não vazia (identificador que o relay ecoa). */
  function callIdValido(callId) {
    return typeof callId === 'string' && callId.length > 0;
  }

  /** Lista de destinos válida: array não vazio de strings não vazias. */
  function destinosValidos(toUserIds) {
    return (
      Array.isArray(toUserIds) &&
      toUserIds.length > 0 &&
      toUserIds.every((id) => typeof id === 'string' && id.length > 0)
    );
  }

  /**
   * Valida TODOS os destinos (existência e amizade) antes de qualquer
   * entrega — um destino mau responde o erro e devolve null, sem entrega
   * parcial. Devolve a lista deduplicada, pela ordem recebida.
   * @returns {string[] | null} destinos válidos, ou null se já respondeu erro
   */
  function validarDestinos(ws, user, toUserIds) {
    const destinos = [...new Set(toUserIds)];
    for (const destino of destinos) {
      if (!store.getUserById(destino)) {
        erro(ws, 'E_NOTFOUND');
        return null;
      }
      if (!store.areFriends(user.id, destino)) {
        erro(ws, 'E_FORBIDDEN');
        return null;
      }
    }
    return destinos;
  }

  // --- call_invite ----------------------------------------------------------

  function tratarInvite(envelope, user, ws) {
    if (!callIdValido(envelope.callId) || !destinosValidos(envelope.toUserIds)) {
      erro(ws, 'E_INVALID');
      return true;
    }
    const destinos = validarDestinos(ws, user, envelope.toUserIds);
    if (!destinos) return true;

    const incoming = {
      type: 'call_incoming',
      callId: envelope.callId,
      fromUserId: user.id,
      fromName: user.username,
      media: envelope.media, // opaco: retransmitido tal como chegou
    };

    const delivered = [];
    const missed = [];
    for (const destino of destinos) {
      if (sockets(destino).length > 0) {
        enviarPara(destino, incoming);
        delivered.push(destino);
      } else {
        missed.push(destino); // v1 não guarda convites: offline → missed
      }
    }

    // ACK (adição do controller): a origem sabe a quem o convite chegou e
    // quem ficou como "chamada perdida".
    enviarDireto(ws, {
      type: 'call_ack',
      callId: envelope.callId,
      delivered,
      missed,
    });
    return true;
  }

  // --- call_signal ----------------------------------------------------------

  function tratarSinal(envelope, user, ws) {
    const toUserId = envelope.toUserId;
    if (
      !callIdValido(envelope.callId) ||
      typeof toUserId !== 'string' ||
      toUserId.length === 0
    ) {
      erro(ws, 'E_INVALID');
      return true;
    }
    if (!validarDestinos(ws, user, [toUserId])) return true;

    // Amigo mas sem socket → E_NOTFOUND (decisão do controller): em
    // call_signal o destino ausente é erro, o cliente precisa de saber que a
    // mensagem não chegou.
    if (sockets(toUserId).length === 0) {
      erro(ws, 'E_NOTFOUND');
      return true;
    }

    // Relay dumb: `data` nunca é lido nem validado — segue intacto.
    enviarPara(toUserId, {
      type: 'call_signal',
      callId: envelope.callId,
      fromUserId: user.id,
      data: envelope.data,
    });
    return true;
  }

  // --- call_end -------------------------------------------------------------

  function tratarFim(envelope, user, ws) {
    if (!callIdValido(envelope.callId) || !destinosValidos(envelope.toUserIds)) {
      erro(ws, 'E_INVALID');
      return true;
    }
    const destinos = validarDestinos(ws, user, envelope.toUserIds);
    if (!destinos) return true;

    const fim = {
      type: 'call_end',
      callId: envelope.callId,
      fromUserId: user.id,
    };
    // Best-effort: destino offline fica sem entrega e sem erro.
    for (const destino of destinos) {
      enviarPara(destino, fim);
    }
    return true;
  }

  /** Rede de segurança: um handler nunca derruba o hub (espelho do ws.js). */
  function comRedeSeguranca(fn, ws) {
    try {
      return fn();
    } catch {
      erro(ws, 'E_INTERNAL');
      return true;
    }
  }

  /**
   * Trata um envelope pós-auth de sinalização. Devolve true se o tipo
   * pertence ao signal (tratado, com sucesso ou com erro); false deixa o hub
   * responder E_UNKNOWN_TYPE. Nunca lança.
   */
  function handleEnvelope(envelope, user, ws) {
    if (!envelope || typeof envelope !== 'object') return false;
    switch (envelope.type) {
      case 'call_invite':
        return comRedeSeguranca(() => tratarInvite(envelope, user, ws), ws);
      case 'call_signal':
        return comRedeSeguranca(() => tratarSinal(envelope, user, ws), ws);
      case 'call_end':
        return comRedeSeguranca(() => tratarFim(envelope, user, ws), ws);
      default:
        return false;
    }
  }

  return { handleEnvelope };
}

module.exports = { createSignalHandlers };
