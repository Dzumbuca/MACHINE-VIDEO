/**
 * api.js — cliente REST do Machine Video (Task 9).
 *
 * Todas as rotas devolvem JSON {ok:true,...} ou {ok:false,erro}. Este módulo
 * centraliza o fetch com o cabeçalho Bearer e transforma falhas previstas em
 * ApiError {status, erro} — as vistas mostram `erro` diretamente ao utilizador.
 *
 * O token vive em localStorage (chave `mv_token`) e é lido em cada pedido, o
 * que permite trocá-lo em testes. Sem frameworks: ES modules servidos tal como
 * estão, executáveis também no Node (usados pelo smoke test em test/).
 */

const CHAVE_TOKEN = 'mv_token';

function lerToken() {
  try {
    return globalThis.localStorage?.getItem(CHAVE_TOKEN) ?? null;
  } catch {
    return null; // ambiente sem storage (ex.: alguns modos privados)
  }
}

function guardarToken(token) {
  try {
    globalThis.localStorage?.setItem(CHAVE_TOKEN, token);
  } catch {
    // sem storage o utilizador continua a sessão apenas em memória desta página
  }
}

function limparToken() {
  try {
    globalThis.localStorage?.removeItem(CHAVE_TOKEN);
  } catch {
    // nada a limpar — ambiente sem storage
  }
}

/** Erro de API: `status` HTTP e `erro` em português, prontos para a interface. */
export class ApiError extends Error {
  constructor(status, erro) {
    super(erro);
    this.name = 'ApiError';
    this.status = status;
    this.erro = erro;
  }
}

/**
 * Pedido genérico. Lança ApiError em qualquer falha prevista (status != 2xx,
 * corpo sem JSON, rede em baixo). Um 401 limpa o token: a sessão expirou.
 */
export async function pedir(caminho, { method = 'GET', body } = {}) {
  const headers = {};
  const token = lerToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let resposta;
  try {
    resposta = await fetch(caminho, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Sem ligação ao servidor');
  }

  let dados = null;
  try {
    dados = await resposta.json();
  } catch {
    // resposta sem corpo JSON — tratada abaixo como erro genérico
  }

  if (!resposta.ok || !dados || dados.ok === false) {
    if (resposta.status === 401) limparToken(); // sessão inválida/expirada
    throw new ApiError(resposta.status, dados?.erro || `Erro ${resposta.status}`);
  }
  return dados;
}

/** Endpoints do backend (Tasks 3–6), com nomes em português para as vistas. */
export const api = {
  // --- autenticação ---------------------------------------------------------
  registar: ({ username, password, secQuestion, secAnswer }) =>
    pedir('/api/register', { method: 'POST', body: { username, password, secQuestion, secAnswer } }),
  entrar: (username, password) =>
    pedir('/api/login', { method: 'POST', body: { username, password } }),
  sair: () => pedir('/api/logout', { method: 'POST' }),
  eu: () => pedir('/api/me'),
  recuperar: ({ username, secAnswer, newPassword }) =>
    pedir('/api/recover', { method: 'POST', body: { username, secAnswer, newPassword } }),

  // --- amizades ---------------------------------------------------------------
  guardarTelefone: (phone) =>
    pedir('/api/me/phone', { method: 'POST', body: { phone } }),
  guardarVisibilidade: (visibilidade) =>
    pedir('/api/me/visibilidade', { method: 'POST', body: { visibilidade } }),
  amigos: () => pedir('/api/friends'),
  pedirAmizade: (contacto) =>
    pedir('/api/friends/request', { method: 'POST', body: { contacto } }),
  aceitarAmizade: (requestId) =>
    pedir('/api/friends/accept', { method: 'POST', body: { requestId } }),
  recusarAmizade: (requestId) =>
    pedir('/api/friends/reject', { method: 'POST', body: { requestId } }),

  // --- conversas ---------------------------------------------------------------
  conversas: () => pedir('/api/conversations'),
  criarConversa: (memberIds, title) => {
    const body = { memberIds };
    if (typeof title === 'string' && title.trim() !== '') body.title = title.trim();
    return pedir('/api/conversations', { method: 'POST', body });
  },
  /** Histórico: devolve mensagens da mais recente para a mais antiga. */
  mensagens: (conversationId, { limit, before } = {}) => {
    const params = new URLSearchParams();
    if (limit != null) params.set('limit', String(limit));
    if (before) params.set('before', String(before));
    const qs = params.toString();
    const caminho = `/api/conversations/${encodeURIComponent(conversationId)}/messages`;
    return pedir(qs ? `${caminho}?${qs}` : caminho);
  },
};

export { lerToken, guardarToken, limparToken };

// Manutenção: um toque a cada 4 min evita que o Render adormeça com alguém
// com o app aberto (o plano grátis dorme após ~15 min sem pedidos).
const _manutencao = setInterval(() => {
  if (lerToken()) fetch('/api/health').catch(() => {});
}, 4 * 60 * 1000);
if (typeof _manutencao.unref === 'function') _manutencao.unref(); // não segurar o Node nos testes
