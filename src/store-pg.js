'use strict';

/**
 * Implementação em PostgreSQL do contrato `src/store.js` — Task 11.
 *
 * Cumpre EXATAMENTE os mesmos métodos da store em memória
 * (src/store-memory.js) e passa os MESMOS cenários (test/.helpers/
 * store-scenarios.js, corridos por test/store-pg.test.js). A única
 * diferença estrutural: os métodos são assíncronos — devolvem Promises —
 * porque o acesso ao Postgres é I/O de rede. Quem usa a store faz `await`.
 *
 * Fábrica:
 *   const store = await createStorePg(connectionString, { reset, ...pool });
 *   - cria o pool `pg` (opções extra são passadas ao Pool, ex. `{ max: 5 }`);
 *   - executa o schema idempotente (CREATE TABLE IF NOT EXISTS) no boot;
 *   - `reset: true` (só para testes) esvazia todas as tabelas no boot, para
 *     cada store de teste começar isolada.
 *   - `store.close()` (aditivo, FORA do contrato de dados) fecha o pool —
 *     usado no encerramento do servidor e nos testes.
 *
 * Mapeamento de erros do Postgres:
 *   - violação de unicidade (23505) → StoreError E_DUP (username repetido,
 *     pedido pendente duplicado — garantido por índice único parcial, ver
 *     schema abaixo; a verificação em código continua a dar as mensagens
 *     corretas no caminho normal);
 *   - todas as restantes regras (E_SELF, E_NOTFOUND, E_FORBIDDEN, E_INVALID)
 *     são verificadas com as mesmas mensagens da store em memória.
 *
 * Ordens de listagem (contrato): listFriends/listConversations/pedidos por
 * ordem de criação e listMessages por ordem de inserção — garantidas por
 * colunas `seq` BIGSERIAL (inserção, não relógio), como o contrato exige.
 */

const crypto = require('node:crypto');
const { Pool } = require('pg');
const { StoreError } = require('./store');

/**
 * Schema idempotente — vive em src/schema-pg.sql (com notas de desenho) e
 * corre no boot (createStorePg e, por via de db.js, no arranque do servidor).
 * `IF NOT EXISTS` em tudo: reexecutar nunca falha.
 */
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, 'schema-pg.sql'), 'utf8');

/** Esvazia o estado (apenas com reset: true — isolamento entre testes). */
const TRUNCATE_SQL =
  'TRUNCATE TABLE messages, conversation_members, conversations, ' +
  'friendships, friend_requests, sessions, users RESTART IDENTITY CASCADE;';

function novoId() {
  return crypto.randomUUID();
}

/** Linha users → objeto do contrato (createdAt em ISO, como na memória). */
function linhaUser(row) {
  return {
    id: row.id,
    username: row.username,
    passHash: row.pass_hash,
    secQ: row.sec_q,
    secA: row.sec_a,
    createdAt: row.created_at.toISOString(),
  };
}

