/**
 * app.js — orquestrador do Machine Video (Task 9).
 *
 * Fluxo: arranque → sessão guardada em localStorage (GET /api/me) → ecrã de
 * autenticação ou aplicação. Na aplicação: barra lateral (conversas/amigos),
 * zona principal swapável e um único WsClient (reconexão automática) que
 * entrega presenças e mensagens em tempo real.
 *
 * GANCHO PARA A TASK 10 (chamadas e sessões de filme):
 *   - window.MV dá acesso a { api, obterWs, obterEstado, abrirConversa,
 *     montarVistaPrincipal, vistaConversa, aoSair };
 *   - o WsClient despacha por tipo: `ws.on('call_invite', fn)`,
 *     `ws.on('movie_state', fn)`… adicionam handlers sem tocar neste ficheiro;
 *   - `montarVistaPrincipal(nodo)` troca a zona principal por outra vista.
 */

import { api, lerToken } from './api.js';
import { WsClient } from './ws.js';
import { montarAuth, reporAuth } from './ui/auth.js';
import * as vistas from './ui/views.js';

const $ = (id) => document.getElementById(id);
const LIMITE_MENSAGENS = 50;

const estado = {
  utilizador: null,
  /** id → {id, username, online} — online começa desconhecido e chega por WS */
  amigos: new Map(),
  pendentesIn: [],
  pendentesOut: [],
  conversas: [],
  /** convId → ts ISO da última mensagem vista (ordenar a lista) */
  ultimaAtividade: new Map(),
  /** convId → {lista:[mensagens antiga→nova], maisAntigaId} */
  mensagens: new Map(),
  naoLidas: new Map(),
  ativa: null,
  aba: 'conversas',
};

let ws = null;
let refsConversa = null;
const saidaCallbacks = new Set();

// ---- arranque ----------------------------------------------------------------

iniciar();

function iniciar() {
  $('tab-conversas').addEventListener('click', () => mudarAba('conversas'));
  $('tab-amigos').addEventListener('click', () => mudarAba('amigos'));
  $('btn-sair').addEventListener('click', terminarSessao);
  $('form-amigo').addEventListener('submit', adicionarAmigo);
  $('btn-novo-grupo').addEventListener('click', abrirModalGrupo);
  $('lista-conversas').addEventListener('click', (ev) => {
    const item = ev.target.closest('.item[data-id]');
    if (item) abrirConversa(item.dataset.id);
  });

  montarAuth({ aoEntrar: entrarAplicacao });
  retomarSessao();
}

async function retomarSessao() {
  if (!lerToken()) return mostrarAuth();
  try {
    const { user } = await api.eu();
    entrarAplicacao(user);
  } catch (e) {
    mostrarAuth();
    if (e.status !== 401) vistas.toast(e.erro || 'Servidor indisponível. Tente mais tarde.', 'erro');
  }
}

function mostrarAuth() {
  $('app').hidden = true;
  $('auth').hidden = false;
  document.body.classList.remove('chat-open');
  reporAuth();
}

function entrarAplicacao(utilizador) {
  estado.utilizador = utilizador;
  $('auth').hidden = true;
  $('app').hidden = false;
  $('user-nome').textContent = utilizador.username;
  $('user-avatar').textContent = vistas.inicialDe(utilizador.username);

  ligarWs();
  vistas.mostrarVazio($('main'), { temAmigos: false });
  carregarTudo();
}

function limparEstado() {
  estado.utilizador = null;
  estado.amigos = new Map();
  estado.pendentesIn = [];
  estado.pendentesOut = [];
  estado.conversas = [];
  estado.ultimaAtividade = new Map();
  estado.mensagens = new Map();
  estado.naoLidas = new Map();
  estado.ativa = null;
  refsConversa = null;
  $('lista-conversas').replaceChildren();
  $('lista-amigos').replaceChildren();
  $('pedidos-zona').replaceChildren();
  for (const cb of saidaCallbacks) cb();
}

async function terminarSessao() {
  try {
    await api.sair();
  } catch {
    // token já morto no servidor — seguimos para o ecrã de entrada na mesma
  }
  sairLocal('Sessão terminada. Até já!');
}

function sairLocal(mensagem) {
  if (ws) ws.close();
  limparEstado();
  mostrarAuth();
  if (mensagem) vistas.toast(mensagem, 'ok');
}

