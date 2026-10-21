'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Mesmos cenários do contrato da store (test/.helpers/store-scenarios.js),
 * corridos contra src/store-pg.js num Postgres real.
 *
 * Env-guard: sem `DATABASE_URL` TODOS os testes ficam skip com motivo claro
 * (o hospedeiro local não tem Postgres) — a suite mantém-se verde e os
 * cenários do contrato continuam garantidos pela store em memória
 * (test/store.test.js). Com `DATABASE_URL` definida, a store-pg é obrigada a
 * passar exatamente os mesmos testes da Task 2.
 *
 * Cada cenário cria uma store própria com `reset: true` (esvazia as tabelas
 * no boot), garantindo isolamento total entre cenários; o pool é fechado no
 * fim de cada um via closeStore.
 */

const { createStorePg } = require('../src/store-pg');
const { runStoreContractTests } = require('./.helpers/store-scenarios');

const motivoSkip = process.env.DATABASE_URL
  ? false
  : 'DATABASE_URL não definida — testes da store em PostgreSQL pulados';

runStoreContractTests({
  skip: motivoSkip,
  createStore: () => createStorePg(process.env.DATABASE_URL, { reset: true }),
  closeStore: (store) => store.close(),
});

// --- Regressão (revisão Task 11, Critical 1) --------------------------------
//
// `pool.query('... $1 ...')` SEM array de valores usa o protocolo simple-query
// do pg: o `$1` vira texto literal e o Postgres falha com 42P02 ("there is no
// parameter $1") em TODA a chamada — invisível sob a suite de memória (foi
// exatamente o bug do deleteSession). Este teste estático, leve e sem base de
// dados, garante que toda a chamada `.query(` com placeholder `$N` em
// src/store-pg.js passa também o array de valores. Não substitui a suite pg
// real (com DATABASE_URL), mas apanha esta classe de erro em qualquer host.

/** Extrai o texto dos argumentos de cada chamada `.query(` (parênteses
 *  balanceados, com respeito por strings e templates). */
function chamadasQuery(codigo) {
  const resultados = [];
  const re = /\.query\s*\(/g;
  let m;
  while ((m = re.exec(codigo)) !== null) {
    const inicio = m.index + m[0].length;
    let profundidade = 1;
    let i = inicio;
    let aspas = null;
    while (i < codigo.length && profundidade > 0) {
      const c = codigo[i];
      if (aspas) {
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === aspas) aspas = null;
      } else if (c === "'" || c === '"' || c === '`') {
        aspas = c;
      } else if (c === '(') {
        profundidade++;
      } else if (c === ')') {
        profundidade--;
      }
      i++;
    }
    const linha = codigo.slice(0, m.index).split('\n').length;
    resultados.push({ args: codigo.slice(inicio, i - 1), linha });
    re.lastIndex = i;
  }
  return resultados;
}

/** Nº de argumentos de topo (vírgulas a profundidade 0, fora de strings). */
function argumentosDeTopo(args) {
  let profundidade = 0;
  let aspas = null;
  let n = 1;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (aspas) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === aspas) aspas = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      aspas = c;
    } else if (c === '(' || c === '[' || c === '{') {
      profundidade++;
    } else if (c === ')' || c === ']' || c === '}') {
      profundidade--;
    } else if (c === ',' && profundidade === 0) {
      n++;
    }
  }
  return n;
}

test('store-pg: toda query com placeholder $N passa o array de valores', () => {
  const codigo = fs.readFileSync(path.join(__dirname, '..', 'src', 'store-pg.js'), 'utf8');
  const maus = [];
  for (const { args, linha } of chamadasQuery(codigo)) {
    const temPlaceholder = /\$\d/.test(args);
    if (temPlaceholder && argumentosDeTopo(args) < 2) {
      maus.push(`linha ${linha}: query com placeholder mas sem valores → ${args.trim().slice(0, 80)}`);
    }
  }
  assert.deepStrictEqual(
    maus,
    [],
    'chamadas .query() com $N têm de incluir o array de valores (42P02 sem ele)',
  );
});
