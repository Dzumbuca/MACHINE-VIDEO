'use strict';

const { StoreError } = require('./store');

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
 * A store não expõe listagem de pedidos pendentes (contrato fechado em
 * src/store.js), mas `GET /api/friends` precisa de `pendingIn`/`pendingOut`.
 * Este módulo mantém um registo local dos pedidos que criou: é preenchido
 * apenas por POST /api/friends/request (todo o pedido de amizade passa por
 * aqui) e a entrada sai quando o pedido é aceite.
 *
 * Cada handler devolve { status, body }; o router (src/routes.js) escreve a
 * resposta. Erros previstos via HttpError são convertidos em { ok:false }.
 */

const MAX_BODY_BYTES = 64 * 1024;

/** Mapeamento dos códigos do StoreError para status HTTP. */
const STATUS_POR_CODIGO = {
  E_SELF: 400,
  E_DUP: 409,
  E_NOTFOUND: 404,
  E_FORBIDDEN: 403,
};

class HttpError extends Error {
  /**
   * @param {number} status - código HTTP a devolver
   * @param {string} message - mensagem user-facing em português
   */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function falha(status, message) {
  throw new HttpError(status, message);
}

/** Lê e faz parse do corpo JSON, com limite de tamanho. */
function lerCorpoJson(req) {
  return new Promise((resolve, reject) => {
    const pedacos = [];
    let bytes = 0;
    let demasiadoGrande = false;
    req.on('data', (pedaco) => {
      bytes += pedaco.length;
      if (bytes > MAX_BODY_BYTES) {
        demasiadoGrande = true; // continua a consumir para não pendurar a ligação
      } else {
        pedacos.push(pedaco);
      }
    });
    req.on('end', () => {
      if (demasiadoGrande) {
        reject(new HttpError(400, 'Pedido demasiado grande'));
        return;
      }
      const bruto = Buffer.concat(pedacos).toString('utf8');
      if (bruto.length === 0) {
        reject(new HttpError(400, 'Corpo JSON em falta'));
        return;
      }
      try {
        resolve(JSON.parse(bruto));
      } catch {
        reject(new HttpError(400, 'JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

/** Projeta o user da store para o formato público (sem passHash/secA). */
function utilizadorPublico(user) {
  return { id: user.id, username: user.username };
}

/** Converte um StoreError previsto no respetivo HttpError; o resto passa. */
function traduzErroStore(err) {
  if (!(err instanceof StoreError)) throw err;
  const status = STATUS_POR_CODIGO[err.code];
  if (status === undefined) throw err;
  falha(status, err.message);
}

function createFriendsHandlers({ store }) {
  /** @type {Map<string, object>} requestId -> pedido (só os ainda pendentes) */
  const pedidosPendentes = new Map();

  function exigirSessao(req) {
    const header = req.headers.authorization || '';
    const correspondencia = /^Bearer\s+(.+)$/i.exec(header);
    if (!correspondencia) falha(401, 'Sessão em falta ou inválida');
    const token = correspondencia[1].trim();
    const user = store.getUserByToken(token);
    if (!user) falha(401, 'Sessão em falta ou inválida');
    return { token, user };
  }

  async function pedirAmizade(req) {
    const { user: eu } = exigirSessao(req);
    const corpo = await lerCorpoJson(req);
    const alvo = store.getUserByUsername(corpo.username);
    if (!alvo) falha(404, 'Utilizador não encontrado');
    let pedido;
    try {
      pedido = store.createFriendRequest(eu.id, alvo.id);
    } catch (err) {
      traduzErroStore(err);
    }
    pedidosPendentes.set(pedido.id, pedido);
    return { status: 201, body: { requestId: pedido.id } };
  }

  async function aceitarAmizade(req) {
    const { user: eu } = exigirSessao(req);
    const corpo = await lerCorpoJson(req);
    let atualizado;
    try {
      atualizado = store.acceptFriendRequest(corpo.requestId, eu.id);
    } catch (err) {
      traduzErroStore(err);
    }
    pedidosPendentes.delete(atualizado.id); // já não está pendente
    return { status: 200, body: { ok: true } };
  }

  function listar(req) {
    const { user: eu } = exigirSessao(req);
    const friends = store.listFriends(eu.id).map(utilizadorPublico);
    const pendentes = [...pedidosPendentes.values()];
    const pendingIn = pendentes
      .filter((p) => p.toId === eu.id)
      .map((p) => ({
        id: p.id,
        from: utilizadorPublico(store.getUserById(p.fromId)),
        createdAt: p.createdAt,
      }));
    const pendingOut = pendentes
      .filter((p) => p.fromId === eu.id)
      .map((p) => ({
        id: p.id,
        to: utilizadorPublico(store.getUserById(p.toId)),
        createdAt: p.createdAt,
      }));
    return { status: 200, body: { friends, pendingIn, pendingOut } };
  }

  const ROTAS = {
    'GET /api/friends': listar,
    'POST /api/friends/request': pedirAmizade,
    'POST /api/friends/accept': aceitarAmizade,
  };

  /**
   * Devolve o handler da rota pedida ou null. O handler devolvido nunca
   * lança: converte HttpError em { status, body } e o inesperado em 500.
   */
  function match(method, pathname) {
    const handler = ROTAS[`${method} ${pathname}`];
    if (!handler) return null;
    return async (req) => {
      try {
        return await handler(req);
      } catch (err) {
        if (err instanceof HttpError) {
          return { status: err.status, body: { ok: false, erro: err.message } };
        }
        return { status: 500, body: { ok: false, erro: 'Erro interno' } };
      }
    };
  }

  return { match };
}

module.exports = { createFriendsHandlers };
