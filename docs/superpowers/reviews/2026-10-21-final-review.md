# Final whole-branch review — Machine Video Social (861e937)

Reviewer: independent final-branch review. Read-only; no tree/index/HEAD mutation.
Method: reviewed the 10,461-line diff in 7 passes myself (no subagents): (1) server core
(server/routes/http-util/store contract), (2) both store implementations, (3) auth/friends/chat,
(4) WS hub + presence + signal + session, (5) pg layer + schema, (6) full client
(index/api/ws/app/views/auth/call/movie), (7) tests + deploy artifacts; plus cross-cutting
greps (secrets, XSS vectors, Review Focus anchors), a full `node --test` run (99 tests:
90 pass + 9 skip pg, 0 fail — matches the claim), and git history checks (16 commits, clean
tree, 46 files / 10,159 insertions confirmed against the empty-tree base).

## Strengths

- **Spec/plan alignment is complete.** All G1–G5 are implemented end to end. Every deviation
  from the plan (call_ack, session_created ack, listFriendRequests additive method, T4.5
  http-util extraction, R10 drift semantics, R2 ≥1 invitee) is a documented, sanctioned ledger
  ruling — I found no undocumented deviations. Global constraints hold: prod deps exactly
  ws/bcryptjs/pg, tokens 32 random bytes, .env ignored, PORT from env, files < 500 lines,
  dark PT-PT UI titled "Machine Video".
- **Security fundamentals are right.** All SQL is parameterized (verified line-by-line in
  store-pg.js); all dynamic DOM text goes through textContent (views.js, call.js nodo(), etc.;
  innerHTML only for static SVG constants); every REST handler calls exigirSessao; the WS hub
  closes unauthenticated sockets (5 s timeout, any other type closes); conversations are
  gated by isMember, calls/sessions by areFriends, request acceptance by toId. Token is in
  localStorage with no cookie → CSRF surface is nil. Path traversal in static serving is
  correctly blocked (decodeURIComponent + normalize + startsWith, including backslash/absolute
  tricks on Windows).
- **The dual-store layer is genuinely well engineered.** store.js documents the contract
  (copy semantics, ordering by insertion, error codes); schema-pg.sql is thoughtfully designed
  (normalized friendship pairs with CHECK/UNIQUE, partial unique index replicating the
  "one pending request per pair" rule atomically, BIGSERIAL seq columns for stable
  insertion-order listings); store-pg runs the identical shared scenario suite
  (test/.helpers/store-scenarios.js) as the memory store, and pg-specific failure modes
  (E_DUP on 23505) map to the same contract errors. Transactions with rollback are used where
  correctness needs them.
- **The WS hub is defensive in the right places.** Per-socket serial processing chain (order
  preserved under async pg), per-user presence announcement serialization (fixes the Task 11
  race), never-throws send helpers, E_INTERNAL safety nets at every layer, wss/ws 'error'
  handlers so a socket error can't kill the process. The Task 11 Critical (deleteSession
  42P02) was fixed correctly in 861e937 and is now guarded by a static regression test
  (placeholder-queries-must-pass-values) that runs even without DATABASE_URL.
- **Client quality exceeds the brief.** Full a11y touches (role=log/tablist, aria-labels,
  keyboard activation on friend rows, aria-live toasts), busy-button states, scroll-anchored
  "load older" pagination, reconnect backoff 1→8 s with dead-state detection, deterministic
  anti-glare mesh (lower ID offers) with per-pair ICE queues, graceful 'failed' connection
  handling, drift correction to the *expected* position (R10), objectURL hygiene (create/revoke
  paired), autoplay-block recovery toast.
- **Deploy docs are owner-usable.** DEPLOY.md is genuinely step-by-step for a non-technical
  person (accounts → Neon string → Render form → env table → E2E checklist → troubleshooting
  table), render.yaml is a working Blueprint, .env.example explains sslmode and pooled
  connection strings. The store-selection log line `(store: Postgres|memória)` doubles as the
  owner's deploy sanity check.
- **Tests verify behavior, not implementation.** Real integration tests over the actual HTTP
  server and WS hub (ephemeral ports), negative paths for all five Review Focus items
  (409 dup, WS-unauth closed, 403 cross-member, E_NOT_HOST, E_BADJSON survive), a Node-side
  smoke test that imports the real client ES modules with minimal browser shims, and the
  shared store-contract suite run against both implementations.

## Issues

### Critical (Must Fix)

None found. I looked specifically for: SQL injection (none — parameterized throughout),
XSS vectors (none — textContent everywhere), auth bypass (none — every surface gated),
IDOR (none — membership/friendship/recipient checks precede every data read),
token handling weaknesses (32 random bytes, bearer-only, deleted on logout),
WS abuse (one Important below), data-loss paths in the pg layer (none found —
the 42P02 class is fixed and guarded).

