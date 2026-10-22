'use strict';

/**
 * Métodos Google (v1.1) para a store em PostgreSQL — mixin de src/store-pg.js.
 *
 * Mantidos num ficheiro próprio para respeitar a regra de < 500 linhas por
 * ficheiro. Seguem o MESMO contrato de src/store.js: assíncronos, queries
 * parametrizadas, cópias de objetos e erros StoreError.
 *
 * `util` traz da store-pg os ajudantes que garantem paridade com os outros
 * métodos: novoId (id gerado em JS — a coluna users.id não tem DEFAULT),
 * linhaUser (mapeamento de coluna → propriedade) e erroDuplicado (23505 → E_DUP).
 */

const { StoreError } = require('./store');

const IDENTIDADE_PADRAO = {
  novoId: () => require('node:crypto').randomUUID(),
  linhaUser: (linha) => linha,
  erroDuplicado: (erro) => {
    throw erro;
  },
};

/** Prepara os métodos Google a partir de um pool de ligação pg. */
function criarMetodosGooglePg(pool, util = {}) {
  const { novoId, linhaUser, erroDuplicado } = { ...IDENTIDADE_PADRAO, ...util };

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
    return r.rows[0] ? linhaUser(r.rows[0]) : null;
  }

  async function getUserByEmail(email) {
    if (email == null) return null;
    const r = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    return r.rows[0] ? linhaUser(r.rows[0]) : null;
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
      return linhaUser(r.rows[0]);
    });
  }

  // Cria utilizador via Google: sem senha nem pergunta de segurança.
  // O id é gerado aqui (a coluna users.id não tem DEFAULT — a mesma regra
  // do createUser). E_DUP se o username já existir.
  async function createUserWithGoogle({ username, email, googleId }) {
    try {
      const r = await pool.query(
        `INSERT INTO users (id, username, pass_hash, sec_q, sec_a, email, google_id)
         VALUES ($1, $2, NULL, NULL, NULL, $3, $4)
         RETURNING *`,
        [novoId(), username, email, googleId],
      );
      return linhaUser(r.rows[0]);
    } catch (erro) {
      erroDuplicado(erro, 'Nome de utilizador já existe');
    }
  }

  return {
    getUserByGoogleId,
    getUserByEmail,
    linkGoogleToUser,
    createUserWithGoogle,
  };
}

module.exports = { criarMetodosGooglePg };
