'use strict';

/**
 * Guarda de regressão (v1.1): valida a SINTAXE de todos os módulos do cliente
 * (public/**\/*.js) com o parser do Node — um SyntaxError aqui derruba TODA a
 * app no navegador (nenhum handler liga), como aconteceu em produção com o
 * app.js:413. Este teste garante que nenhum ficheiro parte nunca chega ao ar.
 *
 * Como os ficheiros são ES modules, a verificação usa
 * `node --input-type=module --check` (stdin) por ficheiro.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const RAIZ = path.join(__dirname, '..', 'public');

function ficheirosJs(dir) {
  const saida = [];
  for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
    const caminho = path.join(dir, entrada.name);
    if (entrada.isDirectory()) saida.push(...ficheirosJs(caminho));
    else if (entrada.name.endsWith('.js')) saida.push(caminho);
  }
  return saida;
}

test('todos os módulos do cliente têm sintaxe ES válida', () => {
  const ficheiros = ficheirosJs(RAIZ);
  assert.ok(ficheiros.length >= 8, `esperava os módulos do cliente, achei ${ficheiros.length}`);
  const falhados = [];
  for (const ficheiro of ficheiros) {
    const relativo = path.relative(RAIZ, ficheiro).replace(/\\/g, '/');
    try {
      execFileSync(
        process.execPath,
        ['--input-type=module', '--check'],
        { input: fs.readFileSync(ficheiro, 'utf8'), encoding: 'utf8' },
      );
    } catch (err) {
      falhados.push(`${relativo}: ${String(err.stderr || err.message).split('\n')[0]}`);
    }
  }
  assert.deepStrictEqual(falhados, [], 'ficheiros com sintaxe inválida');
});
