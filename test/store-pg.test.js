'use strict';

const { test } = require('node:test');

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
