/**
 * movie.js — Sessão de Filme (Task 10).
 *
 * Sincronia anfitrião-autoritativa (envelopes da Task 8, src/session.js). O anfitrião escolhe um
 * ficheiro LOCAL (MP4/WebM → URL.createObjectURL; o ficheiro NUNCA viaja pelo WS, só metadados) e
 * controla a reprodução com session_control {play|pause|seek, positionSec, atMs}. O convidado
 * aceita o convite num único diálogo onde escolhe o SEU ficheiro: nome + duração (±2 s) comparados
 * com os do anfitrião — divergência avisa mas permite entrar; sem ficheiro → modo "só conversa".
 * Drift (convidado, a cada 2 s): se o currentTime divergir ≥1,5 s da posição esperada (positionSec
 * + decorrido desde atMs quando a tocar), faz seek para essa posição — o anfitrião é a fonte da
 * verdade; convidados NÃO têm controles. Formato não suportado (MKV/AVI): o <video> falha o load
 * (evento error) → aviso PT. O convite não traz o id do anfitrião: o nome do convite fica na lista
 * de participantes como anfitrião. Reutiliza ajudantes de UI de call.js.
 */

import { toast } from './ui/views.js';
import { seletorCatalogo } from './ui/catalogo.js';
import { botaoLegendas, botaoTelaCheia } from './ui/legendas.js';
import { mostrarChip, removerChip, abrirModal, botao, nodo, restaurarZonaPrincipal } from './call.js';

const INTERVALO_DRIFT_MS = 2000;
const TOLERANCIA_DRIFT_S = 1.5;
const TOLERANCIA_DURACAO_S = 2;
const ACOES = new Set(['play', 'pause', 'seek']);
const AVISO_FORMATO =
  'Formato de vídeo não suportado — use MP4 ou WebM. O navegador não conseguiu ler o ficheiro; ' +
  'converta-o (por exemplo, para MP4 H.264) e tente novamente.';
let ws = null;
let euId = null;
let sessao = null; // sessão ativa nesta aba, ou null
const soltarHandlers = []; // anulam os handlers registados no WsClient atual

// ---- ajudantes puros (verificados pelos testes do cliente) ---------------------

