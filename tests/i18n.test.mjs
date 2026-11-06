import assert from 'node:assert/strict';
import test from 'node:test';
import { allKeys, readCatalog, LOCALES } from '../scripts/i18n.mjs';
import { matchLocale, translateIn, translateMessage, t } from '../src/i18n/index.ts';

const placeholders = (text) => (text.match(/\{\d+\}/g) || []).sort();

test('every UI and backend message is translated with the same placeholders', async () => {
  const keys = [...allKeys().keys()];
  assert.ok(keys.length > 500, 'extractor should find the app messages');
  for (const locale of LOCALES) {
    const catalog = await readCatalog(locale);
    const missing = keys.filter((key) => !(key in catalog));
    assert.deepEqual(missing, [], `${locale} is missing translations; run node scripts/i18n.mjs check`);
    for (const [source, translated] of Object.entries(catalog)) {
      assert.deepEqual(placeholders(translated), placeholders(source), `${locale}: ${source}`);
      assert.ok(translated.trim(), `${locale}: empty translation for ${source}`);
    }
  }
});

test('source language is used outside the app and t() fills positional values', () => {
  assert.equal(t('已复制 {0}', 'a.txt'), '已复制 a.txt');
  assert.equal(translateIn('en', '已复制 {0}', 'a.txt'), 'Copied a.txt');
  assert.equal(translateIn('zh-TW', '设置'), '設定');
  assert.equal(translateIn('en', '尚未收录的新文案'), '尚未收录的新文案');
});

test('backend messages translate exactly, from filled-in templates, and recursively', () => {
  assert.equal(translateMessage('请先连接目标服务器', 'en'), 'Connect to the target server first');
  assert.equal(
    translateMessage('模型 API 返回 401 Unauthorized：{"error":"bad key"}', 'en'),
    'Model API returned 401 Unauthorized: {"error":"bad key"}',
  );
  // A known inner message inside a template is translated too.
  assert.equal(
    translateMessage('上下文压缩失败，原记录已保留：模型没有返回有效的压缩摘要', 'en'),
    'Context compaction failed; the original record was kept: The model did not return a valid compaction summary',
  );
  assert.equal(translateMessage('已写入 /srv/app/.env.example', 'en'), 'Wrote /srv/app/.env.example');
  assert.equal(translateMessage('连接 10.0.0.2:22 超时（20 秒）', 'zh-TW'), '連線 10.0.0.2:22 超時（20 秒）');
  // Server output and unknown text pass through untouched.
  assert.equal(translateMessage('Permission denied (publickey).', 'en'), 'Permission denied (publickey).');
  assert.equal(translateMessage('远端返回的任意中文输出', 'en'), '远端返回的任意中文输出');
  assert.equal(translateMessage('请先连接目标服务器', 'zh-CN'), '请先连接目标服务器');
});

test('system languages map to the closest supported locale', () => {
  assert.equal(matchLocale('zh-CN'), 'zh-CN');
  assert.equal(matchLocale('zh-Hans-SG'), 'zh-CN');
  assert.equal(matchLocale('zh-TW'), 'zh-TW');
  assert.equal(matchLocale('zh-HK'), 'zh-TW');
  assert.equal(matchLocale('zh-Hant'), 'zh-TW');
  assert.equal(matchLocale('en-GB'), 'en');
  assert.equal(matchLocale('fr-FR'), null);
});
