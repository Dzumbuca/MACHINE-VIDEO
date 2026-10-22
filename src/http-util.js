'use strict';

/**
 * Helpers HTTP partilhados — Machine Video Social (Task 4.5).
 *
 * Comportamento copiado VERBATIM de src/auth.js (a fonte original) para
 * eliminar a duplicação entre os módulos de rotas; nenhuma semântica mudou
 * nesta rodada. Ter UM único `HttpError` garante que `instanceof HttpError`
 * funciona entre módulos (duas classes com o mesmo nome quebram o instanceof).
 *
 * Módulo folha: não requer nada (nem node:crypto).
 *
 * Cada handler devolve { status, body }; o router (src/routes.js) escreve a
 * resposta. Erros previstos via HttpError são convertidos em { ok:false }.
 */

const MAX_BODY_BYTES = 64 * 1024;

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

/** Lê e faz parse do corpo JSON, com limite de tamanho (por omissão 64 KiB). */
function lerCorpoJson(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const pedacos = [];
    let bytes = 0;
    let demasiadoGrande = false;
    req.on('data', (pedaco) => {
      bytes += pedaco.length;
      if (bytes > maxBytes) {
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

/** Projeta o user da store para o formato público (sem passHash/secA).
 *  phone (v1.1): o próprio utilizador vê o telefone no perfil — nunca é
 *  exposto a outros (as listas de amigos usam {id, username}). */
function utilizadorPublico(user) {
  return { id: user.id, username: user.username, phone: user.phone ?? null };
}

/** Devolve { token, user } da sessão Bearer; 401 sem sessão ou inválida.
 * Assíncrono porque a store pode ser a de Postgres (Task 11) — com a store
 * em memória o `await` é um no-op. */
async function exigirSessao(req, store) {
  const header = req.headers.authorization || '';
  const correspondencia = /^Bearer\s+(.+)$/i.exec(header);
  if (!correspondencia) falha(401, 'Sessão em falta ou inválida');
  const token = correspondencia[1].trim();
  const user = await store.getUserByToken(token);
  if (!user) falha(401, 'Sessão em falta ou inválida');
  return { token, user };
}

/**
 * Envolve um handler num wrapper async que nunca lança: converte HttpError
 * em { status, body } e o inesperado em 500 'Erro interno'. A parte da
 * pesquisa de rota (`ROTAS[...]`) continua em cada módulo de rotas.
 */
function match(handler) {
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

module.exports = {
  HttpError,
  falha,
  lerCorpoJson,
  utilizadorPublico,
  exigirSessao,
  MAX_BODY_BYTES,
  match,
};
