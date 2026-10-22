'use strict';

const crypto = require('node:crypto');
const { StoreError } = require('./store');

/**
 * Implementação em memória do contrato `src/store.js`.
 *
 * Estado interno: Maps para users, sessões, pedidos de amizade, amizades,
 * conversas e mensagens. Todas as leituras devolvem cópias — mutações
 * externas nunca afetam o estado interno. Sem dependências externas.
 *
 * @returns {object} store que cumpre o contrato documentado em src/store.js
 */
function createStoreMemory() {
  /** @type {Map<string, object>} id -> user */
  const usersById = new Map();
  /** @type {Map<string, string>} username -> userId (comparação exata) */
  const userIdByUsername = new Map();
  /** @type {Map<string, string>} token -> userId */
  const userIdByToken = new Map();
  /** @type {Map<string, object>} id -> pedido de amizade */
  const friendRequestsById = new Map();
  /** @type {Map<string, Set<string>>} userId -> ids de amigos (bidirecional) */
  const friendIdsByUser = new Map();
  /** @type {Map<string, object>} id -> conversa */
  const conversationsById = new Map();
  /**
   * @type {Map<string, object[]>} convId -> mensagens por ordem de inserção
   * (antigas -> novas); a ordem de inserção é a fonte de verdade da crono.
   */
  const messagesByConversation = new Map();

  function exigeUser(userId) {
    const user = usersById.get(userId);
    if (!user) throw new StoreError('E_NOTFOUND', 'Utilizador não encontrado');
    return user;
  }

  function agora() {
    return new Date().toISOString();
  }

  function novoId() {
    return crypto.randomUUID();
  }

  // --- users ---------------------------------------------------------------

  function createUser({ username, passHash, secQ, secA }) {
    if (userIdByUsername.has(username)) {
      throw new StoreError('E_DUP', 'Nome de utilizador já existe');
    }
    const user = {
      id: novoId(), username, passHash, secQ, secA,
      visibilidade: 'publico', createdAt: agora(),
    };
    usersById.set(user.id, user);
    userIdByUsername.set(username, user.id);
    return { ...user };
  }

  function getUserByUsername(username) {
    const id = userIdByUsername.get(username);
    return id == null ? null : { ...usersById.get(id) };
  }

  function getUserById(id) {
    const user = usersById.get(id);
    return user ? { ...user } : null;
  }

  // Método aditivo (Task 3 — recuperação): substitui o passHash guardado.
  function updateUserPassword(userId, passHash) {
    const user = exigeUser(userId);
    user.passHash = passHash;
    return { ...user };
  }

  // --- Google (v1.1 — login com Google) --------------------------------------

  function getUserByGoogleId(googleId) {
    if (googleId == null) return null;
    for (const user of usersById.values()) {
      if (user.googleId === googleId) return { ...user };
    }
    return null;
  }

  function getUserByEmail(email) {
    if (email == null) return null;
    for (const user of usersById.values()) {
      if (user.email === email) return { ...user };
    }
    return null;
  }

  // Liga uma conta Google a um utilizador existente (mesmo email verificado).
  function linkGoogleToUser(userId, { googleId, email }) {
    const user = exigeUser(userId);
    user.googleId = googleId;
    user.email = email;
    return { ...user };
  }

  // Cria utilizador via Google: sem senha nem pergunta de segurança.
  function createUserWithGoogle({ username, email, googleId }) {
    const user = {
      id: novoId(), username, passHash: null, secQ: null, secA: null,
      email, googleId, phone: null, visibilidade: 'publico', createdAt: agora(),
    };
    usersById.set(user.id, user);
    userIdByUsername.set(username, user.id);
    return { ...user };
  }

  // --- telefone (v1.1 — descoberta de amigos) --------------------------------

  function normalizarTelefone(t) {
    return String(t).replace(/[^0-9+]/g, '');
  }

  function getUserByPhone(telefone) {
    if (telefone == null) return null;
    const alvo = normalizarTelefone(telefone);
    if (alvo === '') return null;
    for (const user of usersById.values()) {
      if (user.phone != null && normalizarTelefone(user.phone) === alvo) {
        return { ...user };
      }
    }
    return null;
  }

  // Guarda/atualiza o telefone do utilizador (string vazia → remove).
  function setPhone(userId, telefone) {
    const user = exigeUser(userId);
    if (telefone != null && String(telefone).trim() !== '') {
      const limpo = normalizarTelefone(telefone);
      if (limpo.length < 7 || limpo.length > 15) {
        throw new StoreError('E_INVALID', 'Número de telefone inválido');
      }
      user.phone = limpo;
    } else {
      user.phone = null;
    }
    return { ...user };
  }

  // --- visibilidade (v1.1 — perfis público/privado) --------------------------

  // 'publico': encontrável por qualquer utilizador (nome, email, telefone).
  // 'privado': encontrável SÓ por quem tem o email ou o telefone.
  function setVisibilidade(userId, visibilidade) {
    const user = exigeUser(userId);
    if (visibilidade !== 'publico' && visibilidade !== 'privado') {
      throw new StoreError('E_INVALID', 'Visibilidade inválida');
    }
    user.visibilidade = visibilidade;
    return { ...user };
  }

  // --- sessões ---------------------------------------------------------------

  function createSession(userId) {
    exigeUser(userId);
    const token = crypto.randomBytes(32).toString('hex');
    userIdByToken.set(token, userId);
    return token;
  }

  function getUserByToken(token) {
    const id = userIdByToken.get(token);
    return id == null ? null : { ...usersById.get(id) };
  }

  function deleteSession(token) {
    userIdByToken.delete(token); // idempotente
  }

  // Método aditivo (passe final — recuperação de senha): apaga TODAS as
  // sessões do utilizador, para tokens roubados/antigos deixarem de valer.
  function deleteSessionsForUser(userId) {
    for (const [token, id] of userIdByToken) {
      if (id === userId) userIdByToken.delete(token);
    }
  }

  // --- amizades ---------------------------------------------------------------

  function saoAmigos(a, b) {
    return a !== b && (friendIdsByUser.get(a)?.has(b) ?? false);
  }

  function adicionarAmizade(a, b) {
    if (!friendIdsByUser.has(a)) friendIdsByUser.set(a, new Set());
    if (!friendIdsByUser.has(b)) friendIdsByUser.set(b, new Set());
    friendIdsByUser.get(a).add(b);
    friendIdsByUser.get(b).add(a);
  }

  function createFriendRequest(fromId, toId) {
    if (fromId === toId) {
      throw new StoreError('E_SELF', 'Não pode adicionar-se a si próprio');
    }
    exigeUser(fromId);
    exigeUser(toId);
    if (saoAmigos(fromId, toId)) {
      throw new StoreError('E_DUP', 'Já são amigos');
    }
    const pedidoPendente = [...friendRequestsById.values()].some(
      (p) =>
        p.status === 'pending' &&
        ((p.fromId === fromId && p.toId === toId) ||
          (p.fromId === toId && p.toId === fromId)),
    );
    if (pedidoPendente) {
      throw new StoreError('E_DUP', 'Já existe um pedido de amizade pendente');
    }
    const pedido = { id: novoId(), fromId, toId, status: 'pending', createdAt: agora() };
    friendRequestsById.set(pedido.id, pedido);
    return { ...pedido };
  }

  function acceptFriendRequest(requestId, toId) {
    const pedido = friendRequestsById.get(requestId);
    if (!pedido) {
      throw new StoreError('E_NOTFOUND', 'Pedido de amizade não encontrado');
    }
    if (pedido.toId !== toId) {
      throw new StoreError('E_FORBIDDEN', 'Só o destinatário pode aceitar o pedido');
    }
    if (pedido.status !== 'pending') {
      throw new StoreError('E_DUP', 'Pedido de amizade já processado');
    }
    pedido.status = 'accepted';
    adicionarAmizade(pedido.fromId, pedido.toId);
    return { ...pedido };
  }

  // v1.1 — recusar/cancelar: qualquer uma das PARTES (de ou para) remove a
  // pendência. Idempotência: pedido inexistente → E_NOTFOUND; já aceite →
  // E_DUP (a amizade existe — usar outra via). O par fica livre para um novo
  // pedido no futuro.
  function removerPedido(requestId, userId) {
    const pedido = friendRequestsById.get(requestId);
    if (!pedido) {
      throw new StoreError('E_NOTFOUND', 'Pedido de amizade não encontrado');
    }
    if (pedido.fromId !== userId && pedido.toId !== userId) {
      throw new StoreError('E_FORBIDDEN', 'Não é parte deste pedido');
    }
    if (pedido.status !== 'pending') {
      throw new StoreError('E_DUP', 'Pedido de amizade já processado');
    }
    friendRequestsById.delete(requestId);
  }

  function listFriends(userId) {
    exigeUser(userId);
    const amigos = friendIdsByUser.get(userId) ?? new Set();
    return [...amigos].map((id) => ({ ...usersById.get(id) }));
  }

  function areFriends(a, b) {
    return saoAmigos(a, b);
  }

  // Método aditivo (Task 11): as pendências vivem na store — um servidor
  // persistente com restart continua a mostrá-las (GET /api/friends lê daqui).
  function listFriendRequests(userId) {
    exigeUser(userId);
    const pendingIn = [];
    const pendingOut = [];
    for (const p of friendRequestsById.values()) {
      if (p.status !== 'pending') continue;
      if (p.toId === userId) {
        pendingIn.push({
          id: p.id,
          fromUserId: p.fromId,
          fromUsername: usersById.get(p.fromId).username,
          createdAt: p.createdAt,
        });
      } else if (p.fromId === userId) {
        pendingOut.push({
          id: p.id,
          toUserId: p.toId,
          toUsername: usersById.get(p.toId).username,
          createdAt: p.createdAt,
        });
      }
    }
    return { pendingIn, pendingOut };
  }

  // --- conversas e mensagens ---------------------------------------------------------------

  function copiaConv(conv) {
    // Cópia profunda no memberIds: o array interno nunca partilha com callers
    // (mutar a conv devolvida não altera isMember/listConversations).
    return { ...conv, memberIds: [...conv.memberIds] };
  }

  function createConversation(memberIds, isGroup, title) {
    if (!Array.isArray(memberIds) || memberIds.length === 0) {
      throw new StoreError('E_INVALID', 'A conversa precisa de pelo menos um membro');
    }
    memberIds.forEach((id) => exigeUser(id));
    const conv = {
      id: novoId(),
      memberIds: [...new Set(memberIds)],
      isGroup: Boolean(isGroup),
      title: title == null ? null : title,
      createdAt: agora(),
    };
    conversationsById.set(conv.id, conv);
    messagesByConversation.set(conv.id, []);
    return copiaConv(conv);
  }

  function isMember(convId, userId) {
    const conv = conversationsById.get(convId);
    return Boolean(conv && conv.memberIds.includes(userId));
  }

  function listConversations(userId) {
    exigeUser(userId);
    const resultado = [];
    for (const conv of conversationsById.values()) {
      if (conv.memberIds.includes(userId)) resultado.push(copiaConv(conv));
    }
    return resultado;
  }

  function appendMessage(convId, userId, text) {
    const mensagens = messagesByConversation.get(convId);
    if (!mensagens) {
      throw new StoreError('E_NOTFOUND', 'Conversa não encontrada');
    }
    if (!isMember(convId, userId)) {
      throw new StoreError('E_FORBIDDEN', 'Não é membro da conversa');
    }
    if (typeof text !== 'string' || text.length === 0) {
      throw new StoreError('E_INVALID', 'Mensagem vazia');
    }
    const msg = { id: novoId(), convId, userId, text, ts: agora() };
    mensagens.push(msg);
    return { ...msg };
  }

  function listMessages(convId, limit, beforeId) {
    const mensagens = messagesByConversation.get(convId);
    if (!mensagens) {
      throw new StoreError('E_NOTFOUND', 'Conversa não encontrada');
    }
    let candidatos = mensagens;
    if (beforeId != null) {
      const idx = mensagens.findIndex((m) => m.id === beforeId);
      if (idx === -1) return []; // cursor fora do intervalo
      candidatos = mensagens.slice(0, idx);
    }
    const maximo =
      limit == null ? candidatos.length : Math.max(0, Math.min(limit, candidatos.length));
    return candidatos
      .slice(candidatos.length - maximo)
      .reverse()
      .map((m) => ({ ...m }));
  }

  return {
    // users
    createUser,
    getUserByUsername,
    getUserById,
    updateUserPassword,
    // Google (v1.1)
    getUserByGoogleId,
    getUserByEmail,
    linkGoogleToUser,
    createUserWithGoogle,
    // telefone (v1.1)
    getUserByPhone,
    setPhone,
    // visibilidade (v1.1)
    setVisibilidade,
    // sessões
    createSession,
    getUserByToken,
    deleteSession,
    deleteSessionsForUser,
    // amizades
    createFriendRequest,
    acceptFriendRequest,
    removerPedido,
    listFriends,
    areFriends,
    listFriendRequests,
    // conversas e mensagens
    createConversation,
    isMember,
    listConversations,
    appendMessage,
    listMessages,
  };
}

module.exports = { createStoreMemory };
