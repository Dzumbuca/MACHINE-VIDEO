/**
 * Catálogo de filmes GRÁTIS e LEGAIS do Machine Video (v1.1).
 *
 * Fontes: domínio público (Internet Archive) + animações CC da Blender
 * Foundation + Sita Sings the Blues (CC0, Nina Paley). TODOS os links MP4
 * foram verificados (200 video/mp4) em 22/10/2026.
 *
 * A Home (aba 🎬 Filmes) mostra esta grelha: escolher um filme → ver sozinho
 * ou chamar amigos (cria uma sessão sincronizada com o link direto).
 */

export const CATALOGO = [
  // --- 🎨 Animação (Creative Commons — Blender Foundation e Nina Paley) ---
  { titulo: 'Sintel', ano: 2010, categoria: 'Animação', descricao: 'Fantasia de aventura da Blender — qualidade de cinema', url: 'https://archive.org/download/Sintel/sintel-2048-stereo_512kb.mp4' },
  { titulo: 'Big Buck Bunny', ano: 2008, categoria: 'Animação', descricao: 'O coelho gigante e os roedores valentões — clássico CC', url: 'https://archive.org/download/BigBuckBunny_124/Content/big_buck_bunny_720p_surround.mp4' },
  { titulo: 'Elephants Dream', ano: 2006, categoria: 'Animação', descricao: 'O primeiro filme aberto do mundo (Blender)', url: 'https://archive.org/download/ElephantsDream/ed_1024_512kb.mp4' },
  { titulo: 'Cosmos Laundromat — First Cycle', ano: 2015, categoria: 'Animação', descricao: 'Carneiro suicida encontra o bizarríssimo Frank', url: 'https://archive.org/download/CosmosLaundromatFirstCycle/Cosmos%20Laundromat%20-%20First%20Cycle%20(1080p).mp4' },
  { titulo: 'Sita Sings the Blues', ano: 2008, categoria: 'Animação', descricao: 'A épica do Ramayana em jazz — obra-prima CC0', url: 'https://archive.org/download/Sita_Sings_the_Blues/Sita_Sings_the_Blues_DVD_NTSC4.mp4' },
  // --- 🎬 Clássicos (domínio público) ---
  { titulo: 'His Girl Friday', ano: 1940, categoria: 'Clássicos', descricao: 'Comédia de repartição com Cary Grant', url: 'https://archive.org/download/his_girl_friday/his_girl_friday_512kb.mp4' },
  { titulo: 'Charlie Chaplin Festival', ano: 1918, categoria: 'Clássicos', descricao: 'Vários curtas do mestre do cinema mudo', url: 'https://archive.org/download/charlie_chaplin_film_fest/charlie_chaplin_film_fest_512kb.mp4' },
  { titulo: 'Jungle Book', ano: 1942, categoria: 'Clássicos', descricao: 'Aventura na selva dos irmãos Korda', url: 'https://archive.org/download/JungleBook/Jungle_Book_512kb.mp4' },
  { titulo: 'Suddenly', ano: 1954, categoria: 'Clássicos', descricao: 'Thriller de reféns com Frank Sinatra', url: 'https://archive.org/download/suddenly/suddenly_512kb.mp4' },
  { titulo: 'The Stranger', ano: 1946, categoria: 'Clássicos', descricao: 'Drama de Orson Welles sobre um nazi escondido', url: 'https://archive.org/download/TheStranger_0/The_Stranger_512kb.mp4' },
  { titulo: 'House on Haunted Hill', ano: 1959, categoria: 'Clássicos', descricao: 'Terror de Vincent Price numa mansão amaldiçoada', url: 'https://archive.org/download/house_on_haunted_hill_ipod/house_on_haunted_hill_512kb.mp4' },
  { titulo: 'The General', ano: 1926, categoria: 'Clássicos', descricao: 'Buster Keaton na guerra civil — obra-prima do slapstick', url: 'https://archive.org/download/TheGeneral1926/The_General_1926_720p_512kb.mp4' },
  { titulo: 'The Phantom Creeps', ano: 1939, categoria: 'Clássicos', descricao: 'Serial de Bela Lugosi — robôs e invisibilidade', url: 'https://archive.org/download/ThePhantomCreeps/ThePhantomCreeps_512kb.mp4' },
  { titulo: 'The Little Shop of Horrors', ano: 1960, categoria: 'Clássicos', descricao: 'Comédia de terror de Roger Corman — planta carnívora!', url: 'https://archive.org/download/TheLittleShopOfHorrors/The%20Little%20Shop%20of%20Horrors.mp4' },
  // --- 😂 Comédia ---
  { titulo: 'Three Stooges — Episódios', ano: 1940, categoria: 'Comédia', descricao: 'Os três troubalhões clássicos', url: 'https://archive.org/download/3stooges/3stooges_NewMalice1_512kb.mp4' },
  { titulo: 'My Favorite Brunette', ano: 1947, categoria: 'Comédia', descricao: 'Bob Hope em comédia de detectives', url: 'https://archive.org/download/my_favorite_brunette/my_favorite_brunette_512kb.mp4' },
  { titulo: 'McLintock!', ano: 1963, categoria: 'Comédia', descricao: 'John Wayne no western cómico', url: 'https://archive.org/download/mclintok_widescreen/McLintock_512kb.mp4' },
  // --- 📺 Séries (episódios em domínio público) ---
  { titulo: 'Beverly Hillbillies — Ep. 1 "Strike Oil"', ano: 1962, categoria: 'Séries', descricao: 'A família do petróleo muda-se para Beverly Hills (série clássica)', url: 'https://archive.org/download/Beverly_Hillbillies_Ep01_The_Clampetts_Strike_Oil/BH01_The_Clampetts_Strike_Oil_512kb.mp4' },
  { titulo: 'Beverly Hillbillies — "Granny\'s Garden"', ano: 1962, categoria: 'Séries', descricao: 'A avó e a sua horta em Beverly Hills', url: 'https://archive.org/download/The_Beverly_Hillbillies/GRANNYS_GARDEN_512kb.mp4' },
  { titulo: 'Bonanza — S02E07', ano: 1960, categoria: 'Séries', descricao: 'Os Cartwright do rancho Ponderosa (western clássico)', url: 'https://archive.org/download/Bonanza_pd/BonanzaS02e07.mp4' },
  { titulo: 'Flash Gordon — Cap. 1', ano: 1940, categoria: 'Séries', descricao: 'Serial espacial "Conquers the Universe" — capítulo de abertura', url: 'https://archive.org/download/flash_gordon1/flash_gordon_ep01_512kb.mp4' },
  // --- 🕵️ Suspense e ação ---
  { titulo: 'Dressed to Kill', ano: 1945, categoria: 'Suspense', descricao: 'Sherlock Holmes e as notas musicais roubadas', url: 'https://archive.org/download/dressed_to_kill/dressed_to_kill_512kb.mp4' },
  { titulo: 'The Fast and the Furious', ano: 1954, categoria: 'Suspense', descricao: 'Fuga de carro em corrida no México (original!)', url: 'https://archive.org/download/TheFastandtheFuriousJohnIreland1954goofyrip/TheFastandtheFuriousJohnIreland1954goofyrip_512kb.mp4' },
  { titulo: 'Abraham Lincoln', ano: 1930, categoria: 'Clássicos', descricao: 'Biografia de D.W. Griffith', url: 'https://archive.org/download/abraham_lincoln/abraham_lincoln_512kb.mp4' },
  { titulo: 'The Pied Piper of Hamelin', ano: 1942, categoria: 'Clássicos', descricao: 'Musical do flautista mágico com Van Johnson', url: 'https://archive.org/download/The_Pied_Piper_of_Hamelin/pied_512kb.mp4' },
];

