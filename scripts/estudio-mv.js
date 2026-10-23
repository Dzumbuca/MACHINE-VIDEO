'use strict';

/**
 * ESTÚDIO MV (v1.2) — robô de séries curtas: roteiro → MP4 vertical.
 *
 * Uso:
 *   node scripts/estudio-mv.js roteiro.json
 *
 * O roteiro (JSON) tem a forma:
 * {
 *   "titulo": "O Passageiro Fantasma — EP1",
 *   "cenas": [
 *     { "prompt": "motorista de candongueiro ao anoitecer, Luanda, estilo cinematográfico",
 *       "voz": "pt-AO-ValerioNeural",
 *       "fala": "Nessa noite, o passageiro do banco de trás não respirava…" },
 *     …
 *   ]
 * }
 *
 * Pipeline (tudo local e grátis):
 *   1. Pollinations gera a imagem de cada cena (sem chave, por URL);
 *   2. msedge-tts gera a voz PT da fala (MP3);
 *   3. ffmpeg compõe: imagem com zoom lento + a voz, duração = áudio;
 *   4. concatena as cenas → MP4 vertical (720×1280) em estudio/saida/.
 *
 * Saída: estudio/saida/<titulo-ep>.mp4 — depois: Archive → link → catálogo.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RAIZ = path.join(__dirname, '..');
const PASTA_TRABALHO = path.join(RAIZ, 'estudio');
const FFMPEG = path.join(
  process.env.LOCALAPPDATA || '',
  'Microsoft', 'WinGet', 'Packages',
  'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe',
  'ffmpeg-9.0.2-full_build', 'bin', 'ffmpeg.exe',
);

function executar(cmd, args) {
  execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
}

/** Baixa a imagem da cena via Pollinations (sem chave), com pausa e retry. */
async function gerarImagem(prompt, destino) {
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=720&height=1280&nologo=true`;
  for (let tentativa = 1; tentativa <= 4; tentativa += 1) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (r.status === 402 || r.status === 429) {
        console.log(`  limite do Pollinations (${r.status}) — pausa de ${tentativa * 8}s…`);
        await new Promise((r2) => setTimeout(r2, tentativa * 8000));
        continue;
      }
      if (!r.ok) throw new Error(`Pollinations respondeu ${r.status}`);
      fs.writeFileSync(destino, Buffer.from(await r.arrayBuffer()));
      return;
    } catch (erro) {
      if (tentativa === 4) throw erro;
      console.log(`  falhou (${erro.message}) — tentativa ${tentativa + 1}…`);
      await new Promise((r2) => setTimeout(r2, tentativa * 8000));
    }
  }
}

/** Gera a voz PT da fala com msedge-tts (MP3). */
async function gerarVoz(fala, voz, destino) {
  const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voz, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const { audioStream } = await tts.toStream(fala);
  const pedacos = [];
  for await (const pedaco of audioStream) pedacos.push(pedaco);
  fs.writeFileSync(destino, Buffer.concat(pedacos));
}

/** Duração de um áudio (ffprobe do próprio pacote ffmpeg). */
function duracaoSegundos(ficheiro) {
  const ffprobe = path.join(path.dirname(FFMPEG), 'ffprobe.exe');
  const saida = execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', ficheiro], { encoding: 'utf8' });
  return Math.max(1.5, parseFloat(saida) + 0.8); // +0.8s de respiro
}

async function main() {
  const roteiroCaminho = process.argv[2];
  if (!roteiroCaminho || !fs.existsSync(roteiroCaminho)) {
    console.error('Uso: node scripts/estudio-mv.js <roteiro.json>');
    process.exit(1);
  }
  if (!fs.existsSync(FFMPEG)) {
    console.error('ffmpeg não encontrado em:', FFMPEG);
    process.exit(1);
  }
  const roteiro = JSON.parse(fs.readFileSync(roteiroCaminho, 'utf8'));
  const slug = roteiro.titulo.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const pasta = path.join(PASTA_TRABALHO, slug);
  fs.mkdirSync(path.join(pasta, 'cenas'), { recursive: true });
  fs.mkdirSync(path.join(PASTA_TRABALHO, 'saida'), { recursive: true });

  const partes = [];
  for (let i = 0; i < roteiro.cenas.length; i += 1) {
    const cena = roteiro.cenas[i];
    const imagem = path.join(pasta, 'cenas', `cena${i}.jpg`);
    const audio = path.join(pasta, 'cenas', `voz${i}.mp3`);
    const parte = path.join(pasta, 'cenas', `parte${i}.mp4`);
    const existe = fs.existsSync(imagem) && fs.existsSync(audio);
    if (existe) { console.log(`Cena ${i + 1}: já pronta — a aproveitar`); partes.push(parte); continue; }
    console.log(`Cena ${i + 1}/${roteiro.cenas.length}: gerando imagem…`);
    await gerarImagem(cena.prompt, imagem);
    console.log(`  voz (${cena.voz})…`);
    for (let t = 1; t <= 3; t += 1) { try { await gerarVoz(cena.fala, cena.voz, audio); break; } catch (e) { if (t === 3) throw e; console.log(`  voz limitada — pausa ${t * 10}s…`); await new Promise((r) => setTimeout(r, t * 10000)); } }
    const duracao = duracaoSegundos(audio);
    console.log(`  montando (${duracao.toFixed(1)}s)…`);
    // Zoom lento (Ken Burns) sobre a imagem com a voz por cima.
    executar(FFMPEG, [
      '-y', '-loop', '1', '-i', imagem, '-i', audio,
      '-vf', `scale=800:-2,zoompan=z='min(zoom+0.0015,1.15)':d=${Math.round(duracao * 25)}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)',scale=720:1280`,
      '-t', String(duracao),
      '-c:v', 'libx264', '-preset', 'fast', '-c:a', 'aac', '-shortest', parte,
    ]);
    partes.push(parte);
  }

  // Lista de concatenação + MP4 final.
  const lista = path.join(pasta, 'lista.txt');
  fs.writeFileSync(lista, partes.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
  const final = path.join(PASTA_TRABALHO, 'saida', `${slug}.mp4`);
  executar(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', lista, '-c', 'copy', final]);
  console.log('EPISÓDIO PRONTO:', final);
}

main().catch((erro) => {
  console.error('ERRO:', erro.message);
  process.exit(1);
});
