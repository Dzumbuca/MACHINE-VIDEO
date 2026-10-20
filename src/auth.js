'use strict';

const bcrypt = require('bcryptjs');
const { StoreError } = require('./store');
const {
  exigirSessao,
  falha,
  lerCorpoJson,
  match: matchHandler,
  utilizadorPublico,
} = require('./http-util');

/**
 * Autenticação — Machine Video Social (Task 3).
 *
 * Rotas REST que este módulo serve (o corpo é sempre JSON):
 *   POST /api/register {username,password,secQuestion,secAnswer} → {userId}
 *   POST /api/login    {username,password}                       → {token,user}
 *   POST /api/logout   (Bearer)                                  → {ok:true}
 *   GET  /api/me       (Bearer)                                  → {user}
 *   POST /api/recover  {username,secAnswer,newPassword}          → {ok:true}
 *
 * Regras (brief da Task 3 + acordos do controller):
 *   - username duplicado → 409 (StoreError E_DUP da store)
 *   - senha com menos de 6 caracteres → 400 (validação na camada HTTP)
 *   - credenciais ruins (login) e resposta de segurança errada → 401
 *   - utilizador desconhecido na recuperação → 404
 *   - as respostas NUNCA expõem `passHash`/`secA`: o utilizador público
 *     é só { id, username }.
 *   - hash de senha E de resposta de segurança com bcryptjs; a store guarda
 *     o que recebe (ver src/store.js). A resposta de segurança é guardada
 *     como hash, nunca em claro.
 *   - o token vem de `store.createSession(userId)` — 32 bytes aleatórios em
 *     hex (crypto.randomBytes(32).toString("hex") na implementação da store).
 *
 * Cada handler devolve { status, body }; o router (src/routes.js) escreve a
 * resposta. Erros previstos via HttpError são convertidos em { ok:false }.
 */

const BCRYPT_ROUNDS = 10;
const MIN_PASSWORD_LENGTH = 6;
const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,20}$/;

function validarUsername(valor) {
  if (typeof valor !== 'string' || !USERNAME_PATTERN.test(valor)) {
    falha(400, 'Nome de utilizador inválido: 3 a 20 caracteres (letras, números ou _)');
  }
  return valor;
}

function validarPassword(valor) {
  if (typeof valor !== 'string' || valor.length < MIN_PASSWORD_LENGTH) {
    falha(400, `A senha deve ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres`);
  }
  return valor;
}

function exigirTexto(valor, mensagem) {
  if (typeof valor !== 'string' || valor.length === 0) falha(400, mensagem);
  return valor;
}

function createAuthHandlers({ store }) {
  async function registar(req) {
    const corpo = await lerCorpoJson(req);
    const username = validarUsername(corpo.username);
    const password = validarPassword(corpo.password);
    const secQuestion = exigirTexto(corpo.secQuestion, 'Pergunta de segurança em falta');
    const secAnswer = exigirTexto(corpo.secAnswer, 'Resposta de segurança em falta');

    const passHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const secAHash = await bcrypt.hash(secAnswer, BCRYPT_ROUNDS);
    try {
      const user = store.createUser({ username, passHash, secQ: secQuestion, secA: secAHash });
      return { status: 200, body: { userId: user.id } };
    } catch (err) {
      if (err instanceof StoreError && err.code === 'E_DUP') {
        falha(409, 'Nome de utilizador já existe');
      }
      throw err;
    }
  }

  async function login(req) {
    const corpo = await lerCorpoJson(req);
    const { username, password } = corpo;
    if (typeof username !== 'string' || typeof password !== 'string') {
      falha(400, 'Pedido inválido');
    }
    const user = store.getUserByUsername(username);
    const ok =
      user !== null &&
      typeof user.passHash === 'string' &&
      (await bcrypt.compare(password, user.passHash));
    if (!ok) falha(401, 'Credenciais inválidas');
    const token = store.createSession(user.id);
    return { status: 200, body: { token, user: utilizadorPublico(user) } };
  }

  function logout(req) {
    const { token } = exigirSessao(req, store);
    store.deleteSession(token);
    return { status: 200, body: { ok: true } };
  }

  function perfil(req) {
    const { user } = exigirSessao(req, store);
    return { status: 200, body: { user: utilizadorPublico(user) } };
  }

  async function recuperar(req) {
    const corpo = await lerCorpoJson(req);
    const { username, secAnswer, newPassword } = corpo;
    const novaSenha = validarPassword(newPassword);
    if (typeof username !== 'string' || typeof secAnswer !== 'string') {
      falha(400, 'Pedido inválido');
    }
    const user = store.getUserByUsername(username);
    if (!user) falha(404, 'Utilizador não encontrado');
    const respostaOk =
      typeof user.secA === 'string' && (await bcrypt.compare(secAnswer, user.secA));
    if (!respostaOk) falha(401, 'Resposta de segurança incorreta');
    const passHash = await bcrypt.hash(novaSenha, BCRYPT_ROUNDS);
    store.updateUserPassword(user.id, passHash);
    return { status: 200, body: { ok: true } };
  }

  const ROTAS = {
    'POST /api/register': registar,
    'POST /api/login': login,
    'POST /api/logout': logout,
    'POST /api/recover': recuperar,
    'GET /api/me': perfil,
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

module.exports = { createAuthHandlers };
