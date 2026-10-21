'use strict';

/**
 * Métodos Google (v1.1) para a store em PostgreSQL — mixin de src/store-pg.js.
 *
 * Mantidos num ficheiro próprio para respeitar a regra de < 500 linhas por
 * ficheiro. Recebem o `pool` e seguem o MESMO contrato de src/store.js:
 * todas as funções são async, usam queries parametrizadas e devolvem cópias.
 */

const { StoreError } = require('./store');

/** Prepara os métodos Google a partir de um pool de ligação pg. */
function criarMetodosGooglePg(pool) {
  /** Corre um trabalho com um cliente da pool (transação, rollback em falha). */
  async function comTransacao(trabalho) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const resultado = await trabalho(client);
      await client.query('COMMIT');
      return resultado;
    } catch (erro) {
      await client.query('ROLLBACK');
      throw erro;
    } finally {
      client.release();
    }
  }

  async function getUserByGoogleId(googleId) {
    if (googleId == null) return null;
    const r = await pool.query(
      'SELECT * FROM users WHERE google_id = $1',
      [googleId],
    );
    return r.rows[0] || null;
  }

  async function getUserByEmail(email) {
    if (email == null) return null;
    const r = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    return r.rows[0] || null;
  }

  // Liga uma conta Google a um utilizador existente (mesmo email verificado).
  // E_DUP se o google_id já estiver associado a outra conta.
  async function linkGoogleToUser(userId, { googleId, email }) {
    return comTransacao(async (db) => {
      const r = await db.query(
        `UPDATE users SET google_id = $1, email = COALESCE(email, $2)
         WHERE id = $3
         RETURNING *`,
        [googleId, email, userId],
      );
      if (r.rows.length === 0) {
        throw new StoreError('E_NOTFOUND', 'Utilizador não encontrado');
      }
      return r.rows[0];
    });
  }

  // Cria utilizador via Google: sem senha nem pergunta de segurança.
  // E_DUP se o username já existir (o chamador gera um username livre).
  async function createUserWithGoogle({ username, email, googleId }) {
    const r = await pool.query(
      `INSERT INTO users (username, pass_hash, sec_q, sec_a, email, google_id)
       VALUES ($1, NULL, NULL, NULL, $2, $3)
       RETURNING *`,
      [username, email, googleId],
    );
    return r.rows[0];
  }

  return {
    getUserByGoogleId,
    getUserByEmail,
    linkGoogleToUser,
    createUserWithGoogle,
  };
}

module.exports = { criarMetodosGooglePg };
