// Addon Sleuth: as preferências de busca que ele define, com padrões e valores inválidos.
import assert from 'node:assert/strict';
const { appSettings } = await import('../src/app-settings.js');
assert.deepEqual(appSettings({}), { 'searching.view': 'shelf', 'searching.links': 'direct', 'searching.length': 'unabridged' });
const c = appSettings({ search_view: 'list', search_links: 'bogus', search_length: 'any' });
assert.deepEqual([c['searching.view'], c['searching.links'], c['searching.length']], ['list', 'direct', 'any']);
console.log('File sources addon: search preferences with defaults and invalid values: ok');
