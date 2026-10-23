'use strict';

const bcrypt = require('bcryptjs');
const { StoreError } = require('./store');
const { criarLimitador } = require('./ratelimit');
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
 *   - register/login/recover são endpoints PÚBLICOS num URL público: passam
 *     por um limitador in-memory (src/ratelimit.js, 10 tentativas/5 min por
 *     chave IP+username — por-processo, recomeça em restart; suficiente v1)
 *     antes de qualquer bcrypt, para travar força-bruta e DoS de CPU.
 *     Excedido → 429 {"ok":false,"erro":"Demasiadas tentativas. …"}.
 *   - a recuperação (recover) APAGA todas as sessões do utilizador depois de
 *     trocar a senha (store.deleteSessionsForUser): tokens roubados/antigos
 *     deixam de valer. O utilizador do recover não fica logado (fluxo
 *     existente: recover → volta ao login). No login NÃO se invalida — cada
 *     login cria a sua própria sessão sem mexer nas outras.
 *
 * Cada handler devolve { status, body }; o router (src/routes.js) escreve a
 * resposta. Erros previstos via HttpError são convertidos em { ok:false }.
 */

const BCRYPT_ROUNDS = 10;
const MIN_PASSWORD_LENGTH = 6;
const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,20}$/;

/** Mensagem única do limitador (o router embrulha em {ok:false,erro}). */
const ERRO_LIMITE = 'Demasiadas tentativas. Espera um pouco.';

/** IP do cliente tal como o Node o reporta (proxy do Render inclui só 1 salto). */
function ipDe(req) {
  return (req.socket && req.socket.remoteAddress) || 'desconhecido';
}

/**
 * Chave do limitador: tipo de ação + IP + username (quando houver) — a
 * parte de username isola contas diferentes, a de IP trava ataques sem
 * conta conhecida.
 */
function chaveLimite(acao, req, username) {
  const parte = typeof username === 'string' && username.length > 0 ? username : '-';
  return `${acao}:${ipDe(req)}:${parte}`;
}

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
  // Uma instância partilhada pelas três rotas públicas; as chaves levam o
  // prefixo da ação, pelo que cada endpoint tem a sua própria janela.
  const limitador = criarLimitador();

  async function registar(req) {
    const corpo = await lerCorpoJson(req);
    if (
      !limitador.permitir(chaveLimite('register', req, corpo && corpo.username))
    ) {
      falha(429, ERRO_LIMITE);
    }
    const username = validarUsername(corpo.username);
    const password = validarPassword(corpo.password);
    const secQuestion = exigirTexto(corpo.secQuestion, 'Pergunta de segurança em falta');
    const secAnswer = exigirTexto(corpo.secAnswer, 'Resposta de segurança em falta');

    const passHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const secAHash = await bcrypt.hash(secAnswer, BCRYPT_ROUNDS);
    try {
      const user = await store.createUser({ username, passHash, secQ: secQuestion, secA: secAHash });
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
    if (!limitador.permitir(chaveLimite('login', req, corpo && corpo.username))) {
      falha(429, ERRO_LIMITE);
    }
    const { username, password } = corpo;
    if (typeof username !== 'string' || typeof password !== 'string') {
      falha(400, 'Pedido inválido');
    }
    const user = await store.getUserByUsername(username);
    const ok =
      user !== null &&
      typeof user.passHash === 'string' &&
      (await bcrypt.compare(password, user.passHash));
    if (!ok) falha(401, 'Credenciais inválidas');
    const token = await store.createSession(user.id);
    return { status: 200, body: { token, user: utilizadorPublico(user) } };
  }

  async function logout(req) {
    const { token } = await exigirSessao(req, store);
    await store.deleteSession(token);
    return { status: 200, body: { ok: true } };
  }

  async function perfil(req) {
    const { user } = await exigirSessao(req, store);
    return { status: 200, body: { user: utilizadorPublico(user) } };
  }

  async function recuperar(req) {
    const corpo = await lerCorpoJson(req);
    if (!limitador.permitir(chaveLimite('recover', req, corpo && corpo.username))) {
      falha(429, ERRO_LIMITE);
    }
    const { username, secAnswer, newPassword } = corpo;
    const novaSenha = validarPassword(newPassword);
    if (typeof username !== 'string' || typeof secAnswer !== 'string') {
      falha(400, 'Pedido inválido');
    }
    const user = await store.getUserByUsername(username);
    if (!user) falha(404, 'Utilizador não encontrado');
    const respostaOk =
      typeof user.secA === 'string' && (await bcrypt.compare(secAnswer, user.secA));
    if (!respostaOk) falha(401, 'Resposta de segurança incorreta');
    const passHash = await bcrypt.hash(novaSenha, BCRYPT_ROUNDS);
    await store.updateUserPassword(user.id, passHash);
    // Recuperação = recuperar o controlo da conta: apaga TODAS as sessões
    // (tokens roubados/antigos deixam de valer). O utilizador do recover
    // não fica logado — volta ao login, como no fluxo existente.
    await store.deleteSessionsForUser(user.id);
    return { status: 200, body: { ok: true } };
  }

  const ROTAS = {
    'POST /api/register': registar,
    'POST /api/login': login,
    'POST /api/logout': logout,
    'POST /api/recover': recuperar,
    'GET /api/me': perfil,
    'POST /api/me/phone': guardarTelefone,
    'POST /api/me/visibilidade': guardarVisibilidade,
    'POST /api/me/username': escolherUsername,
  };

  // Telefone do utilizador (v1.1 — descoberta de amigos). Vazio → remove.
  async function guardarTelefone(req) {
    const { user } = await exigirSessao(req, store);
    const corpo = await lerCorpoJson(req);
    if (typeof corpo.phone !== 'string') {
      falha(400, 'Pedido inválido');
    }
    const atualizado = await store.setPhone(user.id, corpo.phone.trim());
    return { status: 200, body: { ok: true, phone: atualizado.phone ?? null } };
  }

  // Visibilidade do perfil (v1.1): 'publico' ou 'privado'.
  async function guardarVisibilidade(req) {
    const { user } = await exigirSessao(req, store);
    const corpo = await lerCorpoJson(req);
    if (corpo.visibilidade !== 'publico' && corpo.visibilidade !== 'privado') {
      falha(400, 'Visibilidade inválida');
    }
    await store.setVisibilidade(user.id, corpo.visibilidade);
    return { status: 200, body: { ok: true, visibilidade: corpo.visibilidade } };
  }

  // Escolher/alterar o username (v1.1): obrigatório para contas Google com
  // nome provisório; o formato segue o mesmo regex do registo clássico.
  async function escolherUsername(req) {
    const { user } = await exigirSessao(req, store);
    const corpo = await lerCorpoJson(req);
    const username = typeof corpo.username === 'string' ? corpo.username.trim() : '';
    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
      falha(400, 'Nome de utilizador: 3–20 caracteres (letras, números ou _)');
    }
    try {
      const atualizado = await store.setUsername(user.id, username);
      return { status: 200, body: { ok: true, user: utilizadorPublico(atualizado) } };
    } catch (err) {
      if (err instanceof StoreError && err.code === 'E_DUP') {
        falha(409, 'Esse nome de utilizador já existe — escolhe outro');
      }
      throw err;
    }
  }

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