const ORDEM_CATEGORIAS = ['Animação', 'Séries', 'Clássicos', 'Comédia', 'Suspense'];

/** Capa do filme: o Archive serve a miniatura do item em /services/img/<id>. */
function capaDe(url) {
  const id = url.split('/download/')[1]?.split('/')[0];
  return id ? `https://archive.org/services/img/${id}` : null;
}

/** Cria um <select> com o catálogo (agrupado); ao escolher chama aoEscolher. */
export function seletorCatalogo(aoEscolher) {
  const doc = globalThis.document;
  const sel = doc.createElement('select');
  sel.className = 'input';
  sel.setAttribute('aria-label', 'Catálogo de filmes grátis');
  const placeholder = doc.createElement('option');
  placeholder.textContent = '— Ou escolhe um filme do catálogo grátis —';
  placeholder.value = '';
  sel.appendChild(placeholder);
  for (const categoria of ORDEM_CATEGORIAS) {
    const grupo = doc.createElement('optgroup');
    grupo.label = categoria;
    for (const item of CATALOGO.filter((i) => i.categoria === categoria)) {
      const opcao = doc.createElement('option');
      opcao.textContent = `${item.titulo} (${item.ano})`;
      opcao.value = item.url;
      grupo.appendChild(opcao);
    }
    sel.appendChild(grupo);
  }
  sel.addEventListener('change', () => {
    const escolhido = CATALOGO.find((i) => i.url === sel.value);
    if (escolhido) aoEscolher(escolhido);
  });
  return sel;
}

