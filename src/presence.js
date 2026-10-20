'use strict';

/**
 * Presença — Machine Video Social (Task 5).
 *
 * Guarda o mapa central `userId → Set<socket>` (multi-aba: cada aba/ligação
 * autenticada entra no mesmo conjunto) e calcula os destinatários dos avisos
 * de presença. A entrega dos envelopes JSON fica no hub (src/ws.js): este
 * módulo só responde a QUEM está ligado e a QUEM deve ser notificado.
 *
 * Regra de difusão (enunciado): a presença vai APENAS a amigos — os amigos do
 * utilizador afetado vêm de `store.listFriends` e a amizade é confirmada no
 * sentido inverso (`store.areFriends`) antes de cada entrega.
 */

function criarPresenca({ store }) {
  /** @type {Map<string, Set<object>>} userId → sockets autenticados dessa conta */
  const socketsPorUser = new Map();

  /**
   * Regista um socket autenticado no conjunto da conta.
   * @returns {boolean} true se for a PRIMEIRA ligação (o utilizador ficou online)
   */
  function adicionar(userId, ws) {
    let conjunto = socketsPorUser.get(userId);
    if (!conjunto) {
      conjunto = new Set();
      socketsPorUser.set(userId, conjunto);
    }
    conjunto.add(ws);
    return conjunto.size === 1;
  }

  /**
   * Retira um socket do conjunto da conta.
   * @returns {boolean} true se era a ÚLTIMA ligação (o utilizador ficou offline)
   */
  function remover(userId, ws) {
    const conjunto = socketsPorUser.get(userId);
    if (!conjunto || !conjunto.delete(ws)) return false;
    if (conjunto.size === 0) {
      socketsPorUser.delete(userId);
      return true;
    }
    return false;
  }

  /**
   * Snapshot (cópia) dos sockets autenticados do utilizador — iteração segura
   * mesmo que um socket feche a meio de um envio.
   * @returns {object[]}
   */
  function sockets(userId) {
    return [...(socketsPorUser.get(userId) ?? [])];
  }

  /**
   * Destinatários do aviso de presença do utilizador afetado: apenas amigos,
   * com a amizade confirmada nos dois sentidos antes de entregar.
   * @returns {string[]} ids dos amigos a notificar
   */
  function destinosPresenca(userId) {
    const destinos = [];
    try {
      for (const amigo of store.listFriends(userId)) {
        if (!amigo || typeof amigo.id !== 'string') continue;
        if (store.areFriends(amigo.id, userId)) destinos.push(amigo.id);
      }
    } catch {
      // store indisponível/não conforme: melhor não avisar ninguém do que
      // interromper o hub — a presença é best-effort.
    }
    return destinos;
  }

  return { adicionar, remover, sockets, destinosPresenca };
}

module.exports = { criarPresenca };
