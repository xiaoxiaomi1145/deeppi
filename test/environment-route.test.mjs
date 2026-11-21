import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionStatus, effectiveUrl, environmentRoute, resolveKey } from '../server/settings.mjs';

const setting = (provider, baseUrl = '') => ({ provider, baseUrl });

function withEnv(values, run) {
  const keys = new Set([...Object.keys(values), ...Object.keys(process.env).filter(name => /^(DEEPSEEK|OPENAI|ANTHROPIC|GEMINI|GOOGLE|MISTRAL|AZURE_OPENAI)_/u.test(name))]);
  const before = [...keys].map(name => [name, process.env[name]]);
  for (const name of keys) delete process.env[name];
  try {
    Object.assign(process.env, values);
    run();
  } finally {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('environment URL and key remain paired, with explicit per-session route precedence', () => {
  withEnv({ DEEPSEEK_API_KEY: 'paired', DEEPSEEK_BASE_URL: 'https://gateway.example/ds/' }, () => {
    const route = setting('deepseek');
    assert.deepEqual(environmentRoute('deepseek'), { baseUrl: 'https://gateway.example/ds', keyName: 'DEEPSEEK_API_KEY', custom: true });
    assert.equal(effectiveUrl(route), 'https://gateway.example/ds');
    assert.equal(resolveKey(route), 'paired');
    const explicit = setting('deepseek', 'https://api.deepseek.com');
    assert.equal(effectiveUrl(explicit), 'https://api.deepseek.com');
    assert.equal(resolveKey(explicit), undefined);
    assert.equal(resolveKey(explicit, 'manual'), 'manual');
  });
});

test('absent URL uses native default; unsafe configured URL does not redirect credentials', () => {
  withEnv({ OPENAI_API_KEY: 'official' }, () => {
    const route = setting('openai-compatible');
    assert.equal(effectiveUrl(route), 'https://api.openai.com/v1');
    assert.equal(resolveKey(route), 'official');
    process.env.OPENAI_API_URL = 'https://user:pass@bad.example/v1';
    assert.equal(effectiveUrl(route), '');
    assert.equal(connectionStatus(route), 'missing');
    assert.equal(resolveKey(setting('openai-compatible', 'https://api.openai.com/v1')), undefined);
  });
});

test('Gemini and Google aliases pair only with their corresponding configured gateway key', () => {
  withEnv({ GEMINI_API_KEY: 'default-gemini', GOOGLE_API_KEY: 'google-proxy', GOOGLE_API_URL: 'http://127.0.0.1:8123/v1beta' }, () => {
    assert.equal(effectiveUrl(setting('google')), 'http://127.0.0.1:8123/v1beta');
    assert.equal(resolveKey(setting('google')), 'google-proxy');
    delete process.env.GOOGLE_API_KEY;
    assert.equal(resolveKey(setting('google')), undefined);
    process.env.GEMINI_API_BASE_URL = 'https://gemini.gateway.example/v1beta';
    assert.equal(effectiveUrl(setting('google')), 'https://gemini.gateway.example/v1beta');
    assert.equal(resolveKey(setting('google')), 'default-gemini');
  });
});

test('Azure retains the resource shortcut; all public route descriptions omit values of keys', () => {
  withEnv({ AZURE_OPENAI_API_KEY: 'fixture-key', AZURE_OPENAI_RESOURCE_NAME: 'example-fixture' }, () => {
    assert.deepEqual(environmentRoute('azure'), { baseUrl: 'https://example-fixture.openai.azure.com/openai/v1', keyName: 'AZURE_OPENAI_API_KEY', custom: true });
    assert.equal(resolveKey(setting('azure')), 'fixture-key');
  });
});
