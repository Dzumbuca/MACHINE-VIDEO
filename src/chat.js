'use strict';

const { StoreError } = require('./store');
const {
  exigirSessao,
  falha,
  lerCorpoJson,
  match: matchHandler,
} = require('./http-util');

/**
 * Chat 1:1 e grupos — Machine Video Social (Task 6).
 *
 * REST (corpo sempre JSON; o router é src/routes.js):
 *   GET  /api/conversations                              (Bearer) → { conversations }
 *   POST /api/conversations {memberIds[], title?}                 → 201 { conversationId }
 *   GET  /api/conversations/:id/messages?limit=&before=           → { messages }
 *
 * WS (pós-auth; registado pelo hub em src/ws.js via handleEnvelope):
 *   C→S {type:"chat_send", conversationId, text}
 *     → grava na store e entrega {type:"chat_message", conversationId,
 *       fromUserId, fromName, text, ts} a todos os membros online — todas as
 *       abas de cada destinatário, EXCLUINDO os sockets do remetente. O
 *       remetente recebe o envelope UMA vez, como eco da sua própria ação
 *       (sem dupla entrega).
 *   não-membro (ou conversa desconhecida) → {type:"error",code:"E_FORBIDDEN"},
 *       sem fechar a ligação; text não-string/vazio → {code:"E_INVALID"}.
 *
 * Regras (brief da Task 6 + acordos do controller):
 *   - mapeamento código→HTTP: E_INVALID→400, E_FORBIDDEN→403, E_NOTFOUND→404
 *     (E_DUP→409 por simetria com src/friends.js, ainda que nenhuma rota de
 *     chat o provoque hoje);
 *   - POST verifica amizade com CADA membro ANTES de chamar a store (a store
 *     não verifica amizades em createConversation); membro desconhecido → 404,
 *     como em src/friends.js;
 *   - a criadora fica implicitamente na conversa (memberIds do corpo são os
 *     convidados; dedup abaixo) — 1:1 com 2 membros, grupo com 3+ (isGroup
 *     derivado da dimensão, o corpo do brief não traz isGroup);
 *   - GET de mensagens exige membro ANTES de ler (a store não protege a
 *     leitura); conversa desconhecida → 403, simétrico ao WS;
 *   - ?limit= inteiro ≥ 1 (por omissão 50); ?before= cursor opcional — formato
 *     inválido → 400, cursor de formato válido desconhecido → [] (regra
 *     vinculante da store: beforeId desconhecido devolve lista vazia).
 */

const LIMITE_PADRAO_MENSAGENS = 50;

/** Formatos aceites para o cursor ?before=: id numérico (futuras stores) ou UUID. */
const FORMATO_CURSOR = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Mapeamento dos códigos do StoreError para status HTTP. */
const STATUS_POR_CODIGO = {
  E_DUP: 409,
  E_NOTFOUND: 404,
  E_FORBIDDEN: 403,
  E_INVALID: 400,
};

/** Converte um StoreError previsto no respetivo HttpError; o resto passa. */
function traduzErroStore(err) {
  if (!(err instanceof StoreError)) throw err;
  const status = STATUS_POR_CODIGO[err.code];
  if (status === undefined) throw err;
  falha(status, err.message);
}

/**
 * @param {object} entrada
 * @param {object} entrada.store - implementação do contrato src/store.js
 * @param {Function} [entrada.enviarDireto] - (ws, envelope) envio a 1 socket
 *   (só o hub WS passa esta função)
 * @param {Function} [entrada.enviarPara] - (userId, envelope) envio a todas as
 *   abas do utilizador (só o hub WS passa esta função)
 */
