/**
 * GAVETA DE AMIGOS (v1.2) — acessível de qualquer ecrã com um toque (FAB 👥).
 * Lista amigos com presença (online primeiro), pesquisa por nome e ações
 * diretas: 💬 abrir conversa · 🎬 convidar para a sessão ativa (ou escolher
 * filme no catálogo, sem precisar de conversa). Fecha com X, clique fora ou
 * Esc — sem perder o contexto da página.
 */

export function abrirGaveta() {
  const MV = globalThis.window?.MV;
  const doc = globalThis.document;
  if (!MV || !doc) return;

  const nodo = (tag, classe, texto) => {
    const el = doc.createElement(tag);
    if (classe) el.className = classe;
    if (texto != null) el.textContent = texto;
    return el;
  };

  const overlay = nodo('div', 'gaveta-overlay');
  const painel = nodo('aside', 'gaveta-amigos');
  painel.setAttribute('role', 'dialog');
  painel.setAttribute('aria-label', 'Amigos');

  const cabeca = nodo('header', 'gaveta-cabeca');
  cabeca.append(nodo('h2', null, '👥 Amigos'));
  const fecharBotao = nodo('button', 'icon-btn', '✕');
  fecharBotao.type = 'button';
  fecharBotao.addEventListener('click', fechar);
  cabeca.appendChild(fecharBotao);

  const busca = Object.assign(doc.createElement('input'), {
    className: 'input', type: 'search', placeholder: 'Pesquisar amigo…', maxLength: 20,
  });
  busca.setAttribute('aria-label', 'Pesquisar amigo');

  const lista = nodo('div', 'gaveta-lista');

  function fechar() {
    overlay.remove();
    doc.removeEventListener('keydown', aoEscape);
  }
  function aoEscape(e) { if (e.key === 'Escape') fechar(); }
  overlay.addEventListener('click', (e) => { if (e.target === overlay) fechar(); });
  doc.addEventListener('keydown', aoEscape);

  function renderLista() {
    const termo = busca.value.trim().toLowerCase();
    lista.replaceChildren();
    const amigos = [...MV.obterEstado().amigos.values()]
      .filter((a) => !termo || a.username.toLowerCase().includes(termo))
      .sort((x, y) => Number(y.online) - Number(x.online) || x.username.localeCompare(y.username));

    if (amigos.length === 0) {
      lista.appendChild(nodo('p', 'gaveta-vazio', termo ? 'Nenhum amigo com esse nome.' : 'Ainda não tens amigos — adiciona pelo painel Amigos.'));
      return;
    }
    for (const amigo of amigos) {
      const linha = nodo('div', 'gaveta-linha');
      const avatar = nodo('span', 'avatar', amigo.username[0]?.toUpperCase() ?? '?');
      const ponto = nodo('span', 'dot' + (amigo.online ? ' on' : ''));
      avatar.appendChild(ponto);
      const info = nodo('div', 'gaveta-info');
      info.append(
        nodo('strong', null, amigo.username),
        nodo('span', 'gaveta-presenca', amigo.online ? 'online' : 'offline'),
      );
      const acoes = nodo('div', 'gaveta-acoes');
      const conversa = nodo('button', 'btn btn-sm');
      conversa.type = 'button';
      conversa.textContent = '💬';
      conversa.title = 'Abrir conversa';
      conversa.addEventListener('click', () => { fechar(); MV.abrirConversa(amigo.id); });
      const convidar = nodo('button', 'btn btn-primary btn-sm');
      convidar.type = 'button';
      convidar.textContent = '🎬';
      convidar.title = 'Convidar para ver um filme';
      convidar.addEventListener('click', () => { fechar(); MV.convidarAmigo?.(amigo.id, amigo.username); });
      acoes.append(conversa, convidar);
      linha.append(avatar, info, acoes);
      lista.appendChild(linha);
    }
  }

  busca.addEventListener('input', renderLista);

  painel.append(cabeca, busca, lista);
  overlay.appendChild(painel);
  doc.body.appendChild(overlay);
  busca.focus();
  renderLista();
}
