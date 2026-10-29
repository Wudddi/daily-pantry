// Inventory presentation is deliberately stable: editing a label should not
// move a product, and shelf-stable supplies do not crowd the daily food list.
export const FOOD_CATEGORY_ORDER = ['prepared', 'protein', 'staple', 'vegetable', 'fruit', 'nuts', 'bread', 'dessert', 'other'];
const CATEGORY_ORDER = [...FOOD_CATEGORY_ORDER, 'condiment', 'supplement'];
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
export function isInventoryArchived(item) {
  return item.status === 'archived' || item.status === 'depleted' || item.quantity === 0;
}
export function inventoryItemInScope(item, scope) {
  if (scope === 'archive') return isInventoryArchived(item);
  if (isInventoryArchived(item)) return false;
  if (scope === 'supplement') return item.category === 'supplement';
  if (scope === 'condiment') return item.category === 'condiment';
  return item.category !== 'supplement' && item.category !== 'condiment';
}
export function inventoryScopeCounts(items) {
  return Object.fromEntries(['food', 'supplement', 'condiment', 'archive'].map(scope => [scope, items.filter(item => inventoryItemInScope(item, scope)).length]));
}
export function compareInventoryItems(a, b) {
  const rank = category => { const index = CATEGORY_ORDER.indexOf(category); return index < 0 ? CATEGORY_ORDER.length : index; };
  return rank(a.category) - rank(b.category)
    || Number(Boolean(b.priority)) - Number(Boolean(a.priority))
    || Number(a.status === 'pending') - Number(b.status === 'pending')
    || collator.compare(a.name, b.name)
    || collator.compare(a.id, b.id);
}
export function inventoryViewItems(items, { scope = 'food', filter = 'all', category = 'all', query = '' } = {}) {
  const search = query.trim().toLocaleLowerCase('zh-CN');
  return items.filter(item => {
    if (!inventoryItemInScope(item, scope)) return false;
    if (category !== 'all' && item.category !== category) return false;
    if (filter === 'pending' && item.status !== 'pending') return false;
    if (filter === 'priority' && (item.status !== 'available' || !item.priority)) return false;
    if (filter === 'missing' && (item.category === 'supplement' || item.status !== 'available' || !['kcal', 'protein', 'carbs', 'fat'].some(key => item.nutrition?.[key] === null))) return false;
    const searchable = [item.name, item.brand, ...(item.aliases ?? []), item.notes, item.ingredients, item.supplementFacts].filter(Boolean).join(' ').toLocaleLowerCase('zh-CN');
    return !search || searchable.includes(search);
  }).sort(compareInventoryItems);
}
export function groupInventoryItems(items) {
  const groups = [];
  for (const item of items) {
    let group = groups.find(value => value.category === item.category);
    if (!group) { group = { category: item.category, items: [] }; groups.push(group); }
    group.items.push(item);
  }
  return groups;
}
