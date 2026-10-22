'use strict';

const crypto = require('node:crypto');

/**
 * Sessões de Filme — Machine Video Social (Task 8).
 *
 * Sincronia ANFITRIÃO-AUTORITATIVA com estado NO SERVIDOR (diferente do relay
 * puro da Task 7): o servidor mantém as sessões ativas em memória —
 *   sessionId → { hostUserId, members, title, fileName, durationSec,
 *                 lastControl }
 * — e o mapa morre com o processo (estado transitório, v1). Isto nunca é
 * vídeo: apenas metadados de controlo, pelo que não toca no anti-objetivo.
 *
 * Membros (decisão do controller, derivada do estado prescrito): no momento
 * da criação a sessão fica com o anfitrião + TODOS os convidados. O estado
 * prescrito não tem lista separada de "convidados" e a regra do modo
 * só-conversa ("continua a entregar controles") implica que os convidados já
 * recebem envelopes da sessão ANTES de fazer join. Por isso:
 *   - `session_join` não muda a composição — anuncia/atualiza o estado
 *     `fileMatches` do membro (dup join é idempotente);
 *   - `session_leave` de convidado remove-o em silêncio (e, como só membros
 *     podem join, ele não volta a juntar-se nesta v1);
 *   - só o anfitrião acaba a sessão ({type:"session_ended",
 *     reason:"host_left"} a todos os membros; sessão removida do mapa).
 *
 * WS (pós-auth; registado pelo hub em src/ws.js via handleEnvelope):
 *   C→S {type:"session_create", title, fileName, durationSec, toUserIds[]}
 *     → (R2: "mín. 2 amigos convidados" = ≥1 convidado; a sessão fica com
 *        ≥2 pessoas — anfitrião + convidados) cada convidado ONLINE recebe
 *        {type:"session_invite", sessionId, fromName, title, fileName,
 *        durationSec}. TODOS os destinos são validados ANTES de criar a
 *        sessão e de entregar (desconhecido → E_NOTFOUND; não-amigo →
 *        E_FORBIDDEN; um destino mau falha o pedido inteiro, sem convite
 *        parcial). Convidado offline fica sem entrega e sem erro
 *        (best-effort, sem fila de convites na v1). O ANFITRIÃO recebe ainda
 *        {type:"session_created", sessionId, title, fileName, durationSec}
 *        (R9 do controller — aditivo ao brief, precedido do call_ack da
 *        Task 7): é assim que a cliente anfitriã fica a saber o sessionId
 *        para poder enviar session_control.
 *   C→S {type:"session_join", sessionId, fileMatches:bool}
 *     → {type:"session_member", sessionId, userId, username, fileMatches} a
 *       TODOS os membros — o próprio incluído (uma entrega, como no eco do
 *       chat). fileMatches:false → modo "só conversa": o servidor marca o
 *       membro como sem-ficheiro e CONTINUA a entregar os controles (o
 *       cliente decide o que fazer com eles); o estado existe para informar
 *       os membros.
 *   C→S {type:"session_control", sessionId, action:"play"|"pause"|"seek",
 *        positionSec, atMs} — aceito APENAS do anfitrião atual
 *     → {type:"session_control", sessionId, action, positionSec, atMs} a
 *       TODOS os membros (a anfitriã incluída — multi-aba); o último controlo
 *       fica em `lastControl` (metadado de estado da v1, sem rota de entrega
 *       definida no brief). Membro não-anfitrião → E_NOT_HOST e NADA é
 *       difundido (Review Focus 4). Não-membro → E_FORBIDDEN (o gate de
 *       membresia vem primeiro: "não-membro → E_FORBIDDEN" aplica-se a
 *       join/controlar/receber; E_NOT_HOST distingue só o membro comum).
 *   C→S {type:"session_leave"} — o brief não traz sessionId; opcionalmente
 *       aceita {sessionId} para sair de UMA sessão (com E_NOTFOUND/
 *       E_FORBIDDEN como nos outros tipos). Sem sessionId sai de TODAS as
 *       sessões do utilizador (nenhuma → no-op silencioso).
 *     → anfitrião: {type:"session_ended", reason:"host_left"} a TODOS os
 *       membros (ele incluído) e a sessão é removida do mapa; convidado:
 *       removido em silêncio (o brief não define anúncio de saída de membro).
 *
 * Erros (envelope {type:"error", code}, sem fechar a ligação):
 *   E_INVALID   - campos obrigatórios malformados (antes da consulta ao
 *                 estado, como no relay da Task 7)
 *   E_NOTFOUND  - sessionId desconhecido; destino desconhecido na criação
 *   E_FORBIDDEN - destino não-amigo; remetente não-membro
 *   E_NOT_HOST  - membro não-anfitrião em session_control
 *   E_INTERNAL  - falha inesperada do handler (rede de segurança)
 *
 * Notas:
 *   - membership NÃO depende de sockets (v1): um membro que fecha a ligação
 *     continua membro; a entrega é sempre best-effort (enviarPara/
 *     enviarDireto com readyState + try/catch);
 *   - o ANFITRIÃO recebe {type:"session_created", sessionId, title,
 *     fileName, durationSec} no sucesso do create (R9 do controller;
 *     aditivo ao brief, mesmo precedente do call_ack da Task 7) — sem ele a
 *     cliente anfitriã não conseguiria enviar session_control;
 *   - validação na fronteira: title/fileName strings, durationSec/positionSec/
 *     atMs números finitos, fileMatches booleano.
 */

