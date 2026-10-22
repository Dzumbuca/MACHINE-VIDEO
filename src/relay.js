'use strict';

/**
 * Ponte de tempo real (v1.1) — faz VÁRIOS servidores do Machine Video
 * funcionarem como UMA rede.
 *
 * Problema: as chamadas, convites de sessão e mensagens em tempo real
 * passam pelo hub WebSocket de CADA processo. Com o app publicado em 2
 * endereços (Render + PC), dois amigos em endereços diferentes não se
 * ouviam — a base de dados era partilhada, mas o tempo real não.
 *
 * Solução: LISTEN/NOTIFY do PostgreSQL (a mesma base Neon que já partilham).
 *   - enviarPara → entrega local + pg_notify com o envelope e o destino;
 *   - cada servidor recebe a notificação e entrega aos SEUS sockets;
 *   - o campo `origem` (id aleatório por processo) evita entrega duplicada
 *     no servidor que originou.
 *
 * LISTEN/NOTIFY exige ligação DIRETA ao Postgres: no Neon, o host "-pooler"
 * (PgBouncer em modo transação) não garante LISTEN — remove-se o sufixo.
 * pg_notify aceita payloads até 8000 bytes: acima de 7000 desistimos com
 * registo (SDP/ICE grandes são raros; a limitação é visível nos logs).
 */

const crypto = require('node:crypto');
const { Client } = require('pg');

const CANAL = 'mv_rt';
const LIMITE_PAYLOAD = 7000;
const ID_PROCESSO = crypto.randomUUID();

/** Ligação direta (sem pooler, sem channel_binding) para LISTEN/NOTIFY. */
function ligacaoDireta(connectionString) {
  return connectionString
    .replace('-pooler.', '.')
    .replace(/&?channel_binding=[^&]*/, '');
}

/**
 * Cria a ponte. `aoReceber(dados)` é chamado com { userId, envelope, origem }
 * para notificações de OUTROS processos. Nunca lança: erros ficam nos logs e
 * o tempo real continua a funcionar dentro de cada servidor.
 *
 * A ligação tem RETRY (3 tentativas): no arranque frio do Neon (compute
 * adormecido), o handshake TLS/SASL pode falhar à primeira — EPROTO e
 * "authentication protocol violation" vistos logo no boot em produção.
 */
function criarRele({ connectionString, aoReceber }) {
  if (!connectionString) return null;
  let ativo = true;
  let cliente = null;

  function novaLigacao() {
    return new Client({ connectionString: ligacaoDireta(connectionString) });
  }

  function montarHandlers(c) {
    c.on('error', (erro) => {
      console.error('Rele: erro de ligação —', erro.message);
    });
    c.on('notification', (msg) => {
      if (!ativo || !msg.payload) return;
      try {
        const dados = JSON.parse(msg.payload);
        if (dados.origem !== ID_PROCESSO) aoReceber?.(dados);
      } catch {
        // payload corrompido — ignorar (a entrega local dos outros segue)
      }
    });
  }

  async function ligar() {
    for (let tentativa = 1; tentativa <= 3 && ativo; tentativa += 1) {
      cliente = novaLigacao();
      montarHandlers(cliente);
      try {
        await cliente.connect();
        await cliente.query(`LISTEN ${CANAL}`);
        console.log('Rele: ponte de tempo real ativa (canal ' + CANAL + ')');
        return;
      } catch (erro) {
        console.error(`Rele: tentativa ${tentativa}/3 falhou —`, erro.message);
        try { await cliente.end(); } catch { /* já morta */ }
        if (tentativa < 3 && ativo) {
          await new Promise((r) => setTimeout(r, 1500 * tentativa));
        }
      }
    }
    if (ativo) console.error('Rele: desistindo do LISTEN — o tempo real fica só-local');
  }

  ligar();

  return {
    /** Publica { userId, envelope } para os outros servidores. Fire-and-forget. */
    publicar(dados) {
      if (!ativo || !cliente) return;
      const payload = JSON.stringify({ ...dados, origem: ID_PROCESSO });
      if (Buffer.byteLength(payload) > LIMITE_PAYLOAD) {
        console.error('Rele: payload acima de 7 KB — não atravessa a ponte');
        return;
      }
      cliente
        .query('SELECT pg_notify($1, $2)', [CANAL, payload])
        .catch((erro) => console.error('Rele: falhou o pg_notify —', erro.message));
      // (sem debug permanente: os logs de erro cobrem as falhas)
    },
    /** Fecha a ligação de escuta (encerramento gracioso). */
    parar() {
      ativo = false;
      cliente?.end().catch(() => {});
    },
  };
}

module.exports = { criarRele, CANAL, LIMITE_PAYLOAD };