/**
 * Home do catálogo: FILTROS por categoria + grelha de cartões. Cada cartão
 * tem "▶ Ver sozinho" e "👥 Chamar amigos" (cria sessão sincronizada na
 * conversa ativa). Montada via MV.montarVistaPrincipal (ecrã cheio telemóvel).
 */
export function abrirCatalogo() {
  const MV = globalThis.window?.MV;
  const doc = globalThis.document;
  if (!MV || !doc) return;

  const nodo = (tag, classe, texto) => {
    const el = doc.createElement(tag);
    if (classe) el.className = classe;
    if (texto != null) el.textContent = texto;
    return el;
  };
  const botao = (texto, classe, aoClicar) => {
    const b = nodo('button', classe, texto);
    b.type = 'button';
    b.addEventListener('click', aoClicar);
    return b;
  };

  const voltar = botao('← Voltar', 'btn btn-ghost btn-sm', () => MV.fecharVista?.());
  const cabeca = nodo('header', 'filme-head');
  const zonaTitulo = nodo('div', 'filme-ident');
  zonaTitulo.append(
    nodo('h2', 'filme-titulo', '🎬 Catálogo de filmes'),
    nodo('p', 'filme-ficha', 'Grátis e legal (domínio público + Creative Commons) — escolhe e vê sozinho ou com amigos'),
  );
  cabeca.append(zonaTitulo, voltar);

  // Filtros por categoria: chips "Todos" + uma por categoria (v1.1).
  let categoriaAtiva = null; // null = Todos
  const filtros = nodo('div', 'catalogo-filtros');

  function renderFiltros() {
    filtros.replaceChildren();
    const chips = [{ nome: null, rotulo: 'Todos' }].concat(
      ORDEM_CATEGORIAS.map((c) => ({
        nome: c,
        rotulo: `${c} (${CATALOGO.filter((i) => i.categoria === c).length})`,
      })),
    );
    for (const { nome, rotulo } of chips) {
      filtros.appendChild(botao(
        rotulo,
        'catalogo-filtro' + (categoriaAtiva === nome ? ' is-active' : ''),
        () => { categoriaAtiva = nome; renderFiltros(); renderGrelha(); },
      ));
    }
  }

  const grelha = nodo('div', 'catalogo-grelha');
  function renderGrelha() {
    grelha.replaceChildren();
    for (const categoria of ORDEM_CATEGORIAS) {
      if (categoriaAtiva && categoriaAtiva !== categoria) continue;
      const itens = CATALOGO.filter((i) => i.categoria === categoria);
      if (itens.length === 0) continue;
      grelha.appendChild(nodo('h3', 'catalogo-categoria', `${categoria} (${itens.length})`));
      for (const item of itens) {
        const cartao = nodo('article', 'catalogo-cartao');
        const capa = capaDe(item.url);
        if (capa) {
          const img = doc.createElement('img');
          img.className = 'catalogo-capa';
          img.loading = 'lazy';
          img.src = capa;
          img.alt = `Capa de ${item.titulo}`;
          img.addEventListener('error', () => {
            img.replaceWith(nodo('div', 'catalogo-capa catalogo-capa-vazia', '🎬'));
          });
          cartao.appendChild(img);
        }
        const corpo = nodo('div', 'catalogo-corpo');
        const info = nodo('div', 'catalogo-info');
        info.append(
          nodo('strong', null, `${item.titulo} (${item.ano})`),
          nodo('p', 'catalogo-desc', item.descricao),
        );
        const acoes = nodo('div', 'catalogo-acoes');
        acoes.append(
          botao('▶ Ver', 'btn btn-primary btn-sm', () => MV.verSozinho?.(item)),
          botao('👥 Amigos', 'btn btn-sm', () => MV.criarSessaoDoCatalogo?.(item)),
        );
        corpo.append(info, acoes);
        cartao.appendChild(corpo);
        grelha.appendChild(cartao);
      }
    }
  }

  renderFiltros();
  renderGrelha();

  const raiz = doc.createElement('div');
  raiz.className = 'catalogo';
  raiz.append(cabeca, filtros, grelha);
  MV.montarVistaPrincipal(raiz);
}
