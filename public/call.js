/**
 * call.js — videochamada WebRTC em malha (Task 10).
 *
 * Sinalização sobre o relay puro da Task 7 (src/signal.js): offer, answer e ICE viajam DENTRO de
 * call_signal.data, opacos ao servidor, como {kind:"offer"|"answer"|"ice"|"hello"|"roster"|"join",
 * payload…}. Malha determinística sem glare: em cada par (eu, outro) o ID MENOR cria a oferta
 * (devoOferecer). Para os pares se descobrirem: o convidado ao aceitar envia {kind:"hello",
 * username} ao originador (de call_incoming.fromUserId); o originador responde {kind:"roster",
 * members:[eu + outros já dentro]} e anuncia {kind:"join", userId, username} a quem já está
 * dentro; quem descobre um par onde é o ID menor oferece — exatamente uma oferta por par. ICE
 * pode chegar antes do remote description: fila POR PAR, descarregada após setRemoteDescription.
 * "Encerrar" manda call_end a todos os outros e termina para TODOS; call_end de quem estava
 * dentro encerra; de quem nunca entrou é recusa (remove só esse convite). PC 'failed' de um par
 * (logout/refresh/falha de rede do outro lado): graça curta e a chamada encerra sozinha. No fim
 * TODAS as tracks locais são paradas e todas as RTCPeerConnection fechadas. Fornece os ajudantes
 * de UI partilhados (nodo, botão, modal, chips) usados por movie.js. Sem dependências; nunca
 * regista tokens.
 */

import { toast, mostrarVazio } from './ui/views.js';

const STUN = 'stun:stun.l.google.com:19302';
const MEDIA = 'av';
const LIMITE_TILES = 6; // grelha de vídeos até 6 participantes (regra do controller)

let ws = null;
let euId = null;
let chamada = null; // chamada ativa nesta aba, ou null
const soltarHandlers = []; // anulam os handlers registados no WsClient atual

// ---- ajudantes puros (verificados pelos testes do cliente) ---------------------

/** Regra anti-glare da malha: em cada par, o ID MENOR cria a oferta. */
export function devoOferecer(euId, outroId) {
  return typeof euId === 'string' && typeof outroId === 'string' && euId < outroId;
}

