'use strict';

/**
 * Limitador de pedidos em memória — Machine Video Social.
 *
 * Janela deslizante simples por chave (ex.: `login:IP:username`): cada
 * tentativa admitida fica registada com o instante; quando a janela já
 * contém o máximo, a chave é bloqueada até as tentativas velhas expirarem.
 * Serve os endpoints públicos de autenticação (register/login/recover) para
 * travar força-bruta e DoS de CPU (bcrypt custa ~50-100 ms por tentativa).
 *
 * NOTA honesta: o contador vive POR PROCESSO — um restart do servidor
 * recomeça as janelas. Para v1 (círculo de amigos, deploy no Render free
 * tier) é suficiente; um limitador partilhado (ex.: Redis) fica para v2.
 *
 * Limpeza: cada acesso elimina as entradas expiradas da chave (lazy) e um
 * `setInterval` não-referenciado varre periodicamente as chaves abandonadas,
 * para um atacante não crescer o Map com chaves nunca mais tocadas.
 */

const JANELA_MS_PADRAO = 5 * 60 * 1000; // 5 minutos
const MAXIMO_PADRAO = 10; // tentativas por janela
const INTERVALO_SWEEP_MS = 60 * 1000; // varre a cada minuto

/**
 * @param {object} [opcoes]
 * @param {number} [opcoes.janelaMs] - duração da janela (5 min por omissão)
 * @param {number} [opcoes.maximo] - tentativas admitidas por janela (10)
 * @param {number} [opcoes.intervaloSweepMs] - periodicidade da varredura
 * @returns {{ permitir: (chave: string, agoraMs?: number) => boolean,
 *             limpar: (agoraMs?: number) => void }}
 */
function criarLimitador({
  janelaMs = JANELA_MS_PADRAO,
  maximo = MAXIMO_PADRAO,
  intervaloSweepMs = INTERVALO_SWEEP_MS,
} = {}) {
  /** @type {Map<string, number[]>} chave → instantes (ms) ainda dentro da janela */
  const tentativas = new Map();

  /** Elimina as entradas expiradas (e as chaves que ficarem vazias). */
  function limpar(agoraMs = Date.now()) {
    for (const [chave, instantes] of tentativas) {
      const vivos = instantes.filter((ts) => agoraMs - ts < janelaMs);
      if (vivos.length === 0) tentativas.delete(chave);
      else tentativas.set(chave, vivos);
    }
  }

  const varredura = setInterval(() => limpar(), intervaloSweepMs);
  if (typeof varredura.unref === 'function') varredura.unref(); // não segura o processo

  /**
   * Regista (e valida) uma tentativa.
   * @returns {boolean} true se pode passar; false quando a janela excedeu
   *   o máximo (a tentativa recusada NÃO é registada).
   */
  function permitir(chave, agoraMs = Date.now()) {
    const vivos = (tentativas.get(chave) ?? []).filter((ts) => agoraMs - ts < janelaMs);
    if (vivos.length >= maximo) {
      tentativas.set(chave, vivos);
      return false;
    }
    vivos.push(agoraMs);
    tentativas.set(chave, vivos);
    return true;
  }

  return { permitir, limpar };
}

module.exports = { criarLimitador };
