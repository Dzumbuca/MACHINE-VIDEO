-- Schema idempotente da store em PostgreSQL — Machine Video Social (Task 11).
--
-- Corre no boot (createStorePg, chamado por src/db.js no arranque e pelos
-- testes de test/store-pg.test.js). `IF NOT EXISTS` em tudo: reexecutar
-- nunca falha nem altera tabelas existentes.
--
-- Notas de desenho (contrato em src/store.js):
--  - friendships guarda o par NORMALIZADO (user_a < user_b) com UNIQUE:
--    uma amizade é uma linha só, impossível duplicar mesmo sob concorrência.
--  - friend_requests tem índice único parcial sobre o par (qualquer direção)
--    APENAS para status='pending': replica atomicamente a regra "não há
--    segundo pedido pendente entre o mesmo par" (o SELECT + INSERT da store
--    em memória não seria atómico aqui). Violação → 23505 → E_DUP.
--  - Colunas `seq` BIGSERIAL em friendships/friend_requests/conversations/
--    messages: as listagens seguem a ORDEM DE INSERÇÃO (não o relógio), como
--    o contrato exige — estável quando dois registos partilham o mesmo ts.
--  - conversation_members.position preserva a ordem dos memberIds tal como a
--    store em memória (dedup mantendo a 1.ª ocorrência).

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  pass_hash TEXT,        -- NULL para contas que só entram com o Google (v1.1)
  sec_q TEXT,            -- NULL para contas Google (v1.1)
  sec_a TEXT,            -- NULL para contas Google (v1.1)
  email TEXT,            -- v1.1 (adicionado por ALTER abaixo)
  google_id TEXT,        -- v1.1 (adicionado por ALTER abaixo)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS friendships (
  seq BIGSERIAL PRIMARY KEY,
  user_a TEXT NOT NULL REFERENCES users(id),
  user_b TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (user_a < user_b),
  UNIQUE (user_a, user_b)
);

CREATE TABLE IF NOT EXISTS friend_requests (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL REFERENCES users(id),
  to_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  seq BIGSERIAL NOT NULL UNIQUE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pedidos_pendentes_par
  ON friend_requests (least(from_id, to_id), greatest(from_id, to_id))
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  is_group BOOLEAN NOT NULL,
  title TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  seq BIGSERIAL NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conv_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  position INTEGER NOT NULL,
  PRIMARY KEY (conv_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_conversation_members_user
  ON conversation_members (user_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conv_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  seq BIGSERIAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv_seq ON messages (conv_id, seq);

-- v1.1 — login com Google (colunas aditivas, idempotentes)
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT;
-- Contas Google não têm senha nem pergunta de segurança: as colunas passam a
-- aceitar NULL (idempotente — DROP NOT NULL em coluna já anulável é no-op).
ALTER TABLE users ALTER COLUMN pass_hash DROP NOT NULL;
ALTER TABLE users ALTER COLUMN sec_q DROP NOT NULL;
ALTER TABLE users ALTER COLUMN sec_a DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id
  ON users (google_id) WHERE google_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email
  ON users (email) WHERE email IS NOT NULL;

-- v1.1 — descoberta de amigos por telefone (aditivo, idempotente)
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone
  ON users (phone) WHERE phone IS NOT NULL;

-- v1.1 — perfis público/privado (aditivo, idempotente): 'publico' aparece em
-- qualquer busca; 'privado' só é encontrado por email ou telefone.
ALTER TABLE users ADD COLUMN IF NOT EXISTS visibilidade TEXT NOT NULL DEFAULT 'publico';
