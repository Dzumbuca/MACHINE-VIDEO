/**
 * ui/views.js — renderização da aplicação (Task 9).
 *
 * Funções puras de construção de DOM: recebem dados simples + callbacks e
 * devolvem referências. NENHUM dado do utilizador passa por innerHTML — todo
 * texto dinâmico entra por textContent (proteção contra injeção). A zona
 * principal (#main) é swapável: app.js troca entre o estado vazio e a vista de
 * conversa, e os módulos da Task 10 (chamadas, sessões de filme) podem montar
 * as suas próprias vistas no mesmo sítio.
 */

const $ = (id) => document.getElementById(id);

/** Construtor pequeno: elemento com classes e texto (textContent, nunca HTML). */
function el(tag, classes = [], texto = '') {
  const nodo = document.createElement(tag);
  if (classes.length) nodo.className = classes.join(' ');
  if (texto !== '') nodo.textContent = texto;
  return nodo;
}

/** Inicial de um nome para o avatar (ou "#" quando vazio). */
export function inicialDe(nome) {
  return typeof nome === 'string' && nome.length > 0 ? nome[0] : '#';
}

function iconeMensagem() {
  const span = el('span', ['vazio-icone']);
  span.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H8l-4 4z" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
  return span;
}

// ---- toasts -----------------------------------------------------------------

let zonaToasts = null;

export function toast(texto, tipo = 'info') {
  if (!zonaToasts) zonaToasts = $('toasts');
  const aviso = el('div', ['toast', tipo === 'erro' ? 'erro' : tipo === 'ok' ? 'ok' : ''], texto);
  zonaToasts.appendChild(aviso);
  setTimeout(() => {
    aviso.style.opacity = '0';
    aviso.style.transition = 'opacity 0.25s ease';
    setTimeout(() => aviso.remove(), 260);
  }, 3200);
}

// ---- estado vazio da zona principal --------------------------------------------

export function mostrarVazio(main, { temAmigos }) {
  const caixa = el('div', ['vazio']);
  const titulo = el('h2', [], temAmigos ? 'Bem-vindo ao Machine Video' : 'O seu espaço de filmes');
  const texto = temAmigos
    ? 'Selecione uma conversa à esquerda ou abra um amigo para começar a falar.'
    : 'Ainda não tem amigos. Use o separador Amigos e adicione alguém pelo nome exato para começar a conversar.';
  caixa.append(iconeMensagem(), titulo, el('p', [], texto));
  main.replaceChildren(caixa);
}

// ---- barra lateral: conversas -----------------------------------------------------

/**
 * Preenche a lista de conversas. `itens`: [{id, nome, sub, ehGrupo, naoLidas, ativa}].
 * Os cliques são tratados por delegação no app.js (li.dataset.id).
 */
export function renderConversas(listaEl, itens) {
  listaEl.replaceChildren();
  if (itens.length === 0) {
    listaEl.appendChild(
      el('li', ['vazio-lista'], 'Ainda não tem conversas. Adicione um amigo para começar.'),
    );
    return;
  }
  for (const item of itens) {
    const li = el('li', ['item']);
    li.classList.toggle('is-ativa', Boolean(item.ativa));
    li.dataset.id = item.id;
    const avatar = el('span', ['avatar', item.ehGrupo ? 'avatar-grp' : ''], inicialDe(item.nome));
    if (!item.ehGrupo && typeof item.online === 'boolean') {
      avatar.appendChild(el('span', ['dot', item.online ? 'on' : '']));
    }
    const info = el('div', ['item-info']);
    info.append(el('span', ['item-nome'], item.nome));
    if (item.sub) info.append(el('span', ['item-sub'], item.sub));
    li.append(avatar, info);
    if (item.naoLidas > 0) li.append(el('span', ['badge-nao-lidas'], String(item.naoLidas)));
    listaEl.appendChild(li);
  }
}

// ---- barra lateral: amigos e pedidos ------------------------------------------------

/**
 * Preenche a zona de pedidos e a lista de amigos.
 * `dados`: {amigos:[{id,username,online}], pendentesIn:[{id,from}], pendentesOut:[{id,to}]}
 */
