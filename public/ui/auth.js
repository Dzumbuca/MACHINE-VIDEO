/**
 * ui/auth.js — ecrã de entrada do Machine Video (Task 9).
 *
 * Liga os três formulários do esqueleto estático (index.html):
 *   - Entrar: username + senha → POST /api/login;
 *   - Criar conta: username, senha, pergunta e resposta de segurança →
 *     POST /api/register e, em caso de sucesso, início de sessão automático;
 *   - Recuperar: username, resposta de segurança e nova senha → POST /api/recover
 *     (a pergunta em si nunca sai do servidor — só a resposta é verificada).
 *
 * Em sucesso chama `aoEntrar(user)`; em falha mostra `erro` do backend, que
 * chega sempre em português.
 */

import { api, guardarToken } from '../api.js';

const $ = (id) => document.getElementById(id);

function mostrarErro(paragrafo, mensagem) {
  paragrafo.textContent = mensagem;
  paragrafo.hidden = false;
}

function limparErro(paragrafo) {
  paragrafo.hidden = true;
  paragrafo.textContent = '';
}

/** Texto do botão durante o pedido (evita cliques duplos). */
async function comBotaoOcupado(botao, texto, acao) {
  const original = botao.textContent;
  botao.disabled = true;
  botao.textContent = texto;
  try {
    return await acao();
  } finally {
    botao.disabled = false;
    botao.textContent = original;
  }
}

/**
 * Liga o ecrã de autenticação. Idempotente: chamar de novo não duplica
 * handlers (importante após terminar sessão e voltar a este ecrã).
 */
export function montarAuth({ aoEntrar } = {}) {
  if (montarAuth._ligado) return;
  montarAuth._ligado = true;

  const abas = {
    entrar: { botao: $('auth-tab-entrar'), formulario: $('form-entrar') },
    criar: { botao: $('auth-tab-criar'), formulario: $('form-criar') },
    recuperar: { botao: null, formulario: $('form-recuperar') },
  };

  function mostrar(nomeAba) {
    for (const [nome, { botao, formulario }] of Object.entries(abas)) {
      const ativo = nome === nomeAba;
      formulario.hidden = !ativo;
      if (botao) {
        botao.classList.toggle('is-active', ativo);
        botao.setAttribute('aria-selected', String(ativo));
      }
    }
    $('auth-tab-entrar').setAttribute('aria-selected', String(nomeAba === 'entrar'));
    $('auth-tab-criar').setAttribute('aria-selected', String(nomeAba === 'criar'));
  }

  abas.entrar.botao.addEventListener('click', () => mostrar('entrar'));
  abas.criar.botao.addEventListener('click', () => mostrar('criar'));
  $('link-recuperar').addEventListener('click', () => mostrar('recuperar'));
  $('link-voltar-entrar').addEventListener('click', () => mostrar('entrar'));

  // --- Entrar com Google (v1.1) ----------------------------------------------

  // O botão só aparece se o servidor tiver credenciais Google configuradas.
  fetch('/api/auth/providers')
    .then((r) => r.json())
    .then((p) => {
      if (p && p.ok && p.google) $('btn-google').hidden = false;
    })
    .catch(() => {}); // sem servidor: botão fica escondido
  $('btn-google').addEventListener('click', () => {
    window.location.assign('/api/auth/google/start');
  });

  $('form-entrar').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const erro = $('entrar-erro');
    limparErro(erro);
    try {
      const username = $('entrar-utilizador').value.trim();
      const password = $('entrar-senha').value;
      const dados = await comBotaoOcupado(
        evento.submitter ?? erro.nextElementSibling, // botão Entrar
        'A entrar…',
        () => api.entrar(username, password),
      );
      guardarToken(dados.token);
      $('form-entrar').reset();
      aoEntrar(dados.user);
    } catch (e) {
      mostrarErro(erro, e.erro || 'Não foi possível entrar. Tente de novo.');
    }
  });

  // --- Criar conta -------------------------------------------------------------

  $('form-criar').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const erro = $('criar-erro');
    limparErro(erro);

    const username = $('criar-utilizador').value.trim();
    const password = $('criar-senha').value;
    const secQuestion = $('criar-pergunta').value.trim();
    const secAnswer = $('criar-resposta').value.trim();

    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
      mostrarErro(erro, 'O nome de utilizador deve ter 3 a 20 caracteres (letras, números ou _)');
      return;
    }
    if (password.length < 6) {
      mostrarErro(erro, 'A senha deve ter pelo menos 6 caracteres');
      return;
    }
    if (secQuestion === '' || secAnswer === '') {
      mostrarErro(erro, 'Preencha a pergunta e a resposta de segurança');
      return;
    }

    try {
      await comBotaoOcupado(evento.submitter ?? erro.nextElementSibling, 'A criar…', () =>
        api.registar({ username, password, secQuestion, secAnswer }),
      );
      // Conta criada: entra automaticamente com as mesmas credenciais.
      const dados = await api.entrar(username, password);
      guardarToken(dados.token);
      $('form-criar').reset();
      aoEntrar(dados.user);
    } catch (e) {
      mostrarErro(
        erro,
        e.erro === 'Credenciais inválidas'
          ? 'Conta criada. Entre manualmente para continuar.'
          : e.erro || 'Não foi possível criar a conta.',
      );
      if (e.status === 409) $('criar-utilizador').focus();
    }
  });

  // --- Recuperar senha -----------------------------------------------------------

  $('form-recuperar').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const erro = $('recuperar-erro');
    limparErro(erro);
    const username = $('recuperar-utilizador').value.trim();
    const secAnswer = $('recuperar-resposta').value;
    const newPassword = $('recuperar-senha').value;
    if (newPassword.length < 6) {
      mostrarErro(erro, 'A nova senha deve ter pelo menos 6 caracteres');
      return;
    }
    try {
      await comBotaoOcupado(evento.submitter ?? erro.nextElementSibling, 'A redefinir…', () =>
        api.recuperar({ username, secAnswer, newPassword }),
      );
      $('form-recuperar').reset();
      mostrar('entrar');
      $('entrar-utilizador').value = username;
      $('entrar-senha').focus();
      limparErro(erro);
      // Reaproveita o bloco de erro do formulário Entrar como aviso de sucesso.
      $('entrar-erro').hidden = false;
      $('entrar-erro').textContent = 'Senha redefinida com sucesso. Entre com a nova senha.';
    } catch (e) {
      mostrarErro(erro, e.erro || 'Não foi possível redefinir a senha.');
    }
  });
}

/** Limpa o estado dos formulários (ao terminar sessão). */
export function reporAuth() {
  for (const id of ['form-entrar', 'form-criar', 'form-recuperar']) {
    document.getElementById(id).reset();
  }
  for (const id of ['entrar-erro', 'criar-erro', 'recuperar-erro']) {
    const p = document.getElementById(id);
    p.hidden = true;
    p.textContent = '';
  }
  document.getElementById('entrar-utilizador').focus();
}