/** Identificador novo: UUID quando existe, alternativa aleatória caso contrário. */
function novoId(prefixo) {
  const crypto = globalThis.crypto;
  if (crypto?.randomUUID) return crypto.randomUUID();
  return `${prefixo}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---- ajudantes de UI partilhados (call.js e movie.js) --------------------------

/** Construtor de DOM: elemento com classe e texto (textContent, nunca HTML). */
export function nodo(tag, classe = '', texto = '') {
  const n = globalThis.document.createElement(tag);
  if (classe) n.className = classe;
  if (texto) n.textContent = texto;
  return n;
}

let zonaChips = null;

/** Chip flutuante (ex.: "chamada em curso"); devolve o nodo para removerChip. */
export function mostrarChip(texto, aoClicar) {
  const doc = globalThis.document;
  if (!doc) return null;
  if (!zonaChips || !doc.body.contains(zonaChips)) {
    zonaChips = nodo('div');
    zonaChips.id = 'mv-chips';
    doc.body.appendChild(zonaChips);
  }
  const chip = botao(texto, 'mv-chip', aoClicar);
  zonaChips.appendChild(chip);
  return chip;
}

/** Remove um chip criado por mostrarChip. */
export function removerChip(chip) {
  chip?.remove();
}

/** Botão pequeno com texto; devolve o nodo. */
export function botao(texto, classes = 'btn', aoClicar = null) {
  const b = nodo('button', classes, texto);
  b.type = 'button';
  if (aoClicar) b.addEventListener('click', aoClicar);
  return b;
}

/**
 * Modal no estilo da Task 9 (.modal/.modal-card). `corpo` e `acoes` recebem
 * nodos prontos. Com bloqFora, o fecho exige um botão (sem Escape/fora).
 */
export function abrirModal({ titulo, corpo = [], acoes = [], aoFechar, bloqFora = false }) {
  const doc = globalThis.document;
  if (!doc) return { fechar() {} };
  const cartao = nodo('div', 'modal-card');
  cartao.appendChild(nodo('h2', 'modal-titulo', titulo));
  for (const n of corpo) cartao.appendChild(n);
  const zona = nodo('div', 'modal-acoes');
  for (const a of acoes) zona.appendChild(a);
  cartao.appendChild(zona);
  const overlay = nodo('div', 'modal');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.appendChild(cartao);
  doc.body.appendChild(overlay);
  const aoEscape = (ev) => { if (!bloqFora && ev.key === 'Escape') fechar(); };
  function fechar() {
    overlay.remove();
    doc.removeEventListener('keydown', aoEscape);
    if (aoFechar) aoFechar();
  }
  if (!bloqFora) overlay.addEventListener('click', (ev) => { if (ev.target === overlay) fechar(); });
  doc.addEventListener('keydown', aoEscape);
  return { overlay, fechar };
}

/** Devolve a zona principal à conversa aberta (ou ao estado vazio do shell). */
export function restaurarZonaPrincipal(convIdAlternativa = null) {
  const MV = globalThis.window?.MV;
  if (!MV) return;
  const destino = MV.obterEstado?.()?.ativa ?? convIdAlternativa;
  if (destino && MV.abrirConversa) {
    MV.abrirConversa(destino);
    return;
  }
  // v1.1: sem conversa ativa, fecharVista remove o chat-open (o telemóvel
  // regressa à lista) e mostra o vazio — antes ficava PRETO e sem saída.
  if (MV.fecharVista) {
    MV.fecharVista();
    return;
  }
  const main = MV.zonaPrincipal?.();
  if (main) mostrarVazio(main, { temAmigos: (MV.obterEstado?.()?.amigos?.size ?? 0) > 0 });
}

// ---- arranque -------------------------------------------------------------------

/**
 * Liga o módulo ao WsClient atual do shell e publica o gancho
 * MV.chamarDaConversa(conv). Reentrante: nova sessão → handlers novos.
 */
export function iniciarChamadas() {
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
    ['call_incoming', aoIncoming], ['call_ack', aoAck], ['call_signal', aoSinal],
    ['call_end', aoFim], ['error', aoErro],
  ]) soltarHandlers.push(ws.on(tipo, fn));
  MV.chamarDaConversa = iniciarDaConversa;
  MV.aoSair?.(() => {
    if (chamada) encerrar();
  });
}

// ---- utilitários do shell ---------------------------------------------------------

function nomeDe(id) {
  return globalThis.window?.MV?.obterEstado?.()?.amigos?.get(id)?.username ?? 'Participante';
}

function euNome() {
  return globalThis.window?.MV?.obterEstado?.()?.utilizador?.username ?? 'Você';
}

function enviarSinal(destino, data) {
  if (!chamada) return;
  ws?.send({ type: 'call_signal', callId: chamada.callId, toUserId: destino, data });
}

// ---- início de chamada (originador) ---------------------------------------------

function iniciarDaConversa(conv) {
  if (chamada) {
    toast('Já está numa chamada — encerre-a primeiro.', 'erro');
    return;
  }
  const destinos = (conv?.memberIds ?? []).filter((id) => id !== euId);
  if (destinos.length === 0) {
    toast('Não há ninguém para chamar nesta conversa.', 'erro');
    return;
  }
  pedirMedia().then((stream) => {
    if (!stream) return; // o aviso de permissão já foi mostrado
    chamada = {
      callId: novoId('call'), convId: conv.id, participantes: new Map(),
      aConvidar: new Set(destinos), localStream: stream, refs: null, chip: null,
      micOn: true, camOn: true,
    };
    montarVista();
    const ok = ws?.send({ type: 'call_invite', callId: chamada.callId, toUserIds: destinos, media: MEDIA });
    if (!ok) {
      toast('Sem ligação ao servidor — a chamada não foi feita.', 'erro');
      encerrar();
    }
  });
}

/** Pede câmara+microfone; resolve null (com toast) em falha. */
function pedirMedia() {
  return new Promise((resolve) => {
    const md = globalThis.navigator?.mediaDevices;
    if (!md?.getUserMedia) {
      toast('Este contexto não permite câmara/microfone — use localhost ou HTTPS.', 'erro');
      return resolve(null);
    }
    md.getUserMedia({ video: true, audio: true }).then(resolve).catch(() => {
      toast('Não foi possível aceder à câmara/microfone. Verifique as permissões.', 'erro');
      resolve(null);
    });
  });
}

// ---- envelopes recebidos ----------------------------------------------------------

function aoIncoming(envelope) {
  const { callId, fromUserId, fromName, media } = envelope;
  if (typeof callId !== 'string' || typeof fromUserId !== 'string' || fromUserId === euId) return;
  if (chamada) {
    // Uma chamada por aba na v1: recusa automática do novo pedido.
    ws?.send({ type: 'call_end', callId, toUserIds: [fromUserId] });
    toast('Está numa chamada — o novo pedido foi recusado.', 'erro');
    return;
  }
  const recusar = botao('Recusar', 'btn', () => {
    modal.fechar();
    ws?.send({ type: 'call_end', callId, toUserIds: [fromUserId] }); // recusa = call_end ao originador
  });
  const aceitar = botao('Aceitar', 'btn btn-primary', () => {
    modal.fechar();
    aceitarChamada(callId, fromUserId, fromName);
  });
  const modal = abrirModal({
    titulo: 'Chamada a receber',
    corpo: [nodo('p', '', `${fromName ?? nomeDe(fromUserId)} está a chamar${media === MEDIA ? ' (vídeo e áudio)' : ''}.`)],
    acoes: [recusar, aceitar],
  });
}

async function aceitarChamada(callId, fromUserId, fromName) {
  const stream = await pedirMedia();
  if (!stream) {
    // Sem câmara/microfone não há chamada AV: fica como recusa.
    ws?.send({ type: 'call_end', callId, toUserIds: [fromUserId] });
    return;
  }
  chamada = {
    callId, convId: null, participantes: new Map(), aConvidar: new Set(),
    localStream: stream, refs: null, chip: null, micOn: true, camOn: true,
  };
  montarVista();
  adicionarParticipante(fromUserId, fromName);
  enviarSinal(fromUserId, { kind: 'hello', username: euNome() });
  if (devoOferecer(euId, fromUserId)) oferecer(chamada.participantes.get(fromUserId));
}

function aoAck(envelope) {
  if (!chamada || envelope.callId !== chamada.callId) return;
  const entregues = Array.isArray(envelope.delivered) ? envelope.delivered : [];
  for (const id of envelope.missed ?? []) {
    if (chamada.aConvidar.delete(id)) toast(`${nomeDe(id)} não está disponível.`, 'erro');
  }
  atualizarEstado();
  if (entregues.length === 0 && chamada.participantes.size === 0) {
    toast('Ninguém recebeu a chamada.', 'erro');
    encerrar();
  }
}

function aoFim(envelope) {
  if (!chamada || envelope.callId !== chamada.callId) return;
  const de = envelope.fromUserId;
  if (typeof de !== 'string') return;
  if (chamada.participantes.has(de)) {
    encerrar(`${nomeDe(de)} encerrou a chamada.`, false); // quem estava dentro → fim para todos
    return;
  }
  if (chamada.aConvidar.delete(de)) {
    toast(`${nomeDe(de)} recusou a chamada.`, 'erro');
    if (chamada.aConvidar.size === 0 && chamada.participantes.size === 0) encerrar();
  }
}

async function aoSinal(envelope) {
  if (!chamada || envelope.callId !== chamada.callId) return;
  const de = envelope.fromUserId;
  if (typeof de !== 'string' || de === euId) return;
  const data = envelope.data;
  if (!data || typeof data.kind !== 'string') return;
  switch (data.kind) {
    case 'hello':
      tratarHello(de, data.username);
      return;
    case 'roster':
      tratarRoster(data.members);
      return;
    case 'join':
      if (typeof data.userId === 'string' && data.userId !== euId) {
        const par = adicionarParticipante(data.userId, data.username);
        if (devoOferecer(euId, data.userId)) oferecer(par);
      }
      return;
    case 'offer':
      await tratarOferta(de, data.payload);
      return;
    case 'answer':
      await tratarResposta(de, data.payload);
      return;
    case 'ice':
      tratarIce(de, data.payload);
      return;
  }
}

// ---- lógica da malha ----------------------------------------------------------------

/** Originador: responde ao hello com o roster, anuncia o novo e talvez ofereça. */
function tratarHello(de, username) {
  const par = adicionarParticipante(de, username);
  chamada.aConvidar.delete(de);
  const membros = [{ id: euId, username: euNome() }];
  for (const outro of chamada.participantes.values()) {
    if (outro.id !== de) membros.push({ id: outro.id, username: outro.username });
  }
  enviarSinal(de, { kind: 'roster', members: membros });
  for (const outro of chamada.participantes.values()) {
    if (outro.id !== de) enviarSinal(outro.id, { kind: 'join', userId: de, username: par.username });
  }
  if (devoOferecer(euId, de)) oferecer(par);
}

/** Convidado: conhece os participantes já dentro e oferece aos de ID maior. */
function tratarRoster(membros) {
  if (!Array.isArray(membros)) return;
  for (const membro of membros) {
    if (!membro || typeof membro.id !== 'string' || membro.id === euId) continue;
    const par = adicionarParticipante(membro.id, membro.username);
    if (devoOferecer(euId, membro.id)) oferecer(par);
  }
}

async function tratarOferta(de, payload) {
  if (!payload || typeof payload.sdp !== 'string') return;
  const par = adicionarParticipante(de);
  const pc = criarPc(par);
  await pc.setRemoteDescription(payload);
  descarregarFilaIce(par);
  const resposta = await pc.createAnswer();
  await pc.setLocalDescription(resposta);
  enviarSinal(de, { kind: 'answer', payload: pc.localDescription });
}
async function tratarResposta(de, payload) {
  const par = chamada.participantes.get(de);
  if (!par?.pc || !payload || typeof payload.sdp !== 'string') return;
  if (par.pc.signalingState !== 'have-local-offer') return; // resposta sem oferta — ignora
  await par.pc.setRemoteDescription(payload);
  descarregarFilaIce(par);
}
function tratarIce(de, payload) {
  if (!payload) return;
  const par = adicionarParticipante(de);
  if (par.pc && par.pc.remoteDescription) par.pc.addIceCandidate(payload).catch(() => {});
  else par.filaIce.push(payload); // ICE antes da descrição remota — fila por par
}
function descarregarFilaIce(par) {
  if (!par.pc) return;
  for (const candidato of par.filaIce.splice(0)) {
    par.pc.addIceCandidate(candidato).catch(() => {});
  }
}
function adicionarParticipante(id, username = null) {
  let par = chamada.participantes.get(id);
  if (par) {
    if (username) par.username = username;
    return par;
  }
  par = { id, username: username || nomeDe(id), pc: null, filaIce: [], tile: null, aOferecer: false, falhou: false };
  chamada.participantes.set(id, par);
  if (chamada.refs && chamada.refs.grelha.children.length < LIMITE_TILES) {
    par.tile = criarTile(par.username);
    chamada.refs.grelha.appendChild(par.tile.raiz);
  }
  atualizarEstado();
  return par;
}
function criarTile(rotulo, ehEu = false) {
  const video = Object.assign(nodo('video'), { autoplay: true, playsInline: true, muted: ehEu }); // próprio em mudo (sem eco)
  const tile = nodo('div', 'chamada-tile');
  tile.append(video, nodo('span', 'chamada-nome', rotulo));
  return { raiz: tile, video };
}
function criarPc(par) {
  if (par.pc) return par.pc;
  const pc = new globalThis.RTCPeerConnection({ iceServers: [{ urls: STUN }] });
  par.pc = pc;
  for (const track of chamada.localStream.getTracks()) pc.addTrack(track, chamada.localStream);
  pc.onicecandidate = (ev) => {
    if (ev.candidate) enviarSinal(par.id, { kind: 'ice', payload: ev.candidate.toJSON?.() ?? ev.candidate });
  };
  pc.ontrack = (ev) => {
    const stream = ev.streams[0] ?? null;
    if (par.tile && stream) {
      par.tile.video.srcObject = stream;
      par.tile.video.play?.().catch(() => {});
    }
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' && !par.falhou) { // par desapareceu: graça curta e encerra (1×/par)
      par.falhou = true;
      setTimeout(() => {
        if (chamada?.participantes.get(par.id) === par && par.pc?.connectionState !== 'connected') {
          encerrar(`A ligação com ${nomeDe(par.id)} falhou — a chamada terminou.`);
        }
      }, 2000);
    }
    atualizarEstado();
  };
  return pc;
}
async function oferecer(par) {
  if (!par || par.pc || par.aOferecer) return;
  par.aOferecer = true;
  try {
    const pc = criarPc(par);
    const oferta = await pc.createOffer();
    await pc.setLocalDescription(oferta);
    enviarSinal(par.id, { kind: 'offer', payload: pc.localDescription });
  } catch {
    // o par pode ter saído a meio — segue sem quebrar a chamada
  } finally {
    par.aOferecer = false;
  }
}
// ---- vista da chamada -----------------------------------------------------------------

function montarVista() {
  const MV = globalThis.window?.MV;
  const doc = globalThis.document;
  const cabeca = nodo('header', 'chamada-head');
  cabeca.append(nodo('h2', 'chamada-titulo', 'Chamada'), nodo('span', 'chamada-estado', 'A chamar…'));
  const grelha = nodo('div', 'chamada-grid');
  const meuTile = criarTile(`${euNome()} (você)`, true);
  meuTile.video.srcObject = chamada.localStream;
  grelha.appendChild(meuTile.raiz);
  const mic = botao('🎙 Microfone', 'btn btn-toggle', alternaMic);
  const cam = botao('🎥 Câmara', 'btn btn-toggle', alternaCam);
  const rodape = nodo('footer', 'chamada-rodape');
  rodape.append(mic, cam, botao('Encerrar', 'btn btn-perigo', () => encerrar()));
  const raiz = doc.createElement('div');
  raiz.className = 'chamada';
  raiz.append(cabeca, grelha, rodape);
  chamada.refs = { raiz, estado: cabeca.lastChild, grelha, mic, cam };
  MV.montarVistaPrincipal(raiz);
  chamada.chip = mostrarChip('📞 Chamada em curso', () => MV.montarVistaPrincipal(chamada.refs.raiz));
}
function alternaMic() {
  if (!chamada?.localStream || !chamada.refs) return;
  chamada.micOn = !chamada.micOn;
  for (const track of chamada.localStream.getAudioTracks()) track.enabled = chamada.micOn;
  chamada.refs.mic.textContent = chamada.micOn ? '🎙 Microfone' : '🔇 Microfone';
  chamada.refs.mic.classList.toggle('is-off', !chamada.micOn);
}
function alternaCam() {
  if (!chamada?.localStream || !chamada.refs) return;
  chamada.camOn = !chamada.camOn;
  for (const track of chamada.localStream.getVideoTracks()) track.enabled = chamada.camOn;
  chamada.refs.cam.textContent = chamada.camOn ? '🎥 Câmara' : '🚫 Câmara';
  chamada.refs.cam.classList.toggle('is-off', !chamada.camOn);
}
function atualizarEstado() {
  if (!chamada?.refs) return;
  const ligado = [...chamada.participantes.values()].some((par) => par.pc?.connectionState === 'connected');
  chamada.refs.estado.textContent = chamada.participantes.size === 0 ? 'A chamar…' : ligado ? 'Em chamada' : 'A ligar…';
  chamada.refs.estado.classList.toggle('on', ligado);
}
/**
 * Termina a chamada: call_end a todos os outros (por omissão), tracks locais
 * paradas, RTCPeerConnection fechadas e zona devolvida ao shell.
 */
function encerrar(motivo = null, avisarOutros = true) {
  const atual = chamada;
  if (!atual) return;
  chamada = null;
  if (avisarOutros && ws) {
    const alvos = [...new Set([...atual.participantes.keys(), ...atual.aConvidar])];
    if (alvos.length > 0) ws.send({ type: 'call_end', callId: atual.callId, toUserIds: alvos });
  }
  for (const par of atual.participantes.values()) {
    try { par.pc?.close(); } catch { /* ligação já fechada — nada a fazer */ }
  }
  atual.localStream?.getTracks().forEach((track) => track.stop());
  removerChip(atual.chip);
  if (atual.refs) restaurarZonaPrincipal(atual.convId);
  if (motivo) toast(motivo, 'erro');
}
function aoErro(envelope) {
  if (!chamada) return;
  // E_NOTFOUND num call_signal = o par já não está ligado; a chamada acaba por
  // si (call_end ou fecho do socket) — não faz barulho.
  if (envelope.code === 'E_NOTFOUND') return;
  if (envelope.code === 'E_FORBIDDEN') toast('Apenas amigos podem trocar chamadas.', 'erro');
  else if (envelope.code !== 'E_UNKNOWN_TYPE') toast('O servidor recusou um pedido da chamada.', 'erro');
}