export function renderAmigos({ zonaPedidos, listaAmigos }, dados, { aoAbrir, aoAceitar, aoRecusar }) {
  zonaPedidos.replaceChildren();

  for (const pedido of dados.pendentesIn) {
    const linha = el('div', ['pedido']);
    linha.append(el('span', ['avatar'], inicialDe(pedido.from.username)));
    const info = el('div', ['pedido-info']);
    info.append(el('span', ['pedido-nome'], pedido.from.username));
    info.append(el('span', ['pedido-sub'], 'Pediu-lhe amizade'));
    const aceitar = el('button', ['btn btn-primary btn-sm'], 'Aceitar');
    aceitar.type = 'button';
    aceitar.dataset.rid = pedido.id;
    aceitar.addEventListener('click', () => aoAceitar(pedido.id));
    const recusar = el('button', ['btn btn-sm'], 'Recusar');
    recusar.type = 'button';
    recusar.dataset.rid = pedido.id;
    recusar.addEventListener('click', () => aoRecusar(pedido.id));
    linha.append(info, aceitar, recusar);
    zonaPedidos.appendChild(linha);
  }

  if (dados.pendentesOut.length > 0) {
    const zonaFora = el('div', ['pedidos-fora']);
    zonaFora.append(el('span', ['pedidos-fora-titulo'], 'À espera de resposta:'));
    for (const p of dados.pendentesOut) {
      const linha = el('div', ['pedido']);
      linha.append(el('span', ['avatar'], inicialDe(p.to.username)));
      const info = el('div', ['pedido-info']);
      info.append(el('span', ['pedido-nome'], p.to.username));
      info.append(el('span', ['pedido-sub'], 'Pedido enviado por si'));
      const cancelar = el('button', ['btn btn-sm'], 'Cancelar');
      cancelar.type = 'button';
      cancelar.dataset.rid = p.id;
      cancelar.addEventListener('click', () => aoRecusar(p.id));
      linha.append(info, cancelar);
      zonaFora.appendChild(linha);
    }
    zonaPedidos.appendChild(zonaFora);
  }

  listaAmigos.replaceChildren();
  if (dados.amigos.length === 0) {
    listaAmigos.appendChild(
      el('li', ['vazio-lista'], 'Ainda não tem amigos. Adicione alguém pelo nome exato acima.'),
    );
    return;
  }
  for (const amigo of dados.amigos) {
    const li = el('li', ['item']);
    li.dataset.id = amigo.id;
    li.setAttribute('role', 'button');
    li.tabIndex = 0;
    li.addEventListener('click', () => aoAbrir(amigo.id));
    li.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        aoAbrir(amigo.id);
      }
    });
    const avatar = el('span', ['avatar'], inicialDe(amigo.username));
    const ponto = el('span', ['dot', amigo.online ? 'on' : '']);
    avatar.appendChild(ponto);
    li.append(avatar, el('span', ['item-nome'], amigo.username));
    listaAmigos.appendChild(li);
  }
}

// ---- vista de conversa --------------------------------------------------------------

const SVG_ENVIAR =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11.5 21 3l-6.5 18-3-7.5z" fill="currentColor"/></svg>';
const SVG_VOLTAR =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 6l-6 6 6 6" fill="none" stroke="currentColor" ' +
  'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * Monta a vista de conversa em `main` e devolve referências para atualizações
 * sem recriar o DOM (o campo de escrita e o foco permanecem).
 */
