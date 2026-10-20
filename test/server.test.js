'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { createServer } = require('../src/server');

let http;
let baseUrl;

before(async () => {
  // Store de memoria — a sua forma concreta e definida pelas tarefas seguintes.
  ({ http } = createServer({ store: {} }));
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve) => {
    http.close(() => resolve());
    http.closeAllConnections();
  });
});

test('GET /api/health responde 200 com {"ok":true}', async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.strictEqual(response.status, 200);
  assert.deepStrictEqual(await response.json(), { ok: true });
});

test('GET / serve o HTML com o titulo Machine Video', async () => {
  const response = await fetch(`${baseUrl}/`);
  assert.strictEqual(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  const body = await response.text();
  assert.match(body, /Machine Video/);
});

test('GET /style.css e servido estaticamente', async () => {
  const response = await fetch(`${baseUrl}/style.css`);
  assert.strictEqual(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/css/);
});
