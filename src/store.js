'use strict';

/**
 * Contrato do Store — Machine Video Social.
 *
 * O store é injetado em `createServer({ store })` (src/server.js) e usado pelas
 * rotas/WS das tarefas 3–8. Existem duas implementações equivalentes do
 * contrato:
 *   - `src/store-memory.js` → `createStoreMemory()` (Mapas em memória; tarefas 2–10)
 *   - `src/store-pg.js`     → `createStorePg(...)`  (PostgreSQL; tarefa 11)
 * Ambas exportam uma factory e cumprem **exatamente** os métodos abaixo —
 * nomes, parâmetros e retornos não podem ser alterados.
 *
 * Métodos do contrato:
 *   createUser({ username, passHash, secQ, secA }) → user
 *   getUserByUsername(username)                    → user | null
 *   getUserById(id)                                → user | null
 *   updateUserPassword(userId, newPassHash)        → user (aditivo, Task 3:
 *                recuperação de senha; E_NOTFOUND se o userId não existir)
 *   createSession(userId)                          → token (string opaca)
 *   getUserByToken(token)                          → user | null
 *   deleteSession(token)                           → undefined (idempotente)
 *   createFriendRequest(fromId, toId)              → pedido
 *   acceptFriendRequest(requestId, toId)           → pedido atualizado
 *   listFriends(userId)                            → [user]
 *   areFriends(a, b)                               → boolean
 *   createConversation(memberIds, isGroup, title)  → conv
 *   isMember(convId, userId)                       → boolean
 *   listConversations(userId)                      → [conv]
 *   appendMessage(convId, userId, text)            → msg
 *   listMessages(convId, limit, beforeId)          → [msg]
 *
 * Formas dos objetos (mínimo garantido):
 *   user   = { id, username, passHash, secQ, secA, createdAt }
 *   pedido = { id, fromId, toId, status: 'pending' | 'accepted', createdAt }
 *   conv   = { id, memberIds, isGroup, title, createdAt }
 *   msg    = { id, convId, userId, text, ts }
 * Todos os objetos devolvidos são cópias — mutá-los não altera o store.
 * A camada HTTP nunca deve expor `passHash`/`secA` ao cliente.
 *
 * Semântica documentada (vale para ambas as implementações):
 *   - usernames são comparados exatamente (sem normalização); validação de
 *     formato é responsabilidade das rotas.
 *   - `getUserByToken` devolve null para token inválido; apagar um token
 *     inexistente não dá erro.
 *   - amizades são bidirecionais e criadas apenas por `acceptFriendRequest`.
 *   - `listFriends` e `listConversations` devolvem por ordem de criação.
 *   - `listMessages` devolve as mensagens **mais recentes primeiro**;
 *     `beforeId` é o id de uma mensagem da conversa e devolve apenas
 *     mensagens estritamente mais antigas (paginação por cursor). `limit`
 *     opcional (null/undefined = sem limite; ≤ 0 → []). `beforeId` que não
 *     corresponda a nenhuma mensagem da conversa → [] (cursor fora do
 *     intervalo). A ordem usa a inserção, não o relógio, para garantir
 *     estabilidade quando duas mensagens partilham o mesmo `ts`.
 *
 * Erros — StoreError com propriedade `code` estável e mensagem em português:
 *   E_DUP       - username/pedido já existe (ou já são amigos)
 *   E_SELF      - ação sobre si próprio
 *   E_NOTFOUND  - id/token referenciado não existe
 *   E_FORBIDDEN - ação não autorizada (não é destinatário/membro)
 *   E_INVALID   - argumento malformado (memberIds vazio, texto vazio)
 */

class StoreError extends Error {
  /**
   * @param {string} code - código estável do erro (E_DUP, E_SELF, ...)
   * @param {string} message - mensagem legível em português
   */
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

module.exports = { StoreError };
