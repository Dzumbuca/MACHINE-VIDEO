/**
 * Legendas (v1.1) — cada espectador carrega o SEU ficheiro de legendas
 * (.srt ou .vtt) e o navegador sincroniza com o vídeo sozinho (a pista
 * <track> segue o currentTime — sem WS, sem partilha).
 *
 * SRT → VTT: o <track> só aceita WebVTT. A conversão é mecânica:
 * cabeçalho WEBVTT + vírgulas dos tempos por pontos.
 */

/** Converte o texto de um .srt para WebVTT. .vtt passa direto (com header). */
export function converterSrtParaVtt(texto) {
  const limpo = String(texto).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (/^\s*WEBVTT/.test(limpo)) return limpo;
  // AMBOS os lados do --> recebem ponto no lugar da vírgula (global).
  const corrigido = limpo.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${corrigido}`;
}

/** Aplica um ficheiro de legendas (File) ao <video>; devolve o rótulo ou null. */
export function aplicarLegendas(video, arquivo) {
  return new Promise((resolve) => {
    const leitor = new FileReader();
    leitor.onerror = () => resolve(null);
    leitor.onload = () => {
      try {
        const texto = converterSrtParaVtt(leitor.result);
        const blob = new Blob([texto], { type: 'text/vtt' });
        const pista = document.createElement('track');
        pista.kind = 'subtitles';
        pista.label = arquivo.name.replace(/\.(srt|vtt)$/i, '').slice(0, 40);
        pista.src = URL.createObjectURL(blob);
        video.appendChild(pista);
        pista.track.mode = 'showing';
        resolve(pista.label);
      } catch {
        resolve(null);
      }
    };
    leitor.readAsText(arquivo, 'utf-8');
  });
}

/** Cria o botão 💬 Legendas ligado a um <video> (troca a pista a cada carga). */
export function botaoLegendas(video) {
  const doc = globalThis.document;
  const input = Object.assign(doc.createElement('input'), {
    type: 'file', accept: '.srt,.vtt,text/vtt',
  });
  input.style.display = 'none';
  const botao = doc.createElement('button');
  botao.type = 'button';
  botao.className = 'btn btn-sm';
  botao.textContent = '💬 Legendas';
  botao.title = 'Carregar legenda (.srt ou .vtt) — segue o vídeo sozinha';
  botao.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const ficheiro = input.files?.[0];
    if (!ficheiro) return;
    // substitui a pista anterior (uma legenda de cada vez)
    for (const antiga of Array.from(video.querySelectorAll('track'))) {
      if (antiga.src?.startsWith('blob:')) URL.revokeObjectURL(antiga.src);
      antiga.remove();
    }
    const rotulo = await aplicarLegendas(video, ficheiro);
    botao.textContent = rotulo ? `💬 ${rotulo}` : '💬 Legendas (ficheiro inválido)';
    input.value = '';
  });
  return botao;
}

/** Cria o botão ⛶ Tela cheia para um elemento (vídeo ou palco). */
export function botaoTelaCheia(alvo) {
  const botao = globalThis.document.createElement('button');
  botao.type = 'button';
  botao.className = 'btn btn-sm';
  botao.textContent = '⛶ Tela cheia';
  botao.title = 'Ocupar o ecrã todo (Esc para sair)';
  botao.addEventListener('click', () => {
    const destino = alvo.fullscreenElement ?? alvo;
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
    } else {
      destino.requestFullscreen?.()?.catch?.(() => {
        botao.textContent = '⛶ Indisponível';
      });
    }
  });
  return botao;
}