export function montarVistaConversa(main, { nome, subtitulo, online, ehGrupo, estadoWs }) {
  const raiz = el('div', ['chat']);

  const cabeca = el('header', ['chat-head']);
  const voltar = el('button', ['icon-btn btn-voltar']);
  voltar.type = 'button';
  voltar.setAttribute('aria-label', 'Voltar às conversas');
  voltar.innerHTML = SVG_VOLTAR;
  const ident = el('div', ['chat-ident']);
  const avatar = el('span', ['avatar', ehGrupo ? 'avatar-grp' : ''], inicialDe(nome));
  const ponto = el('span', ['dot', online ? 'on' : '']);
  avatar.appendChild(ponto);
  const nomes = el('div');
  nomes.style.minWidth = '0';
  const h2 = el('h2', ['chat-nome'], nome);
  const sub = el('p', ['chat-sub']);
  const textoSub = el('span', [], subtitulo);
  sub.append(textoSub);
  nomes.append(h2, sub);
  ident.append(avatar, nomes);
  const pill = el('span', ['ws-pill'], rotuloEstadoWs(estadoWs));
  if (estadoWs === 'online') pill.classList.add('on');
  if (estadoWs === 'reconnecting' || estadoWs === 'connecting') pill.classList.add('warn');
  cabeca.append(voltar, ident, pill);

  const area = el('div', ['chat-msgs']);
  area.setAttribute('role', 'log');
  area.setAttribute('aria-label', 'Mensagens da conversa');
  const maisBtn = el('button', ['btn btn-ghost btn-sm carregar-mais'], 'Carregar mensagens antigas');
  maisBtn.type = 'button';
  maisBtn.hidden = true;
  area.appendChild(maisBtn);
  const vazioChat = el('p', ['vazio-chat'], 'Ainda não há mensagens. Diga olá!');
  vazioChat.hidden = true;
  area.appendChild(vazioChat);

  const composer = el('form', ['chat-composer']);
  const campo = el('input', ['input']);
  campo.type = 'text';
  campo.maxLength = 2000;
  campo.placeholder = 'Escreva uma mensagem…';
  campo.autocomplete = 'off';
  campo.setAttribute('aria-label', 'Nova mensagem');
  const enviar = el('button', ['btn-enviar']);
  enviar.type = 'submit';
  enviar.setAttribute('aria-label', 'Enviar mensagem');
  enviar.innerHTML = SVG_ENVIAR;
  composer.append(campo, enviar);

  raiz.append(cabeca, area, composer);
  main.replaceChildren(raiz);

  return {
    raiz,
    voltar,
    avatar,
    ponto,
    h2,
    textoSub,
    pill,
    area,
    maisBtn,
    vazioChat,
    campo,
    enviar,
    composer,
  };
}

export function rotuloEstadoWs(estado) {
  if (estado === 'online') return 'Ligado';
  if (estado === 'connecting' || estado === 'reconnecting') return 'A religar…';
  if (estado === 'dead') return 'Sessão expirada';
  return 'Desligado';
}

/** Atualiza a pílula de estado da ligação na conversa aberta. */
export function definirEstadoWs(refs, estado) {
  refs.pill.textContent = rotuloEstadoWs(estado);
  refs.pill.classList.toggle('on', estado === 'online');
  refs.pill.classList.toggle('warn', estado === 'connecting' || estado === 'reconnecting');
  refs.enviar.disabled = estado !== 'online';
}

/** Cabeçalho da conversa (nome/subtítulo/presença) sem recriar a vista. */
export function definirCabecalho(refs, { nome, subtitulo, online }) {
  refs.h2.textContent = nome;
  refs.textoSub.textContent = subtitulo;
  refs.ponto.classList.toggle('on', Boolean(online));
}

function nodoMensagem(refs, mensagem, { euId, ehGrupo }) {
  const propria = mensagem.userId === euId || mensagem.fromUserId === euId;
  const linha = el('div', ['msg', propria ? 'own' : 'outro']);
  const bolha = el('div', ['msg-bolha']);
  if (!propria && ehGrupo && mensagem.fromName) {
    bolha.appendChild(el('span', ['msg-autor'], mensagem.fromName));
  }
  bolha.appendChild(el('span', ['msg-texto'], mensagem.text));
  bolha.appendChild(el('span', ['msg-hora'], horaDe(mensagem.ts)));
  linha.appendChild(bolha);
  return linha;
}

function horaDe(ts) {
  const data = new Date(ts);
  return Number.isNaN(data.getTime())
    ? ''
    : data.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });
}

/** Acrescenta uma mensagem ao fim da conversa aberta e mantém o vazio oculto. */
export function adicionarMensagemChat(refs, mensagem, { euId, ehGrupo }) {
  const nodo = nodoMensagem(refs, mensagem, { euId, ehGrupo });
  refs.area.appendChild(nodo);
  refs.vazioChat.hidden = true;
  return nodo;
}

/**
 * Reconstrói toda a lista de mensagens (usado ao abrir a conversa).
 * `mensagens` está em ordem antiga→nova; rola para o fundo sem animação.
 */
