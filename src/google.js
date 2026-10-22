'use strict';

/**
 * OAuth "Entrar com Google" (v1.1).
 *
 * Fluxo (authorization code):
 *   GET /api/auth/google/start     → 302 para o consentimento do Google
 *   GET /api/auth/google/callback  → troca o código por id_token, encontra ou
 *     cria o utilizador (por google_id, depois por email verificado → liga
 *     contas) e devolve a sessão ao cliente em `/#auth=<token>` (fragmento —
 *     nunca viaja para o servidor nem para logs).
 *
 * Ativação: env vars GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET. Sem elas, o
 * botão some (providers → false) e o start responde 501.
 *
 * Erros voltam sempre ao cliente como `/#erro=google` — o ecrã de entrada
 * mostra o aviso; nunca expõem detalhes do OAuth.
 */

const crypto = require('node:crypto');

const AUTORIZACAO_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ESTADO_TTL_MS = 10 * 60 * 1000; // 10 minutos

function createGoogleHandlers({ store }) {
  // Estados CSRF pendentes: state → criadoEm (limpeza lazy a cada uso).
  const estados = new Map();

  function configurado() {
    return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  }

  function providers() {
    return { google: configurado() };
  }

  /** Origem do pedido (Render/Neon proxy: x-forwarded-proto tem prioridade). */
  function origem(req) {
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers.host || 'localhost';
    return `${proto}://${host}`;
  }

  function redirectUri(req) {
    return `${origem(req)}/api/auth/google/callback`;
  }

  function limparEstadosAntigos() {
    const agora = Date.now();
    for (const [state, criadoEm] of estados) {
      if (agora - criadoEm > ESTADO_TTL_MS) estados.delete(state);
    }
  }

  async function iniciar(req, res) {
    if (!configurado()) {
      res.writeHead(501, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: false,
        erro: 'Entrada com Google não está configurada neste servidor.',
      }));
      return;
    }
    limparEstadosAntigos();
    const state = crypto.randomBytes(16).toString('hex');
    estados.set(state, Date.now());
    const url = new URL(AUTORIZACAO_URL);
    url.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID);
    url.searchParams.set('redirect_uri', redirectUri(req));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', state);
    url.searchParams.set('prompt', 'select_account');
    res.writeHead(302, { Location: url.toString() });
    res.end();
  }

  /**
   * Encontra ou cria o utilizador do Google:
   *   1. google_id conhecido → login;
   *   2. email verificado igual a um utilizador existente → liga as contas;
   *   3. novo utilizador com username derivado do email (único, com sufixo).
   */
  async function encontrarOuCriarUtilizador(perfil) {
    const { sub, email } = perfil;
    const porGoogleId = await store.getUserByGoogleId(sub);
    if (porGoogleId) return porGoogleId;

    const porEmail = await store.getUserByEmail(email);
    if (porEmail) {
      return store.linkGoogleToUser(porEmail.id, { googleId: sub, email });
    }

    // Username a partir da parte local do email: só [A-Za-z0-9_], 3–20 chars.
    const base = (email.split('@')[0] || 'utilizador')
      .replace(/[^A-Za-z0-9_]/g, '')
      .slice(0, 16)
      .padEnd(3, '1');
    let candidato = base || 'utilizador1';
    for (let n = 2; await store.getUserByUsername(candidato); n += 1) {
      candidato = `${base}${n}`.slice(0, 20);
    }
    return store.createUserWithGoogle({ username: candidato, email, googleId: sub });
  }

  async function callback(req, res, url) {
    const destinoErro = `${origem(req)}/#erro=google`;
    try {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const estadoGuardado = estados.get(state || '');
      estados.delete(state || '');
      if (!code || !estadoGuardado || Date.now() - estadoGuardado > ESTADO_TTL_MS) {
        console.error('Google callback: falhou em STATE — ausente, expirado (>10 min) ou perdido num reinício do serviço.');
        res.writeHead(302, { Location: destinoErro });
        res.end();
        return;
      }

      const respostaToken = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          redirect_uri: redirectUri(req),
          grant_type: 'authorization_code',
        }),
      });
      if (!respostaToken.ok) {
        const corpo = await respostaToken.text().catch(() => '');
        console.error('Google callback: falhou em TOKEN —', respostaToken.status, corpo.slice(0, 300));
        res.writeHead(302, { Location: destinoErro });
        res.end();
        return;
      }
      const tokens = await respostaToken.json();
      // O id_token veio DIRECTAMENTE do endpoint de tokens do Google por
      // HTTPS (resposta do nosso pedido com o nosso client_secret) — decodificar
      // o payload sem verificar assinatura é o fluxo recomendado pelo Google
      // para este caso. Verificar via JWKS só seria necessário se o id_token
      // tivesse vindo do navegador.
      const payload = JSON.parse(
        Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString('utf8'),
      );
      if (!payload.sub || !payload.email || payload.email_verified === false) {
        console.error('Google callback: falhou em PERFIL — sub/email ausentes ou email não verificado');
        res.writeHead(302, { Location: destinoErro });
        res.end();
        return;
      }

      const user = await encontrarOuCriarUtilizador(payload);
      const token = await store.createSession(user.id);
      res.writeHead(302, { Location: `${origem(req)}/#auth=${token}` });
      res.end();
    } catch (erro) {
      // Qualquer falha (rede, Google em baixo, formato inesperado) volta ao
      // ecrã de entrada com aviso — o servidor nunca fica exposto.
      console.error('Google callback: falhou inesperadamente —', erro && erro.message ? erro.message : erro);
      res.writeHead(302, { Location: destinoErro });
      res.end();
    }
  }

  return { providers, iniciar, callback };
}

module.exports = { createGoogleHandlers };
