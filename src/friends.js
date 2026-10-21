'use strict';

const { StoreError } = require('./store');
const {
  exigirSessao,
  falha,
  lerCorpoJson,
  match: matchHandler,
  utilizadorPublico,
} = require('./http-util');

/**
 * Amizades — Machine Video Social (Task 4).
 *
 * Rotas REST que este módulo serve (o corpo é sempre JSON):
 *   GET  /api/friends      (Bearer) → {friends, pendingIn, pendingOut}
 *   POST /api/friends/request {username}                    → 201 {requestId}
 *   POST /api/friends/accept   {requestId}                  → 200 {ok:true}
 *
 * Regras (brief da Task 4 + acordos do controller):
 *   - todos os endpoints exigem Bearer (401 sem/inválido), como em src/auth.js;
 *   - username desconhecido no pedido de amizade → 404;
 *   - pedido a si próprio → 400 (StoreError E_SELF);
 *   - pedido duplicado (já amigos, ou pendente em qualquer direção) → 409
 *     (StoreError E_DUP — um único status para os dois casos);
 *   - aceitar pedido que não nos é destinado → 403 (E_FORBIDDEN);
 *   - aceitar pedido inexistente ou já processado → 404 / 409 (E_NOTFOUND/E_DUP);
 *   - o mapeamento código→HTTP é: E_SELF→400, E_DUP→409, E_NOTFOUND→404,
 *     E_FORBIDDEN→403;
 *   - as respostas nunca expõem `passHash`/`secA`: o utilizador público é só
 *     { id, username }, como em src/auth.js.
 *
 * As pendências (pendingIn/pendingOut) são lidas da store via
 * `listFriendRequests` (aditivo da Task 11) — um registo local perder-se-ia
 * num servidor persistente com restart (a DB teria a pendência mas as listas
 * apareceriam vazias, contradizendo o E_DUP de um pedido duplicado).
 *
 * Cada handler devolve { status, body }; o router (src/routes.js) escreve a
 * resposta. Erros previstos via HttpError são convertidos em { ok:false }.
 */

/** Mapeamento dos códigos do StoreError para status HTTP. */
const STATUS_POR_CODIGO = {
  E_SELF: 400,
  E_DUP: 409,
  E_NOTFOUND: 404,
  E_FORBIDDEN: 403,
};

/** Converte um StoreError previsto no respetivo HttpError; o resto passa. */
function traduzErroStore(err) {
  if (!(err instanceof StoreError)) throw err;
  const status = STATUS_POR_CODIGO[err.code];
  if (status === undefined) throw err;
  falha(status, err.message);
}

function createFriendsHandlers({ store }) {
  async function pedirAmizade(req) {
    const { user: eu } = await exigirSessao(req, store);
    const corpo = await lerCorpoJson(req);
    const alvo = await store.getUserByUsername(corpo.username);
    if (!alvo) falha(404, 'Utilizador não encontrado');
    let pedido;
    try {
      pedido = await store.createFriendRequest(eu.id, alvo.id);
    } catch (err) {
      traduzErroStore(err);
    }
    return { status: 201, body: { requestId: pedido.id } };
  }

  async function aceitarAmizade(req) {
    const { user: eu } = await exigirSessao(req, store);
    const corpo = await lerCorpoJson(req);
    try {
      await store.acceptFriendRequest(corpo.requestId, eu.id);
    } catch (err) {
      traduzErroStore(err);
    }
    return { status: 200, body: { ok: true } };
  }

  async function listar(req) {
    const { user: eu } = await exigirSessao(req, store);
    const friends = (await store.listFriends(eu.id)).map(utilizadorPublico);
    const { pendingIn, pendingOut } = await store.listFriendRequests(eu.id);
    return {
      status: 200,
      body: {
        friends,
        pendingIn: pendingIn.map((p) => ({
          id: p.id,
          from: { id: p.fromUserId, username: p.fromUsername },
          createdAt: p.createdAt,
        })),
        pendingOut: pendingOut.map((p) => ({
          id: p.id,
          to: { id: p.toUserId, username: p.toUsername },
          createdAt: p.createdAt,
        })),
      },
    };
  }

  const ROTAS = {
    'GET /api/friends': listar,
    'POST /api/friends/request': pedirAmizade,
    'POST /api/friends/accept': aceitarAmizade,
  };

  /**
   * Devolve o handler da rota pedida ou null. O handler devolvido nunca
   * lança: o wrapper partilhado (src/http-util.js) converte HttpError em
   * { status, body } e o inesperado em 500.
   */
  function match(method, pathname) {
    const handler = ROTAS[`${method} ${pathname}`];
    if (!handler) return null;
    return matchHandler(handler);
  }

  return { match };
}

module.exports = { createFriendsHandlers };