function createChatHandlers({ store, enviarDireto, enviarPara }) {
  // --- REST -----------------------------------------------------------------

  async function listarConversas(req) {
    const { user: eu } = await exigirSessao(req, store);
    const conversations = await store.listConversations(eu.id);
    return { status: 200, body: { conversations } };
  }

  async function criarConversa(req) {
    const { user: eu } = await exigirSessao(req, store);
    const corpo = await lerCorpoJson(req);
    if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) {
      falha(400, 'Corpo inválido');
    }
    if (!Array.isArray(corpo.memberIds) || corpo.memberIds.length === 0) {
      falha(400, 'memberIds tem de ser uma lista com pelo menos um membro');
    }
    if (corpo.memberIds.some((id) => typeof id !== 'string')) {
      falha(400, 'memberIds tem de conter ids de utilizador');
    }
    if (corpo.title !== undefined && corpo.title !== null && typeof corpo.title !== 'string') {
      falha(400, 'title tem de ser texto');
    }

    // Amizade verificada com CADA membro ANTES de chamar a store — a store não
    // verifica amizades. A criadora conta sempre (dedup abaixo); só os outros
    // membros têm de ser amigos dela.
    for (const memberId of corpo.memberIds) {
      if (memberId === eu.id) continue;
      if (!(await store.getUserById(memberId))) falha(404, 'Utilizador não encontrado');
      if (!(await store.areFriends(eu.id, memberId))) falha(403, 'Todos os membros têm de ser amigos');
    }

    const memberIds = [...new Set([eu.id, ...corpo.memberIds])];
    if (memberIds.length < 2) falha(400, 'A conversa precisa de pelo menos dois membros');
    const isGroup = memberIds.length > 2;
    const title = typeof corpo.title === 'string' ? corpo.title : null;

    let conv;
    try {
      conv = await store.createConversation(memberIds, isGroup, title);
    } catch (err) {
      traduzErroStore(err);
    }
    return { status: 201, body: { conversationId: conv.id } };
  }

  async function listarMensagens(req, conversationId) {
    const { user: eu } = await exigirSessao(req, store);

    // Autorização primeiro: a store não protege a leitura de mensagens. Uma
    // conversa desconhecida também é "não sou membro" (403), como no WS.
    if (!(await store.isMember(conversationId, eu.id))) {
      falha(403, 'Não é membro da conversa');
    }

    const url = new URL(req.url, 'http://localhost');
    const limit = lerLimite(url.searchParams);
    const beforeId = lerCursor(url.searchParams);

    let messages;
    try {
      messages = await store.listMessages(conversationId, limit, beforeId);
    } catch (err) {
      traduzErroStore(err); // rede de segurança: E_NOTFOUND→404, etc.
    }
    return { status: 200, body: { messages } };
  }

  /** ?limit= — inteiro ≥ 1; por omissão LIMITE_PADRAO_MENSAGENS. */
  function lerLimite(params) {
    const bruto = params.get('limit');
    if (bruto === null) return LIMITE_PADRAO_MENSAGENS;
    if (!/^\d+$/.test(bruto) || Number(bruto) < 1) falha(400, 'Limit inválido');
    return Number(bruto);
  }

  /** ?before= — cursor opcional; vazio conta como ausente; formato mau → 400. */
  function lerCursor(params) {
    const bruto = params.get('before');
    if (bruto === null || bruto === '') return null;
    if (!FORMATO_CURSOR.test(bruto)) falha(400, 'Cursor before inválido');
    return bruto;
  }

  const ROTAS = {
    'GET /api/conversations': listarConversas,
    'POST /api/conversations': criarConversa,
  };

  /**
   * Devolve o handler da rota pedida ou null. As rotas exatas seguem o mapa
   * ROTAS (como src/friends.js); o histórico é dinâmico, pelo que o caminho
   * /api/conversations/:id/messages é reconhecido por padrão.
   */
  function match(method, pathname) {
    const exata = ROTAS[`${method} ${pathname}`];
    if (exata) return matchHandler(exata);
    const mensagens = /^\/api\/conversations\/([^/]+)\/messages$/.exec(pathname);
    if (mensagens && method === 'GET') {
      let id;
      try {
        id = decodeURIComponent(mensagens[1]);
      } catch {
        return matchHandler(async () => falha(400, 'Caminho inválido'));
      }
      return matchHandler((req) => listarMensagens(req, id));
    }
    return null;
  }

  // --- WS -------------------------------------------------------------------

  /**
   * Trata um envelope pós-auth do chat. Devolve true se o tipo pertence ao
   * chat (tratado, com sucesso ou com erro); false deixa o hub responder
   * E_UNKNOWN_TYPE. Nunca lança: qualquer falha da store vira erro ao socket.
   * Assíncrono porque a store pode ser a de Postgres (Task 11).
   */
  async function handleEnvelope(envelope, user, ws) {
    if (!envelope || typeof envelope !== 'object' || envelope.type !== 'chat_send') {
      return false;
    }

    if (typeof envelope.text !== 'string' || envelope.text.length === 0) {
      enviarDireto(ws, { type: 'error', code: 'E_INVALID' });
      return true;
    }

    // Membro da conversa? (conversa inexistente ou id malformado → também
    // não é membro; a ligação mantém-se viva.)
    if (!(await store.isMember(envelope.conversationId, user.id))) {
      enviarDireto(ws, { type: 'error', code: 'E_FORBIDDEN' });
      return true;
    }

    // Membros da conversa para a difusão (o contrato não expõe getConversation;
    // como é membro, a conversa está em listConversations).
    const conv = (await store.listConversations(user.id)).find(
      (c) => c.id === envelope.conversationId,
    );
    const memberIds = conv ? conv.memberIds : [user.id];

    let msg;
    try {
      msg = await store.appendMessage(envelope.conversationId, user.id, envelope.text);
    } catch (err) {
      const codigo = err instanceof StoreError ? err.code : 'E_INTERNAL';
      enviarDireto(ws, { type: 'error', code: codigo });
      return true;
    }

    const pacote = {
      type: 'chat_message',
      conversationId: envelope.conversationId,
      fromUserId: user.id,
      fromName: user.username,
      text: msg.text,
      ts: msg.ts,
    };

    // Eco ao remetente: a sua própria ação devolve-lhe a mensagem uma única
    // vez — a difusão abaixo EXCLUI os sockets do remetente (sem dupla entrega).
    enviarDireto(ws, pacote);

    // Difusão a todos os outros membros online — todas as abas de cada um
    // (enviarPara/enviarDireto são best-effort, com readyState + try/catch).
    for (const membro of memberIds) {
      if (membro === user.id) continue;
      enviarPara(membro, pacote);
    }
    return true;
  }

  return { match, handleEnvelope };
}

module.exports = { createChatHandlers };