### Important (Should Fix)

1. **Same-account multi-device/multi-tab chat misses live messages** — src/chat.js:243-246
   (diffusion) and :239 (echo). The sender's message is echoed only to the originating socket
   (`enviarDireto(ws, pacote)`) and the diffusion loop skips the sender's userId entirely
   (`if (membro === user.id) continue`). The server keeps one token per login and one socket
   set per user (presence is already multi-tab), so a user logged in on phone + PC — or two
   tabs — does not see their own messages on the other device until reload. Every mainstream
   chat app syncs your own messages across your devices; a reasonable person expects that here.
   Fix is small: echo to all of the sender's sockets *except* the originating one
   (e.g. `presenca.sockets(user.id).filter(s => s !== ws)`), keep the member loop skipping the
   sender. Note the same exclusion does **not** exist for calls/sessions (those correctly
   fan out to all of a user's sockets), which makes the chat asymmetry look accidental rather
   than designed.
2. **No maxPayload on the WebSocket server** — src/server.js:21 (attach() passes no
   wsOptions in production). `ws` defaults to 100 MiB per message, and frames are accepted
   *before* authentication (the pre-auth branch parses any frame to look for `auth`). A handful
   of concurrent 100 MiB frames from anonymous connections will OOM a 512 MB Render free-tier
   container → crash loop. One-line fix: default `maxPayload: 1024*1024` (1 MiB is generous —
   SDP+ICE payloads are a few KB; the client caps chat text at 2,000 chars) inside attach()
   defaults. While there, cap `text` server-side in chat_send (the HTTP path caps at 64 KiB;
   the WS path is unbounded into Postgres).
3. **No rate limiting on public auth endpoints** — src/auth.js (register/login/recover).
   The service will sit on a public HTTPS URL; login and recover (security-answer guessing)
   are unlimited-guess, and each attempt costs a bcrypt round (~50-100 ms), so it doubles as a
   cheap CPU DoS on the free tier. A minimal in-memory limiter (e.g. 10 attempts / 5 min per
   IP+username) is ~30 lines and proportionate to v1.
4. **Password recovery does not invalidate existing sessions** — src/auth.js:111-126. The
   Task 3 ledger explicitly said "sessões não invalidadas na troca de senha (reavaliar antes
   da T11)"; it was not re-evaluated and remains: after a successful recover, all old tokens
   keep working, so recovering a compromised account does not actually evict the attacker.
   Cheap fix: delete the user's sessions on recover (additive store method, mirrors the
   updateUserPassword pattern), or accept it consciously for v1 and re-note it.

### Minor (Nice to Have)

