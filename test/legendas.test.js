'use strict';

/**
 * Testes do conversor SRT → WebVTT (ui/legendas.js) — pura e testável:
 * header WEBVTT, vírgulas dos tempos por pontos, e .vtt passa intacto.
 */

const { test } = require('node:test');
const assert = require('node:assert');

test('converterSrtParaVtt: srt típico ganha header WEBVTT e tempos com ponto', async () => {
  const { converterSrtParaVtt } = await import('../public/ui/legendas.js');
  const srt = [
    '1',
    '00:00:01,000 --> 00:00:04,500',
    'Olá, Angola!',
    '',
    '2',
    '00:01:02,250 --> 00:01:05,000',
    'Segunda fala.',
  ].join('\r\n');
  const vtt = converterSrtParaVtt(srt);
  assert.ok(vtt.startsWith('WEBVTT'), 'começa com WEBVTT');
  assert.ok(vtt.includes('00:00:01.000 --> 00:00:04.500'), 'vírgula → ponto');
  assert.ok(vtt.includes('00:01:02.250 --> 00:01:05.000'), 'segunda pista também');
  assert.ok(vtt.includes('Olá, Angola!'), 'texto preservado');
  assert.ok(!vtt.includes(',' + ' -->'), 'nenhuma vírgula em timestamps');
});

test('converterSrtParaVtt: vtt válido passa intacto', async () => {
  const { converterSrtParaVtt } = await import('../public/ui/legendas.js');
  const vtt = 'WEBVTT\n\n00:00.000 --> 00:02.000\nJá é VTT';
  assert.equal(converterSrtParaVtt(vtt), vtt);
});

test('converterSrtParaVtt: BOM e CRLF não estragam a conversão', async () => {
  const { converterSrtParaVtt } = await import('../public/ui/legendas.js');
  const comBom = '\uFEFF1\r\n00:00:00,500 --> 00:00:01,500\r\nBom\r\n';
  const vtt = converterSrtParaVtt(comBom);
  assert.ok(vtt.startsWith('WEBVTT'));
  assert.ok(vtt.includes('00:00:00.500 --> 00:00:01.500'));
});
