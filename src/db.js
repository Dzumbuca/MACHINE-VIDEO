'use strict';

/**
 * Seleção da store e ligação à base de dados — Machine Video Social (Task 11).
 *
 * Uma única decisão de configuração:
 *   - `DATABASE_URL` definida  → store em PostgreSQL: `createStorePg` cria o
 *     pool `pg` e executa o schema idempotente (CREATE TABLE IF NOT EXISTS)
 *     NO BOOT — os dados sobrevivem a restarts (produção, Render + Neon);
 *   - `DATABASE_URL` ausente   → store em memória: comportamento local das
 *     tarefas 2–10 intacto (dados perdem-se ao reiniciar).
 *
 * Consumido apenas pelo arranque direto (npm start, em src/server.js); os
 * testes injetam a store diretamente em createServer({ store }).
 */

const { createStoreMemory } = require('./store-memory');
const { createStorePg } = require('./store-pg');

/**
 * @param {object} [opcoes]
 * @param {string} [opcoes.databaseUrl] - sobrepõe process.env.DATABASE_URL.
 * @returns {Promise<{store: object, usandoPg: boolean}>}
 */
async function selecionarStore({ databaseUrl } = {}) {
  const url = databaseUrl ?? process.env.DATABASE_URL;
  if (!url) {
    return { store: createStoreMemory(), usandoPg: false };
  }
  const store = await createStorePg(url); // pool + schema idempotente no boot
  return { store, usandoPg: true };
}

module.exports = { selecionarStore };