// ---- ligação em tempo real ------------------------------------------------------

function ligarWs() {
  if (ws) ws.close();
  ws = new WsClient();
  ws.on('chat_message', receberMensagem);
  ws.on('presence', receberPresenca);
  ws.onStatus((s) => {
    if (refsConversa) vistas.definirEstadoWs(refsConversa, s);
    if (s === 'dead') sessaoMorta();
  });
  ws.connect(lerToken());
}

function sessaoMorta() {
  // Cinco tentativas sem autenticação: o token já não vale — entrar de novo.
  sairLocal('A sua sessão expirou. Entre novamente.');
}

function receberMensagem(envelope) {
  const { conversationId, fromUserId, fromName, text, ts } = envelope;
  const conv = estado.conversas.find((c) => c.id === conversationId);
  if (!conv) carregarConversas(); // conversa criada entretanto — trazê-la
  registrarAtividade(conversationId, ts);

  const cache = estado.mensagens.get(conversationId);
  if (cache) cache.lista.push({ userId: fromUserId, fromName, text, ts });

  if (conv && estado.ativa === conversationId && refsConversa) {
    const area = refsConversa.area;
    const pertoDoFim = area.scrollHeight - area.scrollTop - area.clientHeight < 140;
    vistas.adicionarMensagemChat(
      refsConversa,
      { userId: fromUserId, fromName, text, ts },
      { euId: estado.utilizador.id, ehGrupo: conv.isGroup },
    );
    if (pertoDoFim || fromUserId === estado.utilizador.id) {
      area.style.scrollBehavior = 'auto';
      area.scrollTop = area.scrollHeight;
      area.style.scrollBehavior = '';
    }
  } else if (fromUserId !== estado.utilizador.id) {
    estado.naoLidas.set(conversationId, (estado.naoLidas.get(conversationId) ?? 0) + 1);
  }

  ordenarConversas();
  renderConversas();
}

function receberPresenca(envelope) {
  const amigo = estado.amigos.get(envelope.userId);
  if (!amigo) return;
  amigo.online = Boolean(envelope.online);
  renderAmigos();
  renderConversas();
  if (estado.ativa && refsConversa) {
    const conv = estado.conversas.find((c) => c.id === estado.ativa);
    if (conv && !conv.isGroup) {
      const outroId = conv.memberIds.find((id) => id !== estado.utilizador.id);
      if (outroId === envelope.userId) {
        vistas.definirCabecalho(refsConversa, descricaoConversa(conv));
      }
    }
  }
}

// ---- carregamento e barra lateral ------------------------------------------------

async function carregarTudo() {
  await Promise.allSettled([carregarConversas(), carregarAmigos()]);
}

async function carregarConversas() {
  try {
    const { conversations } = await api.conversas();
    estado.conversas = conversations;
    ordenarConversas();
    renderConversas();
  } catch (e) {
    vistas.toast(e.erro || 'Não foi possível carregar as conversas', 'erro');
  }
}

async function carregarAmigos() {
  try {
    const dados = await api.amigos();
    estado.amigos = new Map(
      dados.friends.map((a) => [
        a.id,
        { ...a, online: estado.amigos.get(a.id)?.online ?? false },
      ]),
    );
    estado.pendentesIn = dados.pendingIn;
    estado.pendentesOut = dados.pendingOut;
    renderAmigos();
    renderBadge();
  } catch (e) {
    vistas.toast(e.erro || 'Não foi possível carregar os amigos', 'erro');
  }
}

function renderBadge() {
  const badge = $('badge-pendentes');
  const n = estado.pendentesIn.length;
  badge.hidden = n === 0;
  badge.textContent = String(n);
}

/** Descrição de apresentação de uma conversa (nome, subtítulo, presença). */
function descricaoConversa(conv) {
  if (conv.isGroup) {
    const nome = conv.title && conv.title.trim() !== '' ? conv.title : 'Grupo';
    return { nome, sub: `${conv.memberIds.length} membros`, online: false };
  }
  const outroId = conv.memberIds.find((id) => id !== estado.utilizador.id);
  const amigo = estado.amigos.get(outroId);
  return {
    nome: amigo?.username ?? 'Conversa',
    sub: amigo?.online ? 'online' : '',
    online: Boolean(amigo?.online),
  };
}