export function renderMensagens(refs, mensagens, { euId, ehGrupo }) {
  for (const nodo of [...refs.area.children]) {
    if (!nodo.classList.contains('carregar-mais') && !nodo.classList.contains('vazio-chat')) {
      nodo.remove();
    }
  }
  for (const mensagem of mensagens) {
    adicionarMensagemChat(refs, mensagem, { euId, ehGrupo });
  }
  refs.vazioChat.hidden = mensagens.length > 0;
  refs.area.style.scrollBehavior = 'auto';
  refs.area.scrollTop = refs.area.scrollHeight;
  refs.area.style.scrollBehavior = '';
}

/** Mostra/esconde o botão “Carregar mensagens antigas”. */
export function maisBtnEstado(refs, temMais) {
  refs.maisBtn.hidden = !temMais;
}

/**
 * Insere mensagens antigas no TOPO da conversa aberta, mantendo a primeira
 * mensagem visível na mesma posição do ecrã (rolagem por âncora).
 * `antigas` está em ordem antiga→nova.
 */
export function inserirMensagensAntigas(refs, antigas, { euId, ehGrupo }) {
  if (antigas.length === 0) return;
  const primeiro = [...refs.area.children].find((n) => n.classList.contains('msg'));
  const topoAntes = primeiro ? primeiro.getBoundingClientRect().top : null;
  const ancora = primeiro ?? null;
  for (const mensagem of antigas) {
    const nodo = nodoMensagem(refs, mensagem, { euId, ehGrupo });
    if (ancora) refs.area.insertBefore(nodo, ancora);
    else refs.area.appendChild(nodo);
  }
  refs.vazioChat.hidden = true;
  if (topoAntes != null && primeiro) {
    refs.area.style.scrollBehavior = 'auto';
    refs.area.scrollTop += primeiro.getBoundingClientRect().top - topoAntes;
    refs.area.style.scrollBehavior = '';
  }
}

// ---- modal de grupo -----------------------------------------------------------------

/** Criação de grupo: título + seleção de amigos (checkboxes). */
export function abrirModalGrupo({ amigos, aoCriar, aoFechar }) {
  const overlay = el('div', ['modal']);
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Criar grupo');

  const cartao = el('div', ['modal-card']);
  cartao.appendChild(el('h2', ['modal-titulo'], 'Criar grupo'));

  const campoTitulo = el('input', ['input']);
  campoTitulo.type = 'text';
  campoTitulo.maxLength = 60;
  campoTitulo.placeholder = 'Nome do grupo (opcional)';
  campoTitulo.setAttribute('aria-label', 'Nome do grupo');
  cartao.appendChild(campoTitulo);

  const lista = el('div', ['modal-lista']);
  const caixas = [];
  if (amigos.length === 0) {
    lista.appendChild(el('p', ['vazio-lista'], 'Adicione amigos primeiro para criar um grupo.'));
  }
  for (const amigo of amigos) {
    const linha = el('label', ['modal-membro']);
    const caixa = document.createElement('input');
    caixa.type = 'checkbox';
    caixa.value = amigo.id;
    caixas.push(caixa);
    linha.append(caixa, el('span', ['item-nome'], amigo.username));
    lista.appendChild(linha);
  }
  cartao.appendChild(lista);

  const erro = el('p', ['form-erro']);
  erro.hidden = true;
  cartao.appendChild(erro);

  const acoes = el('div', ['modal-acoes']);
  const cancelar = el('button', ['btn'], 'Cancelar');
  cancelar.type = 'button';
  const criar = el('button', ['btn btn-primary'], 'Criar grupo');
  criar.type = 'button';
  acoes.append(cancelar, criar);
  cartao.appendChild(acoes);

  function fechar() {
    overlay.remove();
    document.removeEventListener('keydown', noEscape);
    if (aoFechar) aoFechar();
  }
  function noEscape(ev) {
    if (ev.key === 'Escape') fechar();
  }
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) fechar();
  });
  document.addEventListener('keydown', noEscape);
  cancelar.addEventListener('click', fechar);
  criar.addEventListener('click', () => {
    const ids = caixas.filter((c) => c.checked).map((c) => c.value);
    if (ids.length < 2) {
      erro.hidden = false;
      erro.textContent = 'Selecione pelo menos dois amigos para o grupo';
      return;
    }
    erro.hidden = true;
    aoCriar(ids, campoTitulo.value.trim(), fechar);
  });

  overlay.appendChild(cartao);
  document.body.appendChild(overlay);
  campoTitulo.focus();
}
