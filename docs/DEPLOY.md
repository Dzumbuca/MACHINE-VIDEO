# Deploy — Machine Video Social online (Neon + Render)

Guia passo a passo para pôr a aplicação online, **grátis**, sem instalar
nada no teu computador. Tempo total: cerca de 20 minutos, uma única vez.

No fim tens um endereço público (ex.: `https://machine-video.onrender.com`)
que funciona em qualquer navegador, com os dados guardados numa base de
dados PostgreSQL na nuvem (sobrevivem a reinícios do servidor).

O que vais criar (tudo em contas gratuitas):

| Serviço | Para quê | Custo |
| --- | --- | --- |
| **Neon** | Base de dados PostgreSQL (guarda utilizadores, amigos, conversas…) | Grátis |
| **Render** | Corre o servidor e publica o site em HTTPS | Grátis |
| **GitHub** | Guarda o código; o Render vai buscá-lo daí | Grátis |

---

## Passo 1 — O código no GitHub

O Render publica a partir de um repositório GitHub. Se o projeto ainda não
está lá:

1. Cria uma conta em <https://github.com> (se ainda não tens) e depois um
   repositório novo (**New repository**), por exemplo `machine-video`.
2. Carrega o código para lá (pede ajuda a quem preparou o projeto — é um
   comando `git push`). Confirma que o ficheiro `render.yaml` está na raiz.

> ⚠️ O ficheiro `.env` **não** vai para o GitHub (está protegido pelo
> `.gitignore`). As palavras-passe/segredos vivem apenas nos painéis do Neon
> e do Render.

## Passo 2 — Criar a base de dados no Neon (e copiar a DATABASE_URL)

1. Cria conta em <https://neon.com> (**Sign up** — podes usar a conta Google).
2. Ao entrar, o Neon já cria um projeto inicial. Abre-o.
3. No painel do projeto, procura **Connection string** (ou o botão **Connect**)
   e copia a cadeia que começa por `postgres://…` — usa a variante
   **pooled** se te derem a escolher (aguenta melhor o plano grátis).
4. Guarda essa cadeia num bloco de notas temporário. É a tua `DATABASE_URL`
   e deve acabar em `?sslmode=require`. **É um segredo — não a partilhes.**

## Passo 3 — Criar o Web Service no Render

1. Cria conta em <https://render.com> (podes entrar com a conta GitHub).
2. No painel, clica **New +** → **Web Service**.
3. Escolhe **Build and deploy from a Git repository** e liga o repositório
   `machine-video` do Passo 1 (na primeira vez, clica em *Connect* para dar
   permissão ao Render).
4. Preenche o formulário:
   - **Name**: `machine-video` (fica `https://machine-video.onrender.com`);
   - **Language/Runtime**: `Node`;
   - **Branch**: `main`;
   - **Build Command**: `npm install --no-audit --no-fund`;
   - **Start Command**: `npm start`;
   - **Instance Type**: `Free`.

   Se usares o **Blueprint** (New + → **Blueprint**), o ficheiro `render.yaml`
   do repositório preenche tudo isto sozinho — só tens de confirmar.
5. Antes de clicar em **Create Web Service**, abre a secção
   **Environment** (ou adiciona depois em *Environment* → *Add Environment
   Variable*) e cria as variáveis:

   | Key | Value |
   | --- | --- |
   | `DATABASE_URL` | a cadeia `postgres://…` copiada no Passo 2 (cola intacta, com o `?sslmode=require`) |
   | `PORT` | `3000` |

6. Clica em **Create Web Service** (ou **Apply Changes**). O primeiro deploy
   demora 2–4 minutos: vês o registro (*Logs*) a correr até aparecer
   `Machine Video a escutar em http://localhost:3000 (store: Postgres)`.

> Se nos logs aparecer `(store: memória)`, a variável `DATABASE_URL` não foi
> aceite — verifica se colaste a cadeia completa e sem espaços, e faz
> **Manual Deploy → Deploy latest commit** depois de a corrigir.

