'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildYtDlpArgs,
  splitOutputLines,
  parseLine,
  stageForPostprocessor,
  parseVersion,
  compareVersions,
} = require('./ytdlp');

test('buildYtDlpArgs uses opus-preferred format, newline, temp/home paths', () => {
  const args = buildYtDlpArgs({ url: 'https://example.com/v', downloadDir: '/dl', tempDir: '/tmp/job1', jsRuntime: 'deno' });
  assert.ok(args.includes('--newline'));
  assert.ok(args.includes('bestaudio[acodec=opus]/bestaudio'));
  assert.ok(!args.join(' ').includes('ejs:github'));
  assert.ok(args.includes('--js-runtimes') && args.includes('deno'));
  assert.ok(args.includes('home:/dl'));
  assert.ok(args.includes('temp:/tmp/job1'));
  assert.equal(args[args.length - 1], 'https://example.com/v');
  assert.equal(args[args.length - 2], '--');
});

test('buildYtDlpArgs honors opusPreferred false (re-encode path)', () => {
  const args = buildYtDlpArgs({ url: 'https://example.com/v', downloadDir: '/dl', opusPreferred: false });
  const fIdx = args.indexOf('-f');
  assert.equal(args[fIdx + 1], 'bestaudio');
});

test('splitOutputLines handles CR-separated progress', () => {
  const lines = splitOutputLines('STOW_PROGRESS:1|2|3|4|5|6\rSTOW_PROGRESS:2|2|3|4|5|6\r');
  assert.deepEqual(lines.filter(Boolean), [
    'STOW_PROGRESS:1|2|3|4|5|6',
    'STOW_PROGRESS:2|2|3|4|5|6',
  ]);
});

test('parseLine parses meta/progress/postprocess/file markers', () => {
  const SEP = '\x1f';
  const meta = parseLine(`STOW_META:id1${SEP}Title${SEP}Uploader${SEP}213${SEP}https://example.com/v${SEP}20240101${SEP}https://example.com/t.jpg`);
  assert.equal(meta.type, 'meta');
  assert.equal(meta.title, 'Title');
  assert.equal(meta.duration, 213);

  const prog = parseLine('STOW_PROGRESS:1024|3433755|3433755|1500|5|1.2');
  assert.equal(prog.type, 'progress');
  assert.ok(Math.abs(prog.progress - (1024 / 3433755) * 100) < 0.001);

  const progNa = parseLine('STOW_PROGRESS:NA|NA|NA|NA|NA|0.1');
  assert.equal(progNa.type, 'progress');
  assert.equal(progNa.progress, null);

  const pp = parseLine('STOW_PP:started|ExtractAudio');
  assert.equal(pp.type, 'postprocess');
  assert.equal(stageForPostprocessor(pp.postprocessor), 'Converting');

  const file = parseLine('STOW_FILE:/tmp/a/b.opus');
  assert.equal(file.type, 'file');
  assert.equal(parseLine('download:[50%|1k|2s]'), null);
});

test('parseVersion and compareVersions handle nightlies', () => {
  assert.equal(parseVersion('2026.10.29.232701\n'), '2026.10.29.232701');
  assert.equal(parseVersion('garbage'), '');
  assert.equal(compareVersions('2026.10.26', '2026.10.29.232701'), -1);
  assert.equal(compareVersions('2026.10.29.232701', '2026.10.29.232701'), 0);
});
