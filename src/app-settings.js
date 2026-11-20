// Preferências de busca que o addon sugere ao app (behaviorHints.appSettings).
const pick = (v, list, d) => (list.includes(v) ? v : d);
export const appSettings = c => ({
    'searching.view': pick(c.search_view, ['shelf', 'list'], 'shelf'), 'searching.links': pick(c.search_links, ['any', 'direct'], 'direct'), 'searching.length': pick(c.search_length, ['any', 'unabridged', 'abridged'], 'unabridged'),
});