1. **`?limit=` overflow → 500** — src/chat.js:149 + src/store-pg.js:449. The ledger deferred
   minor claimed the SQL-error path was "unreachable via routes"; it isn't: `?limit=99999999999999999999`
   passes the `/^\d+$/` check, becomes 1e20, and overflows Postgres bigint in `LIMIT $n` → 500.
   Clamp to e.g. 200 (also matches the memory store's no-harm behavior).
2. **Spec's free-tier sleep warning isn't in the UI** — spec "Decisões minhas" says the ~1 min
   wake-up is "avisada na UI"; it's documented only in DEPLOY.md. The generic "Servidor
   indisponível" toast covers the symptom but not the explicit notice. One static hint on the
   auth screen satisfies the spec.
3. **`WebM duration === Infinity` edge** — public/movie.js:116-133. Some progressive WebM
   files report `duration: Infinity` on loadedmetadata even as blob URLs, which this code
   mislabels as "formato não suportado". The standard `currentTime = 1e101` workaround on
   Infinity would prevent false rejections.
4. **Sessions table never expires; WS accepts any path** — src/schema-pg.sql (sessions rows
   accumulate forever) and src/server.js:21 (no `path: '/ws'` restriction on the upgrade).
   Hygiene only.
5. **Static-serving 500s on directories** (EISDIR, deferred T1) and POST-to-unknown-path
   returns 405 rather than 404 with Allow cosmetics — cosmetic contract noise.
6. **session map never garbage-collects host-abandoned sessions** — src/session.js: sessions
   end only on explicit host leave; a host who closes the browser leaves state until process
   restart. Small object per session, free tier restarts often — acceptable, but a
   disconnect-triggered end (or TTL) would be cleaner.
7. **chat fan-out cost** — src/chat.js:214: every chat_send does a full
   `listConversations(userId)` query to find memberIds. Fine at friend-circle scale; a
   getConversation(convId) additive store method would remove it later.
8. **Clock skew directly offsets drift correction** — public/movie.js:61-67: expected position
   uses the guest's Date.now() against the host's atMs. NTP-synced machines are usually within
   tolerance, but a server receive-timestamp in session_control would make drift independent of
   client clocks.

## Deferred-minors triage (from progress.md)

**Fix before the owner deploys and invites friends:**
- T5 "sem maxPayload no WSS" → one line, closes the only pre-auth availability hole (Issue 2).
- T3 "sessões não invalidadas na troca de senha" → the ledger itself said re-evaluate before
  T11; recovery is v1's only account-recovery path (Issue 4).
- T9 "sairLocal não limpa token" → trivial (`limparToken()` in sairLocal); stale tokens in
  localStorage on a shared computer are exactly the scenario recover is meant to solve.

**Can wait (post-deploy backlog), with reasons:**
- T5 silent error handlers / T9 dead-state conflation / sleeps-in-tests / no-op notStrictEqual /
  report line-count inaccuracies — observability and flake hygiene; nothing user-visible.
- T1 EISDIR→500, 405 cosmetics; T2 pagination-boundary tests; T4/T6 untested error branches —
  real but small coverage gaps; behavior is correct by reading.
- T3 username enumeration (404 vs 401), timing side-channel, bcrypt 72-byte truncation —
  friend-circle threat model makes these low-value; note for v2.
- T7 media unvalidated, T8 offline-invite untested, T10 modal stacking / createOffer retry /
  permission-prompt race / aoSair callback accumulation / dead CSS rule — all single-rare-case
  UI edges, each documented in the ledger with its failure mode.
- T10 ">6th participant no tile (audio doesn't play)" — documented v1 limitation; consider an
  explicit toast when a group exceeds 6.
- T11 render.yaml PORT=3000 / shutdown without timeout / listMessages pg non-numeric limit —
  PORT pinning works on Render blueprints (platform uses the PORT var), but remove it if the
  first deploy shows "Application error"; the pg limit one is reachable only via the huge-number
  edge (Minor 1).
- T2/T6 "?limit vs ?before empty asymmetry" — document or align; harmless today.

## Recommendations

1. **Run the 9 skipped pg tests once against a real Postgres before deploy.** This is the
   single biggest residual deploy risk: the static regression test only proves
   placeholder/values pairing, not SQL validity. Any Neon test project (or `docker run postgres`)
   + `DATABASE_URL=... node --test` turns 9 skips into 9 passes and exercises every query,
   the schema, and the transaction paths. Five minutes of work, removes the class of
   "works in memory, fails on Neon" surprises (the exact class the 861e937 bug came from).
2. Batch the four Important fixes into one small commit (chat multi-device echo, maxPayload,
   auth rate limiter, recover-invalidates-sessions) — all server-side, all covered by the
   existing test style, together well under an hour.
3. Add `GET /api/health` to Render's health-check path (it exists and is perfect for it) so a
   misconfigured DATABASE_URL fails the deploy visibly instead of serving a broken app.
4. For v2: server receive-timestamps in session_control (drift without clock skew), a
   getConversation store method, WS message-size + text-length caps, and per-IP limiter for
   the whole /api.

## Declined to judge

- Audio/video quality, ICE success rates, TURN-less NAT traversal outcomes — cannot be
  evaluated from source; requires live calls across real networks (spec accepts the risk).
- Visual/UX quality of the dark theme — spec says "tema escuro" and it is; aesthetic judgment
  out of scope for this review.
- The owner's manual 2-browser checklist results (ledger pending item) — execution, not code.
- Neon "scales to zero" cold-start latency and Render free-tier spin-up behavior — platform
  behavior, documented by the deploy docs; not verifiable from this branch.
- browser-dependent getUserMedia permission flows and mobile Safari/Chrome quirks — runtime
  environment behavior, outside the diff.
- The choice of vanilla ES modules over a framework — explicitly left to the builder by the
  spec ("O que fica para o builder").
- Portuguese PT-PT/AO phrasing quality beyond the mandated vocabulary ("telemóvel",
  "utilizador" confirmed present) — language style, not a requirement.
- package-lock.json dependency freshness/vulnerability audit of transitive deps (bcryptjs 3.x,
  pg 8.23, ws 8.22 are current majors) — supply-chain scanning is a separate process step.

## Assessment

**Ready to merge?** With fixes.

**Reasoning:** The branch is a coherent, well-layered implementation that meets G1–G5, honors
every sanctioned ruling, and is security-sound on the axes that matter (injection, XSS, authz,
token handling); tests are real and passing. The four Important findings — multi-device chat
echo, WS maxPayload, auth rate limiting, recover-doesn't-invalidate-sessions — are all small,
server-side, pre-deploy-quality fixes rather than structural flaws, and should land before the
owner exposes the service and invites friends.
