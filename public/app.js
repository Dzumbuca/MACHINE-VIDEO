/**
 * app.js — orquestrador do Machine Video. Sessão via localStorage → auth ou
 * app (barra lateral + zona principal swapável + WsClient com reconexão que
 * persiste enquanto houver token). call.js/movie.js registam-se no WsClient.
 */

import { api, lerToken, limparToken, guardarToken } from './api.js';
import { WsClient } from './ws.js';
import { montarAuth, reporAuth } from './ui/auth.js';
import * as vistas from './ui/views.js';
import { iniciarChamadas } from './call.js';
import { iniciarSessoesFilme } from './movie.js';

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
  $('form-telefone').addEventListener('submit', guardarTelefone);
  $('btn-novo-grupo').addEventListener('click', abrirModalGrupo);
  $('lista-conversas').addEventListener('click', (ev) => {
    const item = ev.target.closest('.item[data-id]');
    if (item) abrirConversa(item.dataset.id);
  });

  montarAuth({ aoEntrar: entrarAplicacao });
  retomarSessao();
}

// Preenche o campo de telefone com o valor guardado (o /api/me devolve-o).
function preencherTelefone(user) {
  const campo = $('meu-telefone');
  if (campo && user && user.phone != null) campo.value = user.phone;
}

async function retomarSessao() {
  // OAuth Google (v1.1): o callback volta com o token no fragmento (#auth=…)
  // — fragments nunca chegam ao servidor, por isso não aparecem em logs.
  if (location.hash.startsWith('#auth=')) {
    const tokenGoogle = decodeURIComponent(location.hash.slice(6));
    location.hash = '';
    if (tokenGoogle) {
      guardarToken(tokenGoogle);
    }
  } else if (location.hash.startsWith('#erro=google')) {
    location.hash = '';
    // O ecrã de entrada ainda não existe aqui — a mensagem fica para o toast
    // do montarAuth via sessionStorage.
    sessionStorage.setItem('mv_erro_entrada', 'Não foi possível entrar com o Google. Tenta novamente.');
  }
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
  const erroPendente = sessionStorage.getItem('mv_erro_entrada');
  if (erroPendente) {
    sessionStorage.removeItem('mv_erro_entrada');
    // O toast dispara no próximo tick — o ecrã de auth acabou de montar.
    setTimeout(() => vistas.toast(erroPendente, 'erro'), 50);
  }
  $('app').hidden = true;
  $('auth').hidden = false;
  $('app').classList.remove('chat-open');
  reporAuth();
}

function entrarAplicacao(utilizador) {
  preencherTelefone(utilizador);
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
  // Callbacks de saída ANTES de fechar o WS: os call_end/session_leave de fim precisam da ligação viva.
  for (const cb of saidaCallbacks) cb();
  if (ws) ws.close();
  limparToken(); // sair é sair: sem isto o token ficava em localStorage (partilha de computador)
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
    if (s === 'dead') validarSessaoOuAvisar();
  });
  iniciarChamadas(); iniciarSessoesFilme(); // Task 10: registam handlers no ws novo
  ws.connect(lerToken());
}

// 'dead' valida por API: 401 → sair; 200 → servidor a acordar, o WS persiste.
let aValidarSessao = false;
async function validarSessaoOuAvisar() {
  if (aValidarSessao) return;
  aValidarSessao = true;
  try {
    if (!lerToken()) { sairLocal(); return; }
    await api.eu(); // 200 → o token vale; mantemos as tentativas do WS
    vistas.toast('Sem ligação ao servidor — a tentar reconectar…', 'erro');
  } catch (erro) {
    if (erro && erro.status === 401) sairLocal('A tua sessão expirou. Entre novamente.');
  } finally {
    aValidarSessao = false;
  }
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


async function adicionarAmigo(ev) {
  ev.preventDefault();
  const campo = $('amigo-nome');
  const contacto = campo.value.trim();
  if (!contacto) return;
  try {
    await api.pedirAmizade(contacto);
    campo.value = '';
    vistas.toast(`Pedido enviado a ${contacto}`, 'ok');
    await carregarAmigos();
  } catch (e) {
    const dica = e.status === 404
      ? 'Amigo não encontrado — confirma o nome, email ou telefone (ele define o telefone no painel Amigos)'
      : (e.erro || 'Não foi possível enviar o pedido');
    vistas.toast(dica, 'erro');
  }
}

async function guardarTelefone(ev) {
  ev.preventDefault();
  const campo = $('meu-telefone');
  try {
    const r = await api.guardarTelefone(campo.value.trim());
    vistas.toast(r.phone ? 'Telefone guardado — os amigos já podem encontrar-te' : 'Telefone removido', 'ok');
  } catch (e) {
    vistas.toast(e.erro || e.status === 400 ? 'Número inválido (7–15 dígitos)' : 'Não foi possível guardar', 'erro');
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


function abrirConversa(id) {
  const conv = estado.conversas.find((c) => c.id === id);
  if (!conv || !estado.utilizador) return;
  estado.ativa = id;
  estado.naoLidas.delete(id);
  // A classe vive no #app (igual ao CSS responsivo: .app.chat-open .main)
  $('app').classList.add('chat-open');
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
  acoesConversa(refsConversa, conv);
}

/** Botões "Chamar" e "Sessão de filme" no cabeçalho da conversa (Task 10). */
function acoesConversa(refs, conv) {
  const zona = document.createElement('div');
  zona.className = 'chat-acoes';
  for (const [rotulo, acao] of [['Chamar', 'chamarDaConversa'], ['Sessão de filme', 'criarSessaoFilme']]) {
    const btn = Object.assign(document.createElement('button'), { type: 'button', className: 'btn btn-soft btn-sm', textContent: rotulo });
    btn.addEventListener('click', () => window.MV[acao]?.(conv));
    zona.appendChild(btn);
  }
  refs.pill.after(zona);
}

function fecharConversa() {
  $('app').classList.remove('chat-open');
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
function montarVistaPrincipal(nodo) {
  refsConversa = null;
  // Chamada/sessão de filme no telemóvel: a vista ocupa o ecrã (main visível).
  $('app').classList.add('chat-open');
  $('main').replaceChildren(nodo);
}
  vistaConversa: () => refsConversa,
  /** Registra um callback executado quando a sessão termina. */
  aoSair(cb) {
    saidaCallbacks.add(cb);
    return () => saidaCallbacks.delete(cb);
  },
};