function renderConversas() {
  const itens = estado.conversas.map((conv) => {
    const { nome, sub, online } = descricaoConversa(conv);
    return {
      id: conv.id,
      nome,
      sub,
      ehGrupo: conv.isGroup,
      online,
      naoLidas: estado.naoLidas.get(conv.id) ?? 0,
      ativa: conv.id === estado.ativa,
    };
  });
  vistas.renderConversas($('lista-conversas'), itens);
}

function renderAmigos() {
  vistas.renderAmigos(
    { zonaPedidos: $('pedidos-zona'), listaAmigos: $('lista-amigos') },
    {
      amigos: [...estado.amigos.values()],
      pendentesIn: estado.pendentesIn,
      pendentesOut: estado.pendentesOut,
    },
    { aoAbrir: abrirComAmigo, aoAceitar: aceitarAmizade },
  );
}

function ordenarConversas() {
  const chave = (conv) => estado.ultimaAtividade.get(conv.id) ?? conv.createdAt ?? '';
  estado.conversas.sort((a, b) => (chave(a) < chave(b) ? 1 : -1));
}

function registrarAtividade(convId, ts) {
  if (!ts) return;
  const atual = estado.ultimaAtividade.get(convId);
  if (!atual || ts > atual) estado.ultimaAtividade.set(convId, ts);
}

function mudarAba(aba) {
  estado.aba = aba;
  $('tab-conversas').classList.toggle('is-active', aba === 'conversas');
  $('tab-amigos').classList.toggle('is-active', aba === 'amigos');
  $('tab-conversas').setAttribute('aria-selected', String(aba === 'conversas'));
  $('tab-amigos').setAttribute('aria-selected', String(aba === 'amigos'));
  $('painel-conversas').hidden = aba !== 'conversas';
  $('painel-amigos').hidden = aba !== 'amigos';
}

// ---- ações: amigos ----------------------------------------------------------------

async function adicionarAmigo(ev) {
  ev.preventDefault();
  const campo = $('amigo-nome');
  const nome = campo.value.trim();
  if (!nome) return;
  try {
    await api.pedirAmizade(nome);
    campo.value = '';
    vistas.toast(`Pedido enviado a ${nome}`, 'ok');
    await carregarAmigos();
  } catch (e) {
    vistas.toast(e.erro || 'Não foi possível enviar o pedido', 'erro');
  }
}

async function aceitarAmizade(requestId) {
  try {
    await api.aceitarAmizade(requestId);
    vistas.toast('Amizade aceite', 'ok');
  } catch (e) {
    vistas.toast(e.erro || 'Não foi possível aceitar o pedido', 'erro');
  }
  await carregarAmigos(); // refresca mesmo em falha (pedido pode ter mudado)
}

async function abrirComAmigo(amigoId) {
  const existente = estado.conversas.find(
    (c) => !c.isGroup && c.memberIds.includes(amigoId),
  );
  if (existente) return abrirConversa(existente.id);
  try {
    const { conversationId } = await api.criarConversa([amigoId]);
    await carregarConversas();
    await abrirConversa(conversationId);
  } catch (e) {
    vistas.toast(e.erro || 'Não foi possível abrir a conversa', 'erro');
  }
}

function abrirModalGrupo() {
  vistas.abrirModalGrupo({
    amigos: [...estado.amigos.values()],
    aoCriar: async (memberIds, titulo, fechar) => {
      try {
        const { conversationId } = await api.criarConversa(memberIds, titulo);
        fechar();
        await carregarConversas();
        await abrirConversa(conversationId);
        vistas.toast('Grupo criado', 'ok');
      } catch (e) {
        vistas.toast(e.erro || 'Não foi possível criar o grupo', 'erro');
      }
    },
  });
}

// ---- conversa aberta ----------------------------------------------------------------

async function abrirConversa(id) {
  const conv = estado.conversas.find((c) => c.id === id);
  if (!conv || !estado.utilizador) return;
  estado.ativa = id;
  estado.naoLidas.delete(id);
  document.body.classList.add('chat-open');
  renderConversas();

  if (!estado.mensagens.has(id)) await carregarMensagens(id);
  montarVista(id);
}