const ACOES_CONTROLE = new Set(['play', 'pause', 'seek']);

/**
 * @param {object} entrada
 * @param {object} entrada.store - implementação do contrato src/store.js
 * @param {Function} entrada.enviarDireto - (ws, envelope) envio a 1 socket
 * @param {Function} entrada.enviarPara - (userId, envelope) envio a todas as
 *   abas do utilizador (best-effort)
 */
function createSessionHandlers({ store, enviarDireto, enviarPara }) {
  /** @type {Map<string, object>} sessionId → sessão ativa (transitória) */
  const sessoesAtivas = new Map();

  /** Erro previsto ao socket; a ligação mantém-se viva. */
  function erro(ws, code) {
    enviarDireto(ws, { type: 'error', code });
  }

  /** Identificador válido: string não vazia. */
  function idValido(id) {
    return typeof id === 'string' && id.length > 0;
  }

  /** Lista de convidados válida: array não vazio de strings não vazias. */
  function convidadosValidos(toUserIds) {
    return (
      Array.isArray(toUserIds) &&
      toUserIds.length > 0 &&
      toUserIds.every((id) => typeof id === 'string' && id.length > 0)
    );
  }

  /** Número finito (durationSec, positionSec, atMs). */
  function numeroFinito(valor) {
    return typeof valor === 'number' && Number.isFinite(valor);
  }

  /**
   * Valida existência e amizade de TODOS os convidados antes de qualquer
   * entrega (mesma ordem do relay da Task 7: E_NOTFOUND primeiro).
   * Assíncrono porque a store pode ser a de Postgres (Task 11).
   * @returns {Promise<string[] | null>} convidados deduplicados, ou null se
   *   já respondeu erro
   */
  async function validarConvidados(ws, user, toUserIds) {
    const convidados = [...new Set(toUserIds)];
    for (const destino of convidados) {
      if (!(await store.getUserById(destino))) {
        erro(ws, 'E_NOTFOUND');
        return null;
      }
      if (!(await store.areFriends(user.id, destino))) {
        erro(ws, 'E_FORBIDDEN');
        return null;
      }
    }
    return convidados;
  }

  /** Envia um envelope a TODOS os membros (uma entrega por membro, multi-aba). */
  function difundir(sessao, envelope) {
    for (const membro of sessao.members.keys()) {
      enviarPara(membro, envelope);
    }
  }

  // --- session_create ---------------------------------------------------------

  async function tratarCriacao(envelope, user, ws) {
    const { title, fileName, durationSec, toUserIds, movieUrl } = envelope;
    if (
      typeof title !== 'string' ||
      typeof fileName !== 'string' ||
      !numeroFinito(durationSec) ||
      !convidadosValidos(toUserIds)
    ) {
      erro(ws, 'E_INVALID');
      return;
    }
    // v1.1 — link direto do filme (opcional): http(s) público, ≤2048 chars.
    let urlFilme = null;
    if (movieUrl !== undefined && movieUrl !== null) {
      if (typeof movieUrl !== 'string' || movieUrl.length > 2048) {
        erro(ws, 'E_INVALID');
        return;
      }
      try {
        const u = new URL(movieUrl);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          erro(ws, 'E_INVALID');
          return;
        }
        urlFilme = movieUrl;
      } catch {
        erro(ws, 'E_INVALID');
        return;
      }
    }
    const convidados = await validarConvidados(ws, user, toUserIds);
    if (!convidados) return;

    const sessionId = crypto.randomUUID();
    // Membros = anfitriã (tem o ficheiro) + convidados (sem-ficheiro até
    // atualizarem o estado no session_join).
    const members = new Map([[user.id, { fileMatches: true }]]);
    for (const convidado of convidados) {
      members.set(convidado, { fileMatches: false });
    }
    sessoesAtivas.set(sessionId, {
      hostUserId: user.id,
      members,
      title,
      fileName,
      durationSec,
      movieUrl: urlFilme,
      lastControl: null,
    });

    const convite = {
      type: 'session_invite',
      sessionId,
      fromName: user.username,
      title,
      fileName,
      durationSec,
      ...(urlFilme ? { movieUrl: urlFilme } : {}),
    };
    for (const convidado of convidados) {
      enviarPara(convidado, convite); // best-effort: offline fica sem convite
    }
    // R9: ack ao ANFITRIÃO — o mesmo id gerado, para poder controlar a sessão.
    enviarDireto(ws, {
      type: 'session_created', sessionId, title, fileName, durationSec,
      ...(urlFilme ? { movieUrl: urlFilme } : {}),
    });
  }

  // --- session_join -----------------------------------------------------------

  function tratarJoin(envelope, user, ws) {
    const { sessionId, fileMatches } = envelope;
    if (!idValido(sessionId) || typeof fileMatches !== 'boolean') {
      erro(ws, 'E_INVALID');
      return;
    }
    const sessao = sessoesAtivas.get(sessionId);
    if (!sessao) {
      erro(ws, 'E_NOTFOUND');
      return;
    }
    if (!sessao.members.has(user.id)) {
      erro(ws, 'E_FORBIDDEN');
      return;
    }
    // Idempotente: o Map garante um único membro; o re-join atualiza o
    // estado fileMatches (a lista não cresce).
    sessao.members.set(user.id, { fileMatches });

    difundir(sessao, {
      type: 'session_member',
      sessionId,
      userId: user.id,
      username: user.username,
      fileMatches,
    });
  }

  // --- session_control ----------------------------------------------------------

  function tratarControle(envelope, user, ws) {
    const { sessionId, action, positionSec, atMs } = envelope;
    if (
      !idValido(sessionId) ||
      !ACOES_CONTROLE.has(action) ||
      !numeroFinito(positionSec) ||
      !numeroFinito(atMs)
    ) {
      erro(ws, 'E_INVALID');
      return;
    }
    const sessao = sessoesAtivas.get(sessionId);
    if (!sessao) {
      erro(ws, 'E_NOTFOUND');
      return;
    }
    if (!sessao.members.has(user.id)) {
      erro(ws, 'E_FORBIDDEN'); // gate de membresia antes do gate de anfitriã
      return;
    }
    if (sessao.hostUserId !== user.id) {
      erro(ws, 'E_NOT_HOST'); // Review Focus 4: NADA é difundido
      return;
    }
    const controle = {
      type: 'session_control',
      sessionId,
      action,
      positionSec,
      atMs,
    };
    sessao.lastControl = controle;
    difundir(sessao, controle); // a anfitriã também recebe (multi-aba)
  }

  // --- session_leave ------------------------------------------------------------

  /**
   * Sai de uma sessão: o anfitrião acaba a sessão (session_ended a todos os
   * membros e remoção do mapa — limpeza de estado); o convidado é removido
   * em silêncio.
   */
  function sairDeSessao(sessionId, sessao, user) {
    if (sessao.hostUserId !== user.id) {
      sessao.members.delete(user.id);
      return;
    }
    difundir(sessao, { type: 'session_ended', reason: 'host_left' });
    sessoesAtivas.delete(sessionId);
  }

  function tratarSaida(envelope, user, ws) {
    const sessionId = envelope.sessionId;
    if (sessionId !== undefined) {
      if (!idValido(sessionId)) {
        erro(ws, 'E_INVALID');
        return;
      }
      const sessao = sessoesAtivas.get(sessionId);
      if (!sessao) {
        erro(ws, 'E_NOTFOUND');
        return;
      }
      if (!sessao.members.has(user.id)) {
        erro(ws, 'E_FORBIDDEN');
        return;
      }
      sairDeSessao(sessionId, sessao, user);
      return;
    }
    // Forma do brief (sem sessionId): sai de TODAS as sessões do utilizador.
    // Snapshot: sairDeSessao pode remover entradas durante a iteração.
    for (const [id, sessao] of [...sessoesAtivas]) {
      if (sessao.members.has(user.id)) sairDeSessao(id, sessao, user);
    }
    // Em nenhuma sessão: no-op silencioso (nada a sair).
  }

  /** Rede de segurança: um handler nunca derruba o hub (espelho do ws.js). */
  async function comRedeSeguranca(fn, ws) {
    try {
      await fn();
      return true;
    } catch {
      erro(ws, 'E_INTERNAL');
      return true;
    }
  }

  /**
   * Trata um envelope pós-auth de sessões. Devolve true se o tipo pertence à
   * sessão (tratado, com sucesso ou com erro); false deixa o hub responder
   * E_UNKNOWN_TYPE. Nunca lança.
   */
  async function handleEnvelope(envelope, user, ws) {
    if (!envelope || typeof envelope !== 'object') return false;
    switch (envelope.type) {
      case 'session_create':
        return comRedeSeguranca(() => tratarCriacao(envelope, user, ws), ws);
      case 'session_join':
        return comRedeSeguranca(() => tratarJoin(envelope, user, ws), ws);
      case 'session_control':
        return comRedeSeguranca(() => tratarControle(envelope, user, ws), ws);
      case 'session_leave':
        return comRedeSeguranca(() => tratarSaida(envelope, user, ws), ws);
      default:
        return false;
    }
  }

  return { handleEnvelope };
}

module.exports = { createSessionHandlers };