/** Duração legível: 3725 → "1:02:05", 154 → "2:34", inválido → "—". */
export function rotuloDuracao(segundos) {
  if (typeof segundos !== 'number' || !Number.isFinite(segundos) || segundos < 0) return '—';
  const total = Math.round(segundos);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const dois = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${dois(m)}:${dois(s)}` : `${m}:${dois(s)}`;
}

/** Compara o ficheiro local com o do anfitrião: {fileMatches, divergencias[]}. */
export function avaliarFicheiro(meu, anfitriao) {
  const divergencias = [];
  if (String(meu?.nome ?? '').trim().toLowerCase() !== String(anfitriao?.nome ?? '').trim().toLowerCase()) {
    divergencias.push(`Nome diferente — o seu: "${meu?.nome ?? '?'}", o do anfitrião: "${anfitriao?.nome ?? '?'}".`);
  }
  const dMeu = meu?.duracaoSec;
  const dDele = anfitriao?.duracaoSec;
  if (typeof dMeu !== 'number' || typeof dDele !== 'number' || Math.abs(dMeu - dDele) > TOLERANCIA_DURACAO_S) {
    divergencias.push(
      `Duração diferente — a sua: ${rotuloDuracao(dMeu)}, a do anfitrião: ${rotuloDuracao(dDele)} (tolerância ±2 s).`,
    );
  }
  return { fileMatches: divergencias.length === 0, divergencias };
}

/** Posição esperada AGORA: positionSec + tempo decorrido quando a tocar. */
export function esperadoPosicao(ultimo, agoraMs) {
  if (!ultimo || typeof ultimo.positionSec !== 'number' || !Number.isFinite(ultimo.positionSec)) return 0;
  if (ultimo.action !== 'play') return ultimo.positionSec;
  const agora = typeof agoraMs === 'number' ? agoraMs : Date.now();
  const inicio = typeof ultimo.atMs === 'number' ? ultimo.atMs : agora;
  return ultimo.positionSec + Math.max(0, agora - inicio) / 1000;
}

/** |atual − esperada| em segundos; 0 sem controlo conhecido ou valor inválido. */
export function driftSegundos(atual, ultimo, agoraMs) {
  if (typeof atual !== 'number' || !Number.isFinite(atual)) return 0;
  return Math.abs(atual - esperadoPosicao(ultimo, agoraMs));
}

// ---- arranque -------------------------------------------------------------------

/** Liga o módulo ao WsClient atual e publica o gancho MV.criarSessaoFilme. */
export function iniciarSessoesFilme() {
  const MV = globalThis.window?.MV;
  const cliente = MV?.obterWs?.();
  const utilizador = MV?.obterEstado?.()?.utilizador;
  if (!cliente || !utilizador) return;
  if (cliente === ws && euId === utilizador.id) return; // já ligado a esta sessão
  for (const soltar of soltarHandlers) soltar();
  soltarHandlers.length = 0;
  ws = cliente;
  euId = utilizador.id;
  for (const [tipo, fn] of [
    ['session_created', aoCreated], ['session_invite', aoInvite], ['session_member', aoMember],
    ['session_control', aoControl], ['session_ended', aoEnded], ['error', aoErro],
    ['session_stream', aoStream], // v1.1: transmissão WebRTC do ficheiro
    ['session_active', aoSessionActive], ['session_state', aoSessionState], // v1.2
  ]) soltarHandlers.push(ws.on(tipo, fn));
  MV.criarSessaoFilme = iniciarDaConversa;
  MV.criarSessaoDoCatalogo = iniciarDoCatalogo; // v1.1: Home do catálogo
  MV.aoSair?.(() => { if (sessao) terminarSessao(); });
}

/**
 * Catálogo (v1.1): cria uma sessão a partir de um filme escolhido na Home.
 * Usa a conversa ATIVA para os convidados; exige uma conversa aberta.
 */
export function iniciarDoCatalogo(item) {
  if (sessao) return toast('Já está numa sessão de filme — saia dela primeiro.', 'erro');
  // v1.2: consulta o estado — se já houver sessão ativa, ENTRA nela.
  consultarEstado((ativa) => {
    if (ativa) return modalEntrarSessaoAtiva(ativa);
    const estado = MV?.obterEstado?.();
    const conv = (estado?.conversas ?? []).find((c) => c.id === estado?.ativa);
    if (!conv) return toast('Abre uma conversa primeiro (Conversas → escolhe o amigo) e volta ao catálogo.', 'info');
    const convidados = (conv.memberIds ?? []).filter((id) => id !== euId);
    if (convidados.length === 0) return toast('Não há ninguém para convidar nesta conversa.', 'erro');
    abrirModalAnfitriao(conv, convidados, { url: item.url, titulo: item.titulo });
  });
}

// ---- utilitários -------------------------------------------------------------------

function nomeDe(id) {
  return globalThis.window?.MV?.obterEstado?.()?.amigos?.get(id)?.username ?? 'Participante';
}
function euNome() {
  return globalThis.window?.MV?.obterEstado?.()?.utilizador?.username ?? 'Você';
}
function novaSessao(parcial) {
  return {
    id: parcial.id, papel: parcial.papel,
    titulo: parcial.titulo ?? 'Sessão de filme', fileName: parcial.fileName ?? '',
    durationSec: parcial.durationSec ?? 0, convId: parcial.convId ?? null,
    ficheiro: parcial.ficheiro ?? null, objectUrl: null,
    movieUrl: parcial.movieUrl ?? null,
    fileMatches: Boolean(parcial.fileMatches), membros: new Map(),
    streams: new Map(), // v1.1: RTC por convidado (transmissão do ficheiro)
    ultimoControle: null, refs: null, chip: null, timer: null, avisouAutoplay: false,
  };
}

/** Mede nome/duração de um File local; null quando o navegador não o lê. */
function prepararFicheiro(file) {
  return new Promise((resolve) => {
    const v = nodo('video');
    v.preload = 'metadata';
    const url = URL.createObjectURL(file);
    let decidido = false;
    const falha = () => { if (decidido) return; decidido = true; URL.revokeObjectURL(url); resolve(null); };
    v.onerror = falha; // MKV/AVI: o <video> falha o load → aviso de formato
    v.onloadedmetadata = () => {
      if (decidido) return;
      decidido = true;
      const d = v.duration;
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(d) && d > 0 ? { nome: file.name, duracaoSec: d, file } : null);
    };
    v.src = url;
  });
}

/** Mede a duração de um vídeo por URL direta (http/https); null se falhar. */
function medirUrl(url) {
  return new Promise((resolve) => {
    const v = nodo('video');
    v.preload = 'metadata';
    let decidido = false;
    const falha = () => {
      if (decidido) return;
      decidido = true;
      clearTimeout(timer);
      resolve(null);
    };
    const timer = setTimeout(falha, 15000); // link lento ou pendurado
    v.onerror = falha;
    v.onloadedmetadata = () => {
      if (decidido) return;
      decidido = true;
      clearTimeout(timer);
      const d = v.duration;
      let nome = 'filme';
      try { nome = decodeURIComponent(new URL(url).pathname.split('/').pop() || nome); } catch {}
      resolve(Number.isFinite(d) && d > 0 ? { nome, duracaoSec: d } : null);
    };
    v.src = url;
  });
}

/** Campo de escolha de ficheiro com o filtro MP4/WebM do enunciado. */
const campoFicheiro = () => Object.assign(nodo('input', 'input'), { type: 'file', accept: 'video/mp4,video/webm' });

// ---- anfitrião: criar a sessão ------------------------------------------------------

function iniciarDaConversa(conv) {
  if (sessao) return toast('Já está numa sessão de filme — saia dela primeiro.', 'erro');
  // v1.2: consulta o estado — se já houver sessão ativa, ENTRA nela.
  consultarEstado((ativa) => {
    if (ativa) return modalEntrarSessaoAtiva(ativa);
    const convidados = (conv?.memberIds ?? []).filter((id) => id !== euId);
    if (convidados.length === 0) return toast('Não há ninguém para convidar nesta conversa.', 'erro');
    abrirModalAnfitriao(conv, convidados);
  });
}

function abrirModalAnfitriao(conv, convidados, prefilhe = null) {
  const campoTitulo = Object.assign(nodo('input', 'input'), { maxLength: 60, placeholder: 'Título da sessão (opcional)' });
  const campo = campoFicheiro();
  const campoLink = Object.assign(nodo('input', 'input'), {
    type: 'url', maxLength: 2048, placeholder: 'https://…/filme.mp4 (link direto MP4/WebM)',
  });
  const ficha = nodo('p', 'hint');
  const aviso = nodo('p', 'form-erro');
  aviso.hidden = true;
  const rotuloTitulo = nodo('label', 'label', 'Título');
  rotuloTitulo.appendChild(campoTitulo);
  const rotuloFicheiro = nodo('label', 'label', 'Ficheiro do filme (MP4 ou WebM)');
  rotuloFicheiro.append(campo, ficha);
  const rotuloLink = nodo('label', 'label', 'Ou um LINK direto do filme (Archive.org, R2, Supabase…)');
  rotuloLink.appendChild(campoLink);
  rotuloLink.appendChild(seletorCatalogo((item) => {
    campoLink.value = item.url;
    campoTitulo.value = campoTitulo.value || item.titulo;
    atualizarEstadoCriar();
  }));
  const nota = nodo('p', 'form-nota', `Convida: ${convidados.map((id) => nomeDe(id)).join(', ')}`);
  const criar = botao('Criar sessão', 'btn btn-primary');
  const modal = abrirModal({
    titulo: 'Sessão de filme',
    corpo: [rotuloTitulo, rotuloFicheiro, rotuloLink, aviso, nota],
    acoes: [criar],
  });
  // Cancelar precisa do modal.fechar — criado DEPOIS de abrirModal devolver.
  const cancelar = botao('Cancelar', 'btn', () => modal.fechar());
  modal.overlay.querySelector('.modal-acoes')?.prepend(cancelar);
  criar.disabled = true;
  let medido = null; // ficheiro local medido
  let urlMedida = null; // {nome, duracaoSec} do link medido
  if (prefilhe?.url) {
    // Vindo do catálogo: link e título pré-preenchidos.
    campoLink.value = prefilhe.url;
    campoTitulo.value = prefilhe.titulo || '';
    atualizarEstadoCriar();
  }
  function modoEmUso() {
    return campoLink.value.trim() !== '' ? 'link' : 'ficheiro';
  }
  async function atualizarEstadoCriar() {
    if (modoEmUso() === 'link') {
      medido = null;
      const link = campoLink.value.trim();
      urlMedida = await medirUrl(link);
      if (!urlMedida) {
        aviso.hidden = false;
        aviso.textContent = 'Não foi possível ler o vídeo desse link (tem de ser MP4/WebM direto e público).';
        ficha.textContent = '';
        criar.disabled = true;
        return;
      }
      aviso.hidden = true;
      ficha.textContent = `Link OK — ${rotuloDuracao(urlMedida.duracaoSec)} (todos veem esta cópia)`;
      criar.disabled = false;
      return;
    }
    urlMedida = null;
    if (!medido) {
      criar.disabled = true;
      ficha.textContent = '';
      return;
    }
    aviso.hidden = true;
    ficha.textContent = `${medido.nome} — ${rotuloDuracao(medido.duracaoSec)}`;
    criar.disabled = false;
  }
  campoLink.addEventListener('input', () => { campo.value = ''; atualizarEstadoCriar(); });
  campo.addEventListener('change', async () => {
    if (campo.files?.[0]) campoLink.value = '';
    const file = campo.files?.[0];
    medido = file ? await prepararFicheiro(file) : null;
    if (!medido) {
      aviso.hidden = false;
      aviso.textContent = AVISO_FORMATO; // o <video> falhou o load do ficheiro
      ficha.textContent = '';
      criar.disabled = true;
      return;
    }
    aviso.hidden = true;
    ficha.textContent = `${medido.nome} — ${rotuloDuracao(medido.duracaoSec)}`;
    criar.disabled = false;
  });
  criar.addEventListener('click', () => {
    if (modoEmUso() === 'link') {
      if (!urlMedida) return;
      sessao = novaSessao({
        papel: 'anfitriao', id: null, titulo: campoTitulo.value.trim() || urlMedida.nome,
        fileName: urlMedida.nome, durationSec: urlMedida.duracaoSec, convId: conv.id,
        ficheiro: null, movieUrl: campoLink.value.trim(), fileMatches: true,
      });
      modal.fechar();
      const ok = ws?.send({
        type: 'session_create', title: sessao.titulo, fileName: sessao.fileName,
        durationSec: sessao.durationSec, toUserIds: convidados, movieUrl: sessao.movieUrl,
      });
      if (!ok) {
        toast('Sem ligação ao servidor — a sessão não foi criada.', 'erro');
        sessao = null;
      }
      return;
    }
    if (!medido) return;
    sessao = novaSessao({
      papel: 'anfitriao', id: null, titulo: campoTitulo.value.trim() || medido.nome,
      fileName: medido.nome, durationSec: medido.duracaoSec, convId: conv.id,
      ficheiro: medido.file, fileMatches: true,
    });
    modal.fechar();
    const ok = ws?.send({
      type: 'session_create', title: sessao.titulo, fileName: sessao.fileName, durationSec: sessao.durationSec, toUserIds: convidados,
    });
    if (!ok) {
      toast('Sem ligação ao servidor — a sessão não foi criada.', 'erro');
      sessao = null;
    }
  });
}

function aoCreated(envelope) {
  if (!sessao || sessao.papel !== 'anfitriao' || sessao.id) return;
  if (typeof envelope.sessionId !== 'string') return;
  sessao.id = envelope.sessionId;
  if (typeof envelope.title === 'string') sessao.titulo = envelope.title;
  if (typeof envelope.fileName === 'string') sessao.fileName = envelope.fileName;
  if (typeof envelope.durationSec === 'number') sessao.durationSec = envelope.durationSec;
  if (typeof envelope.movieUrl === 'string') sessao.movieUrl = envelope.movieUrl;
  sessao.membros.set(euId, { username: euNome(), fileMatches: true });
  montarVista();
}

// ---- convidado: convite único (informação + ficheiro + entrar) ------------------------

function aoInvite(invite) {
  const { sessionId, fromName, title, fileName, durationSec } = invite;
  if (typeof sessionId !== 'string' || sessao) return; // já numa sessão — convite ignorado

  // Sessão por LINK (v1.1): todos carregam a mesma cópia — sem ficheiro local.
  if (typeof invite.movieUrl === 'string' && invite.movieUrl !== '') {
    const modal = abrirModal({
      titulo: 'Convite para sessão de filme',
      corpo: [
        nodo('p', '', `${fromName ?? 'Um amigo'} convidou-o para ver "${title ?? 'um filme'}".`),
        nodo('p', 'hint', 'Transmissão por link: todos veem a MESMA cópia — não precisa de ficheiro local.'),
      ],
      acoes: [
        botao('Recusar', 'btn', () => modal.fechar()),
        botao('Entrar', 'btn btn-primary', () => {
          modal.fechar();
          juntar(invite, null, true, invite.movieUrl);
        }),
      ],
      bloqFora: true,
    });
    return;
  }

  const campo = campoFicheiro();
  const resultado = nodo('p', 'hint');
  const aviso = nodo('p', 'form-erro');
  aviso.hidden = true;
  const rotulo = nodo('label', 'label', 'O seu ficheiro local (MP4 ou WebM) — opcional');
  rotulo.append(campo, resultado);
  const entrar = botao('Entrar', 'btn btn-primary');
  entrar.disabled = true;
  let medido = null;
  const modal = abrirModal({
    titulo: 'Convite para sessão de filme',
    corpo: [
      nodo('p', '', `${fromName ?? 'Um amigo'} convidou-o para ver "${title ?? 'um filme'}".`),
      nodo('p', 'hint', `Ficheiro do anfitrião: ${fileName ?? '?'} — ${rotuloDuracao(durationSec)}`),
      rotulo, aviso,
    ],
    acoes: [
      botao('Recusar', 'btn', () => modal.fechar()), // v1 sem recusa no protocolo: silencioso
      botao('Entrar sem ficheiro', 'btn', () => {
        modal.fechar();
        juntar(invite, null, false);
      }),
      entrar,
    ],
    bloqFora: true,
  });
  campo.addEventListener('change', async () => {
    const file = campo.files?.[0];
    medido = file ? await prepararFicheiro(file) : null;
    if (!medido) {
      aviso.hidden = false;
      aviso.textContent = AVISO_FORMATO;
      resultado.textContent = 'Pode entrar sem ficheiro (modo só conversa) ou escolher outro.';
      entrar.dataset.modo = 'sem';
      entrar.disabled = false;
      return;
    }
    aviso.hidden = true;
    const analise = avaliarFicheiro(medido, { nome: fileName, duracaoSec: durationSec });
    if (analise.fileMatches) {
      resultado.textContent = `Ficheiro compatível ✓ — ${medido.nome} (${rotuloDuracao(medido.duracaoSec)}).`;
    } else {
      aviso.textContent = ['O ficheiro pode não ser o mesmo do anfitrião:', ...analise.divergencias].join(' ');
      aviso.hidden = false;
      resultado.textContent = 'Pode entrar na mesma, mas o vídeo pode dessincronizar.';
    }
    entrar.dataset.modo = 'com';
    entrar.disabled = false;
  });
  entrar.addEventListener('click', () => {
    modal.fechar();
    if (entrar.dataset.modo === 'com' && medido) juntar(invite, medido, true);
    else juntar(invite, null, false);
  });
}
function juntar(invite, ficheiro, fileMatches, movieUrl = null) {
  sessao = novaSessao({
    papel: 'convidado', id: invite.sessionId, titulo: invite.title,
    fileName: invite.fileName, durationSec: invite.durationSec, convId: null,
    ficheiro: ficheiro?.file ?? null, fileMatches, movieUrl,
  });
  const anfitriao = `${invite.fromName || 'Anfitrião'} (anfitrião)`;
  sessao.membros.set('__anfitriao__', { username: anfitriao, fileMatches: true }); // sempre tem o ficheiro
  if (!ws?.send({ type: 'session_join', sessionId: sessao.id, fileMatches })) {
    toast('Sem ligação ao servidor — não entrou na sessão.', 'erro');
    sessao = null;
    return;
  }
  montarVista();
}
// ---- envelopes de estado e controlo ----------------------------------------------------

function aoMember(envelope) {
  if (!sessao || envelope.sessionId !== sessao.id || typeof envelope.userId !== 'string') return;
  sessao.membros.set(envelope.userId, {
    username: envelope.username ?? nomeDe(envelope.userId),
    fileMatches: Boolean(envelope.fileMatches),
  });
  if (envelope.userId === euId) sessao.fileMatches = Boolean(envelope.fileMatches);
  atualizarMembros();
  // v1.1 — TRANSMISSÃO: convidado sem ficheiro numa sessão de ficheiro
  // local? O anfitrião oferece o stream dele (WebRTC) a esse convidado.
  if (sessao.papel === 'anfitriao' && !envelope.fileMatches && sessao.ficheiro && sessao.refs?.video) {
    oferecerTransmissao(envelope.userId);
  }
}
function aoControl(envelope) {
  if (!sessao || envelope.sessionId !== sessao.id) return;
  const { action, positionSec, atMs } = envelope;
  if (!ACOES.has(action) || typeof positionSec !== 'number' || typeof atMs !== 'number') return;
  sessao.ultimoControle = { action, positionSec, atMs };
  aplicarNoVideo(action, positionSec);
}

/** Aplica um controlo ao <video> local (anfitrião incluído — eco idempotente). */
function aplicarNoVideo(action, positionSec) {
  const v = sessao?.refs?.video;
  if (!v) return;
  // Transmissão (v1.1): o convidado vê o FEED ao vivo do anfitrião — os
  // controles do anfitrião já se refletem no stream; seek local é sem sentido.
  if (v.srcObject) return;
  if (action === 'seek') { v.currentTime = positionSec; return; }
  if (action === 'pause') {
    v.pause();
    if (Math.abs(v.currentTime - positionSec) > 0.3) v.currentTime = positionSec;
    return;
  }
  if (Math.abs(v.currentTime - positionSec) > 0.3) v.currentTime = positionSec;
  v.play?.()?.catch?.(() => {
    if (sessao?.avisouAutoplay) return;
    sessao.avisouAutoplay = true;
    toast('Toque no vídeo para autorizar a reprodução com som.', 'info');
  });
}
// ---- v1.2: SESSÃO ÚNICA — consultar estado e ENTRAR na sessão ativa ---------

let aguardandoEstado = null; // callback one-shot do consultarEstado

/** Pergunta ao servidor "existe sessão ativa?" e chama sequa(ativaOuNull). */
function consultarEstado(sequa) {
  aguardandoEstado = sequa;
  ws?.send({ type: 'session_state' });
  // Rede de segurança: sem resposta em 3 s, segue como se não houvesse sessão.
  setTimeout(() => {
    if (aguardandoEstado === sequa) { aguardandoEstado = null; sequa(null); }
  }, 3000);
}

function aoSessionState(envelope) {
  const sequa = aguardandoEstado;
  aguardandoEstado = null;
  sequa?.(envelope.ativa ?? null);
}

/** Modal "já existe sessão ativa" → ENTRAR na que está a decorrer. */
function modalEntrarSessaoAtiva(ativa) {
  const doc = globalThis.document;
  const nota = doc.createElement('p');
  nota.className = 'form-nota';
  nota.textContent = ativa.origem === 'link'
    ? 'Vais ver a MESMA cópia (link) em sincronia — não precisas de ficheiro.'
    : 'O anfitrião vai TRANSMITIR o ficheiro dele para ti — não precisas de ficheiro.';
  const entrar = botao('Entrar na sessão', 'btn btn-primary', () => {
    modal.fechar();
    juntar(
      { sessionId: ativa.sessionId, title: ativa.title, fileName: ativa.title, durationSec: 0, movieUrl: ativa.movieUrl ?? null },
      null,
      true,
      ativa.movieUrl ?? null,
    );
  });
  const modal = abrirModal({
    titulo: 'Já existe uma sessão ativa',
    corpo: [
      doc.createRange().createContextualFragment(
        `<p><strong>${ativa.title}</strong> — anfitrião: ${ativa.hostName}</p>`,
      ).firstChild,
      nota,
    ],
    acoes: [botao('Cancelar', 'btn', () => modal.fechar()), entrar],
    bloqFora: true,
  });
}

// Envelope do servidor (create bloqueado pela regra de sessão única).
function aoSessionActive(envelope) {
  if (sessao) return; // já estou numa sessão
  modalEntrarSessaoAtiva(envelope);
}

// ---- v1.1: TRANSMISSÃO do ficheiro do anfitrião (WebRTC) ---------------------

const SERVIDORES_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

/** Anfitrião: oferece o stream do <video> local a um convidado sem ficheiro. */
async function oferecerTransmissao(guestId) {
  const video = sessao?.refs?.video;
  if (!video || !video.captureStream) {
    toast('Este navegador não suporta transmissão do ficheiro (experimenta o Chrome).', 'erro');
    return;
  }
  if (sessao.streams.has(guestId)) return; // já em negociação com este convidado
  try {
    const stream = video.captureStream();
    const pc = new RTCPeerConnection({ iceServers: SERVIDORES_ICE });
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    pc.onicecandidate = (e) => {
      if (e.candidate) ws?.send({
        type: 'session_stream', sessionId: sessao.id,
        toUserId: guestId, dados: { ice: e.candidate.toJSON() },
      });
    };
    const oferta = await pc.createOffer();
    await pc.setLocalDescription(oferta);
    ws?.send({
      type: 'session_stream', sessionId: sessao.id,
      toUserId: guestId, dados: { sdp: pc.localDescription },
    });
    sessao.streams.set(guestId, { pc, respostas: false, gelo: [] });
  } catch (erro) {
    toast('A transmissão falhou a arrancar: ' + erro.message, 'erro');
  }
}

/** Convidado: recebe oferta/ICE do anfitrião e liga o stream ao seu vídeo. */
async function receberTransmissao(deId, dados) {
  if (!sessao?.refs?.video) return;
  const video = sessao.refs.video;
  let pc = sessao.streams.get('host')?.pc;
  if (dados.sdp) {
    pc = pc || novaLigacaoConvidado(deId);
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(dados.sdp));
      const resposta = await pc.createAnswer();
      await pc.setLocalDescription(resposta);
      ws?.send({
        type: 'session_stream', sessionId: sessao.id,
        toUserId: deId, dados: { answer: pc.localDescription },
      });
      for (const gelo of sessao.streams.get('host').gelo.splice(0)) {
        await pc.addIceCandidate(new RTCIceCandidate(gelo)).catch(() => {});
      }
    } catch (erro) {
      toast('Não consegui receber a transmissão: ' + erro.message, 'erro');
    }
    return;
  }
  if (dados.ice && pc) await pc.addIceCandidate(new RTCIceCandidate(dados.ice)).catch(() => {});
}

/** Convidado: cria a ligação de RECEÇÃO e mostra o stream quando chegar. */
function novaLigacaoConvidado(deId) {
  const pc = new RTCPeerConnection({ iceServers: SERVIDORES_ICE });
  pc.ontrack = (e) => {
    const video = sessao?.refs?.video;
    if (!video) return;
    video.srcObject = e.streams[0];
    video.play?.()?.catch?.(() => {
      if (sessao?.avisouAutoplay) return;
      sessao.avisouAutoplay = true;
      toast('Toque no vídeo para autorizar a reprodução com som.', 'info');
    });
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) ws?.send({
      type: 'session_stream', sessionId: sessao.id,
      toUserId: deId, dados: { ice: e.candidate.toJSON() },
    });
  };
  sessao.streams.set('host', { pc, gelo: [] });
  return pc;
}

/** Envelopes session_stream (ambos os papéis). */
function aoStream(envelope) {
  if (!sessao || envelope.sessionId !== sessao.id || !envelope.dados) return;
  if (sessao.papel === 'anfitriao') {
    const ligacao = sessao.streams.get(envelope.fromUserId);
    if (!ligacao) return;
    const { dados } = envelope;
    if (dados.answer && !ligacao.respostas) {
      ligacao.respostas = true;
      ligacao.pc.setRemoteDescription(new RTCSessionDescription(dados.answer)).catch(() => {});
      for (const gelo of ligacao.gelo.splice(0)) {
        ligacao.pc.addIceCandidate(new RTCIceCandidate(gelo)).catch(() => {});
      }
    } else if (dados.ice && ligacao.respostas) {
      ligacao.pc.addIceCandidate(new RTCIceCandidate(dados.ice)).catch(() => {});
    } else if (dados.ice) {
      ligacao.gelo.push(dados.ice); // ICE antes da resposta — fila
    }
    return;
  }
  // Convidado: só aceita stream do ANFITRIÃO.
  if (envelope.fromUserId === sessao.id) return; // (defensivo)
  const anfitriao = [...sessao.membros.keys()].find((id) => id === '__anfitriao__');
  void anfitriao;
  receberTransmissao(envelope.fromUserId, envelope.dados);
}

function aoEnded(envelope) {
  if (!sessao || envelope.sessionId !== sessao.id) return;
  terminarSessao('O anfitrião encerrou a sessão de filme.', false);
}
function aoErro(envelope) {
  if (!sessao) return;
  if (sessao.id === null) sessao = null; // sessão fantasma: session_created nunca chegou — limpar
  const codigos = {
    E_INVALID: 'Pedido de sessão inválido.',
    E_NOTFOUND: 'A sessão de filme já não existe.',
    E_FORBIDDEN: 'Não tem permissão para essa ação na sessão.',
    E_NOT_HOST: 'Apenas o anfitrião controla a reprodução.',
    E_INTERNAL: 'Erro interno do servidor.',
  };
  const texto = codigos[envelope.code];
  if (texto) toast(texto, 'erro');
}
// ---- vista da sessão --------------------------------------------------------------------

function montarVista() {
  const MV = globalThis.window?.MV;
  const doc = globalThis.document;
  const ficha = nodo('p', 'filme-ficha');
  ficha.textContent = `${sessao.fileName} · ${rotuloDuracao(sessao.durationSec)} · ${sessao.papel === 'anfitriao' ? 'você é o anfitrião' : 'convidado'}`;
  const zonaTitulo = nodo('div', 'filme-ident');
  zonaTitulo.append(nodo('h2', 'filme-titulo', sessao.titulo), ficha);
  const verConversa = botao('Ver conversa', 'btn btn-ghost btn-sm', () => {
    const ativa = MV?.obterEstado?.()?.ativa;
    if (ativa) MV.abrirConversa(ativa);
    else toast('Abra uma conversa na barra lateral para conversar.', 'info');
  });
  const sair = botao(sessao.papel === 'anfitriao' ? 'Terminar para todos' : 'Sair da sessão', 'btn btn-perigo btn-sm', pedirSaida);
  const cabeca = nodo('header', 'filme-head');
  cabeca.append(zonaTitulo, verConversa, sair);
  const palco = nodo('div', 'filme-palco');
  let video = null;
  if (sessao.fileMatches && sessao.ficheiro) {
    sessao.objectUrl = URL.createObjectURL(sessao.ficheiro);
    video = nodo('video', 'filme-video');
    video.playsInline = true;
    video.src = sessao.objectUrl;
    video.addEventListener('error', () => palco.replaceChildren(nodoAvisoFormato()));
    palco.appendChild(video);
  } else if (sessao.fileMatches && sessao.movieUrl) {
    // Link direto (Archive/R2/Supabase…): todos carregam a MESMA cópia.
    video = nodo('video', 'filme-video');
    video.playsInline = true;
    video.src = sessao.movieUrl;
    video.addEventListener('error', () => palco.replaceChildren(nodoAvisoFormato()));
    palco.appendChild(video);
  } else if (sessao.fileMatches && sessao.papel === 'convidado') {
    // v1.1 — TRANSMISSÃO: convidado sem ficheiro numa sessão de ficheiro
    // local → espera o stream WebRTC do anfitrião (chega para este <video>).
    video = nodo('video', 'filme-video');
    video.playsInline = true;
    video.muted = true; // autoplay do stream é permitido mudo; som via botão do navegador
    palco.append(
      video,
      nodo('p', 'filme-nota-host', 'A receber a transmissão do anfitrião… (os controles são dele)'),
    );
    video.addEventListener('error', () => palco.replaceChildren(nodoAvisoFormato()));
  } else {
    palco.appendChild(nodoSoConversa());
  }
  const controles = nodo('div', 'filme-controles');
  const tempo = nodo('span', 'filme-tempo', `0:00 / ${rotuloDuracao(sessao.durationSec)}`);
  const barra = montarControles(controles, video, tempo);
  const membros = nodo('div', 'filme-membros');
  membros.setAttribute('aria-label', 'Participantes da sessão');
  const raiz = doc.createElement('div');
  raiz.className = 'filme';
  raiz.append(cabeca, palco, controles, membros);
  sessao.refs = { raiz, video, tempo, barra, membros };
  MV.montarVistaPrincipal(raiz);
  sessao.chip = mostrarChip('🎬 Sessão de filme', () => MV.montarVistaPrincipal(sessao.refs.raiz));
  atualizarMembros();
  iniciarDrift();
  // Um controlo recebido enquanto a vista não existia aplica-se logo ao entrar.
  if (sessao.ultimoControle && video) {
    video.addEventListener('loadedmetadata', () => {
      if (sessao?.ultimoControle) aplicarNoVideo(sessao.ultimoControle.action, sessao.ultimoControle.positionSec);
    }, { once: true });
  }
}

/**
 * Anfitrião: botões + barra de posição. Convidado: só a nota (sem controles).
 * Devolve a barra de posição (ou null para o convidado).
 */
function montarControles(controles, video, tempo) {
  // Guard: o <video> destacado ainda pode disparar timeupdate depois de
  // terminarSessao (sessao = null) — o rótulo simplesmente deixa de atualizar.
  const rotuloTempo = () => {
    if (!sessao) return '';
    return `${rotuloDuracao(video.currentTime)} / ${rotuloDuracao(sessao.durationSec)}`;
  };
  if (sessao.papel !== 'anfitriao') {
    controles.append(nodo('span', 'filme-nota-host', 'A reprodução é controlada pelo anfitrião — não há controles aqui.'), tempo);
    if (video) {
      video.addEventListener('timeupdate', () => { tempo.textContent = rotuloTempo(); });
      // Convidado também tem legendas próprias e tela cheia (v1.1).
      controles.append(botaoLegendas(video), botaoTelaCheia(video));
    }
    return null;
  }
  const barra = Object.assign(globalThis.document.createElement('input'), {
    type: 'range', className: 'filme-barra', min: '0', max: String(sessao.durationSec || 0), step: '0.1',
  });
  barra.setAttribute('aria-label', 'Posição do filme');
  let arrastando = false;
  barra.addEventListener('pointerdown', () => { arrastando = true; });
  barra.addEventListener('change', () => { arrastando = false; controlar('seek', Number(barra.value)); });
  controles.append(nodo('span', 'filme-nota-host', 'Controles do anfitrião'),
    botao('▶ Tocar', 'btn btn-sm', () => controlar('play')),
    botao('⏸ Pausar', 'btn btn-sm', () => controlar('pause')),
    barra, tempo);
  if (video) controles.append(botaoLegendas(video), botaoTelaCheia(video)); // v1.1
  if (video) {
    video.addEventListener('timeupdate', () => {
      tempo.textContent = rotuloTempo();
      if (!arrastando) barra.value = String(video.currentTime);
    });
  }
  return barra;
}

/** Palco em modo só conversa (sem ficheiro) ou aviso de formato (error do <video>). */
function nodoSoConversa() {
  const caixa = nodo('div', 'filme-so-conversa');
  caixa.append(nodo('p', 'filme-modo-titulo', 'Modo só conversa'),
    nodo('p', '', 'O vídeo está oculto porque não escolheu um ficheiro. A conversa e as chamadas continuam disponíveis.'));
  return caixa;
}
const nodoAvisoFormato = () => nodo('div', 'filme-so-conversa form-erro', AVISO_FORMATO);

function atualizarMembros() {
  const zona = sessao?.refs?.membros;
  if (!zona) return;
  zona.replaceChildren();
  const ordenados = [...sessao.membros.entries()].sort((a, b) => (a[0] === euId ? -1 : b[0] === euId ? 1 : 0));
  for (const [id, membro] of ordenados) {
    const papel = id === euId ? (sessao.papel === 'anfitriao' ? '(anfitrião, você)' : '(você)') : '';
    const chipMembro = nodo('span', 'filme-membro', `${membro.username} ${papel}`.trim());
    const rotulo = membro.fileMatches ? 'ficheiro ✓' : 'sem ficheiro';
    chipMembro.appendChild(nodo('span', `filme-ficheiro ${membro.fileMatches ? 'on' : ''}`, rotulo));
    zona.appendChild(chipMembro);
  }
}
// ---- controlos do anfitrião + drift do convidado -------------------------------------------

/** Ação do anfitrião: aplica localmente e difunde ao servidor. */
function controlar(action, positionSec = null) {
  if (!sessao || sessao.papel !== 'anfitriao') return;
  const v = sessao.refs?.video;
  const pos = positionSec ?? (v ? v.currentTime : 0);
  if (action === 'play' && v) v.play?.().catch(() => {});
  if (action === 'pause' && v) v.pause();
  if (action === 'seek' && v) v.currentTime = pos;
  ws?.send({ type: 'session_control', sessionId: sessao.id, action, positionSec: pos, atMs: Date.now() });
}

/** Ciclo de drift do convidado: a cada 2 s, corrige se ≥1,5 s. */
function iniciarDrift() {
  pararDrift();
  sessao.timer = setInterval(() => {
    if (!sessao || sessao.papel === 'anfitriao') return;
    const ultimo = sessao.ultimoControle;
    if (!ultimo || ultimo.action !== 'play') return;
    const v = sessao.refs?.video;
    if (!v || v.readyState < 1) return;
    const agora = Date.now();
    if (driftSegundos(v.currentTime, ultimo, agora) >= TOLERANCIA_DRIFT_S) {
      v.currentTime = esperadoPosicao(ultimo, agora); // correção: posição esperada
    }
  }, INTERVALO_DRIFT_MS);
}
function pararDrift() {
  if (sessao?.timer) {
    clearInterval(sessao.timer);
    sessao.timer = null;
  }
}
function pedirSaida() {
  const pergunta =
    sessao?.papel === 'anfitriao'
      ? 'Isto termina a sessão de filme para TODOS os participantes. Continuar?'
      : 'Na v1 não vai poder voltar a entrar nesta sessão. Sair à mesma?';
  if (!globalThis.confirm(pergunta)) return;
  terminarSessao();
}

/**
 * Sai da sessão: session_leave ao servidor (o anfitrião acaba a sessão para
 * todos via session_ended), timer limpo, objectURL revogado, chip removido e
 * zona principal devolvida ao shell.
 */
function terminarSessao(motivo = null, avisar = true) {
  const atual = sessao;
  if (!atual) return;
  sessao = null;
  pararDrift();
  // Pausa o vídeo ANTES de descartar a vista: sem isto, o elemento destacado
  // continuava a tocar (e a disparar timeupdate) depois do fim da sessão.
  try { atual.refs?.video?.pause(); } catch { /* já parado */ }
  for (const ligacao of atual.streams?.values() ?? []) {
    try { ligacao.pc?.close(); } catch { /* já fechada */ }
  }
  if (avisar && atual.id) ws?.send({ type: 'session_leave', sessionId: atual.id });
  if (atual.timer) clearInterval(atual.timer);
  if (atual.objectUrl) URL.revokeObjectURL(atual.objectUrl);
  removerChip(atual.chip);
  if (atual.refs) restaurarZonaPrincipal(atual.convId);
  if (motivo) toast(motivo, 'erro');
}
