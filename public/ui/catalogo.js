/**
 * Catálogo de clássicos em DOMÍNIO PÚBLICO (Internet Archive) — links MP4
 * diretos, verificados a 200 (video/mp4) em 21/10/2026. Legal e grátis:
 * domínio público significa que qualquer pessoa pode reproduzir.
 *
 * Fonte dos links: archive.org/download/<id>/<ficheiro> — a API de metadados
 * (archive.org/metadata/<id>) lista os ficheiros de cada item.
 */

export const CATALOGO_CLASSICOS = [
  {
    titulo: 'His Girl Friday (1940) — comédia com Cary Grant',
    url: 'https://archive.org/download/his_girl_friday/his_girl_friday_512kb.mp4',
  },
  {
    titulo: 'Charlie Chaplin Festival (1918–1923) — comédia',
    url: 'https://archive.org/download/charlie_chaplin_film_fest/charlie_chaplin_film_fest_512kb.mp4',
  },
  {
    titulo: 'Jungle Book (1942) — aventura',
    url: 'https://archive.org/download/JungleBook/Jungle_Book_512kb.mp4',
  },
  {
    titulo: 'Suddenly (1954) — thriller com Frank Sinatra',
    url: 'https://archive.org/download/suddenly/suddenly_512kb.mp4',
  },
  {
    titulo: 'The Stranger (1946) — drama de Orson Welles',
    url: 'https://archive.org/download/TheStranger_0/The_Stranger_512kb.mp4',
  },
  {
    titulo: 'House on Haunted Hill (1959) — terror com Vincent Price',
    url: 'https://archive.org/download/house_on_haunted_hill_ipod/house_on_haunted_hill_512kb.mp4',
  },
];

/** Cria um <select> com o catálogo; ao escolher, chama aoEscolher(item). */
export function seletorCatalogo(aoEscolher) {
  const doc = globalThis.document;
  const sel = doc.createElement('select');
  sel.className = 'input';
  sel.setAttribute('aria-label', 'Catálogo de clássicos em domínio público');
  const placeholder = doc.createElement('option');
  placeholder.textContent = '— Ou escolha um clássico grátis (domínio público) —';
  placeholder.value = '';
  sel.appendChild(placeholder);
  for (const item of CATALOGO_CLASSICOS) {
    const opcao = doc.createElement('option');
    opcao.textContent = item.titulo;
    opcao.value = item.url;
    sel.appendChild(opcao);
  }
  sel.addEventListener('change', () => {
    const escolhido = CATALOGO_CLASSICOS.find((i) => i.url === sel.value);
    if (escolhido) aoEscolher(escolhido);
  });
  return sel;
}
