'use strict';

/**
 * Contrato da store em memória (Task 2) — Machine Video Social.
 *
 * Os cenários vivem em test/.helpers/store-scenarios.js e são partilhados
 * com test/store-pg.test.js (Task 11): a store em PostgreSQL passa EXATAMENTE
 * os mesmos testes que esta.
 */

const { createStoreMemory } = require('../src/store-memory');
const { runStoreContractTests } = require('./.helpers/store-scenarios');

runStoreContractTests({ createStore: () => createStoreMemory() });
