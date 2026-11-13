// Where a layer's own settings name an attribute field, and rewriting those names. Pure: no network, no DOM.
//
// A field name is recognised in these places only:
//   - a string equal to the name under a key containing "field" (field1, fieldName, orderByFields…)
//   - {NAME} in any text (pop-up titles and descriptions)
//   - $feature.NAME and $feature["NAME"] in any text (Arcade)
//   - [NAME] in labelExpression
//   - the bare word in definitionExpression and where (SQL), outside quotes
// A pop-up field list entry that is switched off (visible: false) is not counted as a use.

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SQL_KEYS = new Set(['definitionExpression', 'where']);

function rules(name) {
  const n = escape(name);
  return {
    exact: new RegExp(`^(${n})(\\s+(?:asc|desc))?$`, 'i'),
    braces: new RegExp(`(\\{)${n}(\\})`, 'gi'),
    arcade: new RegExp(`(\\$feature\\s*\\.\\s*)${n}\\b|(\\$feature\\s*\\[\\s*['"])${n}(?=['"]\\s*\\])`, 'gi'),
    brackets: new RegExp(`(\\[)${n}(\\])`, 'gi'),
    sql: new RegExp(`(?<![\\w'"])${n}(?![\\w'"])`, 'gi'),
  };
}

function rewriteString(value, key, rule, to) {
  if (/field/i.test(key) && rule.exact.test(value)) return value.replace(rule.exact, (_, name, order) => to + (order || ''));
  let next = value.replace(rule.braces, `$1${to}$2`).replace(rule.arcade, (_, dot, bracket) => (dot || bracket) + to);
  if (key === 'labelExpression') next = next.replace(rule.brackets, `$1${to}$2`);
  if (SQL_KEYS.has(key)) next = next.replace(rule.sql, to);
  return next;
}

function walk(value, key, path, rule, to, uses) {
  if (typeof value === 'string') {
    const next = rewriteString(value, key, rule, to ?? '\u0000');
    if (next === value) return value;
    uses.push(path.join('/'));
    return to == null ? value : next;
  }
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((child, index) => walk(child, key, [...path, index], rule, to, uses));
  if (value.visible === false && typeof value.fieldName === 'string') return value;
  return Object.fromEntries(Object.entries(value).map(([name, child]) => [name, walk(child, name, [...path, name], rule, to, uses)]));
}

/** Paths inside node (a layer's JSON) where the field is used. */
export function fieldUses(node, name) {
  const uses = [];
  walk(node, '', [], rules(name), null, uses);
  return uses;
}

/** A copy of node with each field in mapping ({ OLD: 'NEW' }) renamed wherever fieldUses finds it. */
export function renameFields(node, mapping) {
  return Object.entries(mapping).reduce((current, [from, to]) => walk(current, '', [], rules(from), to, []), node);
}

/** "drawing, pop-up" — the kinds of setting a list of paths from fieldUses falls under. */
export function describeUses(uses) {
  const kind = (path) => (/renderer|drawingInfo(?!\/labelingInfo)/.test(path) && !/labelingInfo/.test(path) ? 'drawing'
    : /labelingInfo/.test(path) ? 'labels'
      : /popup/i.test(path) ? 'pop-up'
        : /definitionExpression|where|filter/i.test(path) ? 'filter' : path);
  return [...new Set(uses.map(kind))].join(', ');
}