async function carregarMensagens(convId, { before } = {}) {
  try {
    const { messages } = await api.mensagens(convId, { limit: LIMITE_MENSAGENS, before });
    const antigas = [...messages].reverse(); // recebemos nova→antiga
    const cache = estado.mensagens.get(convId) ?? { lista: [], maisAntigaId: null };
    if (before) {
      cache.lista = [...antigas, ...cache.lista];
    } else {
      cache.lista = antigas;
    }
    if (antigas.length > 0) {
      cache.maisAntigaId = antigas[0].id;
    } else if (before) {
      cache.maisAntigaId = null; // já não há mensagens mais antigas
    }
    estado.mensagens.set(convId, cache);
    return messages;
  } catch (e) {
    vistas.toast(e.erro || 'Não foi possível carregar as mensagens', 'erro');
    return null;
  }
}

function montarVista(convId) {
  const conv = estado.conversas.find((c) => c.id === convId);
  const cache = estado.mensagens.get(convId) ?? { lista: [], maisAntigaId: null };
  const cabeca = descricaoConversa(conv);

  refsConversa = vistas.montarVistaConversa($('main'), {
    nome: cabeca.nome,
    subtitulo: cabeca.sub,
    online: cabeca.online,
    ehGrupo: conv.isGroup,
    estadoWs: ws ? ws.status : 'idle',
  });
  vistas.definirEstadoWs(refsConversa, ws ? ws.status : 'idle');
  vistas.renderMensagens(refsConversa, cache.lista, {
    euId: estado.utilizador.id,
    ehGrupo: conv.isGroup,
  });
  vistas.maisBtnEstado(refsConversa, Boolean(cache.maisAntigaId));

  refsConversa.maisBtn.addEventListener('click', () => carregarAntigas(convId));
  refsConversa.voltar.addEventListener('click', () => fecharConversa());
  refsConversa.composer.addEventListener('submit', (ev) => {
    ev.preventDefault();
    enviarMensagem(convId);
  });
  refsConversa.campo.focus();
}

function fecharConversa() {
  document.body.classList.remove('chat-open');
  estado.ativa = null;
  refsConversa = null;
  vistas.mostrarVazio($('main'), { temAmigos: estado.amigos.size > 0 });
  renderConversas();
}

async function carregarAntigas(convId) {
  const cache = estado.mensagens.get(convId);
  if (!cache?.maisAntigaId || estado.ativa !== convId || !refsConversa) return;
  refsConversa.maisBtn.disabled = true;
  const cursor = cache.maisAntigaId;
  const batch = await carregarMensagens(convId, { before: cursor });
  refsConversa.maisBtn.disabled = false;
  if (batch === null) return;
  const antigas = [...batch].reverse();
  if (antigas.length > 0) {
    vistas.inserirMensagensAntigas(
      refsConversa,
      antigas,
      { euId: estado.utilizador.id, ehGrupo: estado.conversas.find((c) => c.id === convId).isGroup },
    );
  }
  vistas.maisBtnEstado(refsConversa, Boolean(cache.maisAntigaId));
}

function enviarMensagem(conversationId) {
  const campo = refsConversa?.campo;
  if (!campo) return;
  const text = campo.value.trim();
  if (!text) return;
  // A mensagem aparece quando o servidor devolve o eco em chat_message.
  const ok = ws ? ws.send({ type: 'chat_send', conversationId, text }) : false;
  if (!ok) {
    vistas.toast('Sem ligação — a mensagem não foi enviada', 'erro');
    return;
  }
  campo.value = '';
  campo.focus();
}

// ---- gancho para os módulos da Task 10 (chamadas, sessões de filme) -----------------

window.MV = {
  api,
  obterWs: () => ws,
  obterEstado: () => estado,
  abrirConversa,
  zonaPrincipal: () => $('main'),
  /** Substitui a zona principal por uma vista própria (ex.: chamada em curso). */
  montarVistaPrincipal(nodo) {
    refsConversa = null;
    $('main').replaceChildren(nodo);
  },
  vistaConversa: () => refsConversa,
  /** Registra um callback executado quando a sessão termina. */
  aoSair(cb) {
    saidaCallbacks.add(cb);
    return () => saidaCallbacks.delete(cb);
  },
};
