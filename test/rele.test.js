'use strict';

/**
 * Testes da ponte de tempo real (src/relay.js) — LISTEN/NOTIFY via Neon.
 * Sem DATABASE_URL os testes saltam (a ponte só existe com Postgres).
 *
 * IMPORTANTE: `origem` é o id DO PROCESSO — dois relays no MESMO processo
 * partilham o id e o dedup come as entregas (correto: em produção cada
 * servidor é um processo). Por isso o publicador vive num PROCESSO FILHO,
 * replicando a semântica real Render ↔ PC.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { execFile } = require('node:child_process');
const path = require('node:path');

const CAMINHO_RELAY = path.join(__dirname, '..', 'src', 'relay.js');
const TEMPO_ESPERA_MS = 8000;

async function esperar(predicado, descricao) {
  const inicio = Date.now();
  while (Date.now() - inicio < TEMPO_ESPERA_MS) {
    if (predicado()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(descricao);
}

test('ponte: publish de OUTRO PROCESSO chega ao ouvinte', { skip: !process.env.DATABASE_URL && 'sem DATABASE_URL' }, async () => {
  const { criarRele } = require('../src/relay');
  const recebidos = [];
  const ouvinte = criarRele({
    connectionString: process.env.DATABASE_URL,
    aoReceber: (d) => recebidos.push(d),
  });
  try {
    await new Promise((r) => setTimeout(r, 1200)); // LISTEN assente

    // Publicador num processo separado (semântica real da ponte).
    await new Promise((resolve, reject) => {
      execFile(process.execPath, [
        '-e',
        `const { criarRele } = require(${JSON.stringify(CAMINHO_RELAY)});
         const r = criarRele({ connectionString: process.env.DATABASE_URL, aoReceber() {} });
         r.publicar({ userId: 'user-x', envelope: { type: 'presence', online: true } });
         setTimeout(() => process.exit(0), 1500);`,
      ], { env: process.env, timeout: 15000 }, (erro) => (erro ? reject(erro) : resolve()));
    });

    await esperar(
      () => recebidos.some((d) => d.userId === 'user-x'),
      'o publish do processo-filho não chegou ao ouvinte',
    );
    const entrega = recebidos.find((d) => d.userId === 'user-x');
    assert.equal(entrega.envelope.type, 'presence');
  } finally {
    ouvinte.parar();
    await new Promise((r) => setTimeout(r, 300));
  }
});

test('ponte: o próprio publish não volta (dedup por origem)', { skip: !process.env.DATABASE_URL && 'sem DATABASE_URL' }, async () => {
  const { criarRele } = require('../src/relay');
  const recebidos = [];
  const a = criarRele({ connectionString: process.env.DATABASE_URL, aoReceber: (d) => recebidos.push(d) });
  try {
    await new Promise((r) => setTimeout(r, 1200));
    a.publicar({ userId: 'user-y', envelope: { type: 'presence', online: false } });
    await new Promise((r) => setTimeout(r, 1500));
    assert.ok(recebidos.every((d) => d.userId !== 'user-y'), 'o próprio publish não deve voltar');

    // Payload gigante (>7 KB): rejeitado sem lançar e sem circular.
    a.publicar({ userId: 'user-z', envelope: { type: 'chat_message', text: 'x'.repeat(9000) } });
    await new Promise((r) => setTimeout(r, 600));
    assert.ok(recebidos.every((d) => d.userId !== 'user-z'), 'payload gigante não atravessa');
  } finally {
    a.parar();
    await new Promise((r) => setTimeout(r, 300));
  }
});
