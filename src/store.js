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
 * NOTA (tarefa 11): a store em PostgreSQL é assíncrona — cada método devolve
 * uma Promise (I/O de rede é inerente ao Postgres). Quem consome a store faz
 * `await` em TODAS as chamadas; com a store em memória o `await` é um no-op,
 * pelo que o mesmo código serve as duas implementações.
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
 *   deleteSessionsForUser(userId)                  → undefined (aditivo, passe
 *                final: a recuperação de senha apaga TODAS as sessões do
 *                utilizador — tokens roubados/antigos deixam de valer;
 *                idempotente, e sem erro para um userId sem sessões)
 *   createFriendRequest(fromId, toId)              → pedido
 *   acceptFriendRequest(requestId, toId)           → pedido atualizado
 *   removerPedido(requestId, userId)               → undefined (aditivo,
 *                v1.1: RECUSAR/cancelar — qualquer uma das PARTES remove a
 *                pendência; o par fica livre para novo pedido; inexistente →
 *                E_NOTFOUND; terceiro → E_FORBIDDEN; já aceite → E_DUP)
 *   listFriends(userId)                            → [user]
 *   areFriends(a, b)                               → boolean
 *   listFriendRequests(userId)                     → { pendingIn, pendingOut }
 *                (aditivo, Task 11: pendências de amizade lidas da store, para
 *                sobreviverem a restarts de um servidor persistente.
 *                pendingIn = [{ id, fromUserId, fromUsername, createdAt }],
 *                pendingOut = [{ id, toUserId, toUsername, createdAt }] — só
 *                pedidos com status 'pending', por ordem de criação.
 *                Utilizador desconhecido → E_NOTFOUND.)
 *   createConversation(memberIds, isGroup, title)  → conv
 *   isMember(convId, userId)                       → boolean
 *   listConversations(userId)                      → [conv]
 *   appendMessage(convId, userId, text)            → msg
 *   listMessages(convId, limit, beforeId)          → [msg]
 *
 * Google (v1.1 — login com Google; aditivos):
 *   getUserByGoogleId(googleId)                    → user | null
 *   getUserByEmail(email)                          → user | null
 *   linkGoogleToUser(userId, {googleId, email})    → user (liga conta Google
 *                a um utilizador existente com o mesmo email verificado)
 *   createUserWithGoogle({username, email, googleId}) → user (sem senha nem
 *                pergunta de segurança; o chamador garante username único)
 *   getUserByPhone(telefone)                       → user | null (aditivo,
 *                v1.1: compara o telefone NORMALIZADO — só dígitos e +)
 *   setPhone(userId, telefone)                     → user (aditivo, v1.1:
 *                guarda o telefone; string vazia → remove; <7 ou >15
 *                dígitos → E_INVALID)
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