function linhaPedido(row) {
  return {
    id: row.id,
    fromId: row.from_id,
    toId: row.to_id,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

function linhaMsg(row) {
  return {
    id: row.id,
    convId: row.conv_id,
    userId: row.user_id,
    text: row.text,
    ts: row.ts.toISOString(),
  };
}

function erroDuplicado(err, mensagem) {
  if (err && err.code === '23505') throw new StoreError('E_DUP', mensagem);
  throw err;
}

/**
 * @param {string} connectionString - ex.: a DATABASE_URL do Neon.
 * @param {object} [opcoes]
 * @param {boolean} [opcoes.reset] - esvazia as tabelas no boot (testes).
 * @param {object} [opcoes.*] - opções extra passadas ao `pg.Pool`.
 * @returns {Promise<object>} store que cumpre o contrato de src/store.js.
 */
async function createStorePg(connectionString, { reset = false, ...opcoesPool } = {}) {
  if (!connectionString) {
    throw new Error('createStorePg: é preciso uma connectionString (DATABASE_URL)');
  }
  const pool = new Pool({ connectionString, ...opcoesPool });
  // Um erro de ligação em fundo (rede em baixo) não deve rebentar o processo
  // sem registo; o servidor continua e as próximas queries falham visivelmente.
  pool.on('error', (err) => {
    console.error('Postgres: erro de ligação:', err.message);
  });

  await pool.query(SCHEMA_SQL); // idempotente — CREATE TABLE IF NOT EXISTS
  if (reset) {
    await pool.query(TRUNCATE_SQL);
  }

  /** Garante que o utilizador existe ou lança E_NOTFOUND. */
  async function exigeUser(db, userId) {
    const r = await db.query('SELECT id FROM users WHERE id = $1', [userId]);
    if (r.rows.length === 0) {
      throw new StoreError('E_NOTFOUND', 'Utilizador não encontrado');
    }
  }

  /** Executa `trabalho(client)` numa transação com rollback em falha. */
  async function comTransacao(trabalho) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const resultado = await trabalho(client);
      await client.query('COMMIT');
      return resultado;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // a ligação já perdeu a transação — nada mais a fazer
      }
      throw err;
    } finally {
      client.release();
    }
  }

  // --- users ---------------------------------------------------------------

  async function createUser({ username, passHash, secQ, secA }) {
    try {
      const r = await pool.query(
        `INSERT INTO users (id, username, pass_hash, sec_q, sec_a)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, username, pass_hash, sec_q, sec_a, created_at`,
        [novoId(), username, passHash, secQ, secA],
      );
      return linhaUser(r.rows[0]);
    } catch (err) {
      erroDuplicado(err, 'Nome de utilizador já existe');
    }
  }

  async function getUserByUsername(username) {
    const r = await pool.query(
      'SELECT id, username, pass_hash, sec_q, sec_a, created_at FROM users WHERE username = $1',
      [username],
    );
    return r.rows.length ? linhaUser(r.rows[0]) : null;
  }

  async function getUserById(id) {
    const r = await pool.query(
      'SELECT id, username, pass_hash, sec_q, sec_a, created_at FROM users WHERE id = $1',
      [id],
    );
    return r.rows.length ? linhaUser(r.rows[0]) : null;
  }

  // Método aditivo (Task 3 — recuperação): substitui o passHash guardado.
  async function updateUserPassword(userId, passHash) {
    const r = await pool.query(
      `UPDATE users SET pass_hash = $2 WHERE id = $1
       RETURNING id, username, pass_hash, sec_q, sec_a, created_at`,
      [userId, passHash],
    );
    if (r.rows.length === 0) {
      throw new StoreError('E_NOTFOUND', 'Utilizador não encontrado');
    }
    return linhaUser(r.rows[0]);
  }

  // --- sessões ---------------------------------------------------------------

  async function createSession(userId) {
    await exigeUser(pool, userId);
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query('INSERT INTO sessions (token, user_id) VALUES ($1, $2)', [token, userId]);
    return token;
  }

  async function getUserByToken(token) {
    const r = await pool.query(
      `SELECT u.id, u.username, u.pass_hash, u.sec_q, u.sec_a, u.created_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = $1`,
      [token],
    );
    return r.rows.length ? linhaUser(r.rows[0]) : null;
  }

  async function deleteSession(token) {
    await pool.query('DELETE FROM sessions WHERE token = $1'); // idempotente
  }

  // --- amizades ---------------------------------------------------------------

  async function createFriendRequest(fromId, toId) {
    if (fromId === toId) {
      throw new StoreError('E_SELF', 'Não pode adicionar-se a si próprio');
    }
    let pedido;
    await comTransacao(async (client) => {
      await exigeUser(client, fromId);
      await exigeUser(client, toId);
      const amigos = await client.query(
        'SELECT 1 FROM friendships WHERE user_a = least($1, $2) AND user_b = greatest($1, $2)',
        [fromId, toId],
      );
      if (amigos.rows.length) {
        throw new StoreError('E_DUP', 'Já são amigos');
      }
      try {
        const r = await client.query(
          `INSERT INTO friend_requests (id, from_id, to_id, status)
           VALUES ($1, $2, $3, 'pending')
           RETURNING id, from_id, to_id, status, created_at`,
          [novoId(), fromId, toId],
        );
        pedido = linhaPedido(r.rows[0]);
      } catch (err) {
        erroDuplicado(err, 'Já existe um pedido de amizade pendente');
      }
    });
    return pedido;
  }

  async function acceptFriendRequest(requestId, toId) {
    return comTransacao(async (client) => {
      const r = await client.query(
        'SELECT id, from_id, to_id, status, created_at FROM friend_requests WHERE id = $1 FOR UPDATE',
        [requestId],
      );
      if (r.rows.length === 0) {
        throw new StoreError('E_NOTFOUND', 'Pedido de amizade não encontrado');
      }
      const pedido = r.rows[0];
      if (pedido.to_id !== toId) {
        throw new StoreError('E_FORBIDDEN', 'Só o destinatário pode aceitar o pedido');
      }
      if (pedido.status !== 'pending') {
        throw new StoreError('E_DUP', 'Pedido de amizade já processado');
      }
      const atualizado = await client.query(
        `UPDATE friend_requests SET status = 'accepted' WHERE id = $1
         RETURNING id, from_id, to_id, status, created_at`,
        [requestId],
      );
      // Idempotente como `adicionarAmizade` da memória (ON CONFLICT DO NOTHING).
      await client.query(
        `INSERT INTO friendships (user_a, user_b)
         VALUES (least($1, $2), greatest($1, $2))
         ON CONFLICT DO NOTHING`,
        [pedido.from_id, pedido.to_id],
      );
      return linhaPedido(atualizado.rows[0]);
    });
  }

  async function listFriends(userId) {
    await exigeUser(pool, userId);
    const r = await pool.query(
      `SELECT u.id, u.username, u.pass_hash, u.sec_q, u.sec_a, u.created_at
       FROM friendships f
       JOIN users u
         ON (u.id = f.user_b AND f.user_a = $1) OR (u.id = f.user_a AND f.user_b = $1)
       ORDER BY f.seq`,
      [userId],
    );
    return r.rows.map(linhaUser);
  }

  async function areFriends(a, b) {
    if (a === b) return false;
    const r = await pool.query(
      'SELECT 1 FROM friendships WHERE user_a = least($1, $2) AND user_b = greatest($1, $2) LIMIT 1',
      [a, b],
    );
    return r.rows.length > 0;
  }

  // Método aditivo (Task 11): pendências lidas da store, por ordem de criação.
  async function listFriendRequests(userId) {
    await exigeUser(pool, userId);
    const r = await pool.query(
      `SELECT fr.id, fr.from_id, fr.to_id, fr.created_at,
              fu.username AS from_username, tu.username AS to_username
       FROM friend_requests fr
       JOIN users fu ON fu.id = fr.from_id
       JOIN users tu ON tu.id = fr.to_id
       WHERE fr.status = 'pending' AND (fr.from_id = $1 OR fr.to_id = $1)
       ORDER BY fr.seq`,
      [userId],
    );
    const pendingIn = [];
    const pendingOut = [];
    for (const row of r.rows) {
      if (row.to_id === userId) {
        pendingIn.push({
          id: row.id,
          fromUserId: row.from_id,
          fromUsername: row.from_username,
          createdAt: row.created_at.toISOString(),
        });
      } else {
        pendingOut.push({
          id: row.id,
          toUserId: row.to_id,
          toUsername: row.to_username,
          createdAt: row.created_at.toISOString(),
        });
      }
    }
    return { pendingIn, pendingOut };
  }

  // --- conversas e mensagens ---------------------------------------------------------------

  async function createConversation(memberIds, isGroup, title) {
    if (!Array.isArray(memberIds) || memberIds.length === 0) {
      throw new StoreError('E_INVALID', 'A conversa precisa de pelo menos um membro');
    }
    const unicos = [...new Set(memberIds)]; // dedup, mantendo a 1.ª ocorrência
    for (const id of unicos) {
      await exigeUser(pool, id);
    }
    const id = novoId();
    let createdAt;
    await comTransacao(async (client) => {
      const r = await client.query(
        `INSERT INTO conversations (id, is_group, title)
         VALUES ($1, $2, $3)
         RETURNING created_at`,
        [id, Boolean(isGroup), title == null ? null : title],
      );
      createdAt = r.rows[0].created_at;
      for (let i = 0; i < unicos.length; i++) {
        await client.query(
          'INSERT INTO conversation_members (conv_id, user_id, position) VALUES ($1, $2, $3)',
          [id, unicos[i], i],
        );
      }
    });
    return {
      id,
      memberIds: unicos,
      isGroup: Boolean(isGroup),
      title: title == null ? null : title,
      createdAt: createdAt.toISOString(),
    };
  }

  async function isMember(convId, userId) {
    const r = await pool.query(
      `SELECT 1 FROM conversations c
       JOIN conversation_members m ON m.conv_id = c.id
       WHERE c.id = $1 AND m.user_id = $2
       LIMIT 1`,
      [convId, userId],
    );
    return r.rows.length > 0;
  }

  async function listConversations(userId) {
    await exigeUser(pool, userId);
    const r = await pool.query(
      `SELECT c.id, c.is_group, c.title, c.created_at,
              (SELECT COALESCE(array_agg(m.user_id ORDER BY m.position), '{}'::text[])
               FROM conversation_members m
               WHERE m.conv_id = c.id) AS member_ids
       FROM conversations c
       WHERE EXISTS (
         SELECT 1 FROM conversation_members mm
         WHERE mm.conv_id = c.id AND mm.user_id = $1
       )
       ORDER BY c.seq`,
      [userId],
    );
    return r.rows.map((row) => ({
      id: row.id,
      memberIds: row.member_ids,
      isGroup: row.is_group,
      title: row.title,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async function appendMessage(convId, userId, text) {
    const existe = await pool.query('SELECT 1 FROM conversations WHERE id = $1', [convId]);
    if (existe.rows.length === 0) {
      throw new StoreError('E_NOTFOUND', 'Conversa não encontrada');
    }
    if (!(await isMember(convId, userId))) {
      throw new StoreError('E_FORBIDDEN', 'Não é membro da conversa');
    }
    if (typeof text !== 'string' || text.length === 0) {
      throw new StoreError('E_INVALID', 'Mensagem vazia');
    }
    const r = await pool.query(
      `INSERT INTO messages (id, conv_id, user_id, text, ts)
       VALUES ($1, $2, $3, $4, now())
       RETURNING id, conv_id, user_id, text, ts`,
      [novoId(), convId, userId, text],
    );
    return linhaMsg(r.rows[0]);
  }

  async function listMessages(convId, limit, beforeId) {
    const existe = await pool.query('SELECT 1 FROM conversations WHERE id = $1', [convId]);
    if (existe.rows.length === 0) {
      throw new StoreError('E_NOTFOUND', 'Conversa não encontrada');
    }
    if (limit != null && limit <= 0) return []; // como Math.max(0, …) da memória

    const params = [convId];
    let filtro = '';
    if (beforeId != null) {
      const cursor = await pool.query('SELECT seq FROM messages WHERE id = $1 AND conv_id = $2', [
        beforeId,
        convId,
      ]);
      if (cursor.rows.length === 0) return []; // cursor fora do intervalo
      params.push(cursor.rows[0].seq);
      filtro = ` AND seq < $${params.length}`;
    }
    let clausulaLimite = '';
    if (limit != null) {
      params.push(Math.trunc(limit)); // LIMIT por parâmetro (nunca interpolação)
      clausulaLimite = ` LIMIT $${params.length}`;
    }
    const r = await pool.query(
      `SELECT id, conv_id, user_id, text, ts FROM messages
       WHERE conv_id = $1${filtro}
       ORDER BY seq DESC${clausulaLimite}`,
      params,
    );
    return r.rows.map(linhaMsg);
  }

  return {
    // users
    createUser,
    getUserByUsername,
    getUserById,
    updateUserPassword,
    // sessões
    createSession,
    getUserByToken,
    deleteSession,
    // amizades
    createFriendRequest,
    acceptFriendRequest,
    listFriends,
    areFriends,
    listFriendRequests,
    // conversas e mensagens
    createConversation,
    isMember,
    listConversations,
    appendMessage,
    listMessages,
    // ciclo de vida (FORA do contrato de dados — usado pelo servidor/testes)
    close: () => pool.end(),
  };
}

module.exports = { createStorePg };
