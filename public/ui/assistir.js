/**
 * Player solo (v1.1) — ver um filme do catálogo SEM sessão, no próprio app.
 * Devolve o nodo pronto para montar na zona principal (sem WS, sem controles
 * partilhados: cada um controla o seu). Inclui legendas próprias e tela cheia.
 */

import { botaoLegendas, botaoTelaCheia } from './legendas.js';

export function montarPlayerSolo({ titulo, url, aoVoltar }) {
  const doc = globalThis.document;
  const nodo = (tag, classe, texto) => {
    const el = doc.createElement(tag);
    if (classe) el.className = classe;
    if (texto != null) el.textContent = texto;
    return el;
  };

  const voltar = nodo('button', 'btn btn-ghost btn-sm');
  voltar.type = 'button';
  voltar.textContent = '← Voltar ao catálogo';
  voltar.addEventListener('click', () => aoVoltar?.());

  const cabeca = nodo('header', 'filme-head');
  const zonaTitulo = nodo('div', 'filme-ident');
  zonaTitulo.append(
    nodo('h2', 'filme-titulo', titulo || 'A ver sozinho'),
    nodo('p', 'filme-ficha', 'Sessão individual — para ver com amigos, usa "👥 Chamar amigos" no catálogo'),
  );
  cabeca.append(zonaTitulo, voltar);

  const palco = nodo('div', 'filme-palco');
  const video = nodo('video', 'filme-video');
  video.playsInline = true;
  video.controls = true;
  video.src = url;
  video.addEventListener('error', () => {
    palco.replaceChildren(nodo('p', 'form-erro', 'Não foi possível carregar o vídeo deste link.'));
  });
  palco.appendChild(video);

  // Legendas próprias + tela cheia (v1.1) — importados de ui/legendas.js.
  const controles = nodo('div', 'filme-controles');
  controles.append(botaoLegendas(video), botaoTelaCheia(video));

  const raiz = doc.createElement('div');
  raiz.className = 'filme catalogo';
  raiz.append(cabeca, palco, controles);
  return raiz;
}