> **Sanity check da base de dados (uma só vez, contra base descartável):**
> cria uma base PostgreSQL só para isto e corre
> `DATABASE_URL=postgres://… node --test test/store-pg.test.js` — a suite
> faz `TRUNCATE` às tabelas, por isso **nunca** apontes a `DATABASE_URL` de
> produção para os testes.

## Passo 4 — Primeira visita

1. No topo da página do serviço, o Render mostra o endereço público
   (**https://machine-video.onrender.com**). Abre-o.
2. Na primeira visita após um período sem utilização, o plano gratuito
   "acorda" o serviço: **pode demorar cerca de 1 minuto** a responder. É
   normal — a partir daí responde logo.
3. **Health check**: usa `GET /api/health` (ex.:
   <https://machine-video.onrender.com/api/health>, responde `{"ok":true}`) —
   é este o caminho a pôr no *Health Check* do Render/monitor.

## Checklist E2E (critério de sucesso da spec)

Executa esta lista de verificação **depois do deploy, com o dono**, em duas
janelas privadas do navegador (A e B) — cada uma com a sua conta:

- [ ] **Registo**: A e B criam conta (nome, palavra-passe, pergunta de
      segurança) e entram na aplicação.
- [ ] **Recuperação de senha**: em A, "Esqueci-me da senha" → responder à
      pergunta de segurança → nova senha funciona no login.
- [ ] **Amizades**: A adiciona B pelo nome de utilizador → B vê o pedido em
      *pendentes recebidos*, A vê-o em *pendentes enviados* → B aceita → os
      dois aparecem na lista de amigos um do outro.
- [ ] **Duplicados**: tentar adicionar de novo (em qualquer sentido) mostra
      o aviso "já são amigos / pedido pendente" — nada se duplica.
- [ ] **Conversas**: abrem uma conversa e trocam mensagens nos dois sentidos;
      ao recarregar a página (F5) o histórico continua lá.
- [ ] **Presença**: com A online, B vê-o como "online"; ao fechar a janela A,
      B vê-o "offline".
- [ ] **Sessão de filme**: A cria uma sessão e convida B; play/pause/avançar
      no lado A reflete-se no lado B (sincronia).
- [ ] **Chamada**: A liga a B; áudio/vídeo funcionam nos dois sentidos; ao
      desligar, ambos voltam ao estado normal.
- [ ] **Persistência (a prova do Postgres)**: no painel do Render faz
      **Manual Deploy → Deploy latest commit** (reinicia o serviço). Após o
      reinício, todos os dados (contas, amizades, mensagens) e qualquer
      pedido de amizade ainda pendente continuam exatamente como estavam.

Quando tudo estiver marcado, o deploy está validado de ponta a ponta. 🎬

## Problemas comuns

| Sintoma | Causa provável | O que fazer |
| --- | --- | --- |
| Página demora ~1 min à primeira visita | Serviço gratuito "adormecido" | Esperar; após acordar responde logo |
| Logs dizem `(store: memória)` | `DATABASE_URL` em falta/mal colada | Revalidar a variável no Render e fazer redeploy |
| Deploy falha nos logs com erro de ligação | `DATABASE_URL` errada ou projeto Neon suspenso | Recopiar a Connection string do Neon |
| "Application error" ao abrir o site | Falta a variável `PORT` ou deploy antigo | Confirmar `PORT=3000` e fazer redeploy |
| Dados desapareceram | Servidor a correr com store em memória | Ver o aviso `(store: memória)` acima |

## Apontar o domínio/renovar (opcional)

O plano gratuito do Render adormece o serviço após ~15 minutos sem visitas
(acorda em ~1 minuto) e a base de dados gratuita do Neon expira após um
período de inatividade — basta entrar no painel do Neon para a reativar.
Para uso contínuo, os planos pagos de ambos eliminam estas limitações.
