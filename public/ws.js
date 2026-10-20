/**
 * ws.js — cliente WebSocket do Machine Video (Task 9).
 *
 * Protocolo do hub (src/ws.js): o PRIMEIRO envelope é sempre
 * {type:"auth", token} → {type:"auth_ok", user}. Depois chegam
 * {type:"presence", userId, online} e {type:"chat_message", ...} — e, nas
 * Tasks 10, os tipos de chamada e de sessões de filme. Um envelope
 * {type:"error", code} chega para falhas pontuais (a ligação mantém-se viva).
 *
 * Reconexão: backoff exponencial 1→2→4→8 s (tecto 8 s). O contador reinicia
 * após um auth_ok. Cinco fechos seguidos sem conseguir autenticar indicam
 * token expirado → estado 'dead': a interface manda o utilizador entrar de novo.
 *
 * Despacho por tipo: ws.on('chat_message', fn) — cada tipo aceita vários
 * handlers, para os módulos da Task 10 (call.js, movie.js) se ligarem sem
 * alterar este ficheiro. `onStatus` notifica mudanças de estado da ligação:
 * 'connecting' → 'online' → 'reconnecting'… → 'idle' | 'dead'.
 */

/** Fechos seguidos sem auth_ok antes de declarar a sessão morta. */
const FALHAS_ATE_MORTA = 5;
const OPEN = 1; // WebSocket.OPEN, em browser e no cliente `ws` do Node

export class WsClient {
  constructor({ url, backoffInicialMs = 1000, backoffMaxMs = 8000 } = {}) {
    this.url = url || null;
    this.backoffInicialMs = backoffInicialMs;
    this.backoffMaxMs = backoffMaxMs;
    /** @type {Map<string, Set<Function>>} tipo → handlers do envelope */
    this._handlers = new Map();
    this._subStatus = new Set();
    this._status = 'idle';
    this._delay = backoffInicialMs;
    this._falhas = 0;
    this._fechadoPorNos = false;
    this._token = null;
    this._socket = null;
    this._temporizador = null;
  }

  get status() {
    return this._status;
  }

  /**
   * Registra um handler para um tipo de envelope. Devolve a função que o
   * remove — os módulos da Task 10 podem anular os seus handlers.
   */
  on(tipo, handler) {
    let conjunto = this._handlers.get(tipo);
    if (!conjunto) {
      conjunto = new Set();
      this._handlers.set(tipo, conjunto);
    }
    conjunto.add(handler);
    return () => conjunto.delete(handler);
  }

  /** Observa o estado da ligação; devolve a função que remove a subscrição. */
  onStatus(handler) {
    this._subStatus.add(handler);
    handler(this._status);
    return () => this._subStatus.delete(handler);
  }

  /** Liga e autentica. Idempotente: ignora pedidos repetidos com o mesmo socket vivo. */
  connect(token) {
    if (typeof token !== 'string' || token === '') {
      throw new Error('ws.connect precisa de um token');
    }
    this._token = token;
    this._fechadoPorNos = false;
    if (this._socket) return;
    this._abrir();
  }

  /** Envia um envelope JSON. Devolve false se a ligação não estiver aberta. */
  send(envelope) {
    const socket = this._socket;
    if (!socket || socket.readyState !== OPEN) return false;
    try {
      socket.send(JSON.stringify(envelope));
      return true;
    } catch {
      return false;
    }
  }

  /** Fecha de propósito — NÃO reconecta (usado em logout). */
  close() {
    this._fechadoPorNos = true;
    clearTimeout(this._temporizador);
    const socket = this._socket;
    this._socket = null;
    this._token = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        // socket já morto — nada a fazer
      }
    }
    this._definirStatus('idle');
  }

  // --- internos ---------------------------------------------------------------

  _definirStatus(status) {
    if (this._status === status) return;
    this._status = status;
    for (const handler of this._subStatus) {
      try {
        handler(status);
      } catch {
        // um handler com erro não pode parar os restantes
      }
    }
  }

  /** URL do hub: explícito (testes) ou derivado da página (browser). */
  _resolverUrl() {
    if (this.url) return this.url;
    const local = globalThis.location;
    const protocolo = local.protocol === 'https:' ? 'wss' : 'ws';
    return `${protocolo}://${local.host}/ws`;
  }

  _abrir() {
    if (this._fechadoPorNos || !this._token) return;
    clearTimeout(this._temporizador);
    const Construtor = globalThis.WebSocket;
    if (typeof Construtor !== 'function') {
      this._definirStatus('dead');
      return;
    }
    this._definirStatus(this._falhas > 0 ? 'reconnecting' : 'connecting');

    let socket;
    try {
      socket = new Construtor(this._resolverUrl());
    } catch {
      this._agendarReconexao(); // URL inválido/ambiente hostil — tenta mais tarde
      return;
    }
    this._socket = socket;

    socket.onopen = () => {
      // A autenticação é sempre o primeiro envelope; o hub fecha sem resposta
      // quando o token é mau — o onclose trata disso.
      this.send({ type: 'auth', token: this._token });
    };
    socket.onmessage = (evento) => this._processar(evento.data);
    socket.onclose = () => this._aoFechar();
    socket.onerror = () => {}; // o 'close' a seguir é que aciona a reconexão
  }

  _processar(dados) {
    let envelope;
    try {
      envelope = JSON.parse(typeof dados === 'string' ? dados : String(dados));
    } catch {
      return; // lixo não-JSON (nunca devia acontecer a partir do nosso hub)
    }
    if (!envelope || typeof envelope !== 'object' || typeof envelope.type !== 'string') return;

    if (envelope.type === 'auth_ok') {
      // Conseguiu entrar: reinicia o backoff e zera a contagem de falhas.
      this._falhas = 0;
      this._delay = this.backoffInicialMs;
      this._definirStatus('online');
    }
    this._emitir(envelope.type, envelope);
  }

  _emitir(tipo, envelope) {
    for (const handler of this._handlers.get(tipo) ?? []) {
      try {
        handler(envelope);
      } catch {
        // um handler com erro não pode derrubar a ligação nem os outros handlers
      }
    }
  }

  _aoFechar() {
    this._socket = null;
    if (this._fechadoPorNos) {
      this._definirStatus('idle');
      return;
    }
    this._falhas += 1;
    if (this._falhas >= FALHAS_ATE_MORTA) {
      // Cinco tentativas sem auth_ok: o token já não serve (sessão expirada).
      this._definirStatus('dead');
      return;
    }
    this._definirStatus('reconnecting');
    this._agendarReconexao();
  }

  _agendarReconexao() {
    clearTimeout(this._temporizador);
    this._temporizador = setTimeout(() => this._abrir(), this._delay);
    this._delay = Math.min(this._delay * 2, this.backoffMaxMs); // 1→2→4→8→8…
  }
}
