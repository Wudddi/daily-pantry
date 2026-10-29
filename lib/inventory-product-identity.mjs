/** Conservative catalogue matching. Recipes and prepared batches keep their own IDs. */
export function isReusableProduct(item) {
  return !!item && item.category !== 'prepared' && item.nutrition?.source !== 'recipe'
    && !Object.values(item.nutrition?.nutrientSources ?? {}).includes('recipe');
}

function normalized(value) {
  return typeof value === 'string' ? value.normalize('NFKC').toLowerCase()
    .replace(/\s+/gu, '').replace(/[“”"'‘’`]/gu, '').replace(/[()[\]{}【】]/gu, '') : '';
}

function names(item) {
  return new Set([item.name, ...(Array.isArray(item.aliases) ? item.aliases : [])].map(normalized).filter(Boolean));
}

// A verified alias may omit packaging information, but it must not override two
// explicitly different sizes or strengths. Never infer a size from current stock.
function specifications(item) {
  const result = new Map();
  const text = typeof item.name === 'string' ? item.name.normalize('NFKC').toLowerCase() : '';
  const tokens = /(?:^|[^\d.])(\d+(?:\.\d+)?)\s*(公斤|千克|毫升|μg|mcg|mg|kg|ml|iu|克|升|g|l|粒|片)(?![a-z])/gu;
  const scales = { kg: ['mass', 1000], 公斤: ['mass', 1000], 千克: ['mass', 1000], g: ['mass', 1], 克: ['mass', 1],
    mg: ['strength', 1], mcg: ['strength', 0.001], μg: ['strength', 0.001], ml: ['volume', 1], 毫升: ['volume', 1],
    l: ['volume', 1000], 升: ['volume', 1000], iu: ['iu', 1], 粒: ['count-pills', 1], 片: ['count-tablets', 1] };
  for (const match of text.matchAll(tokens)) {
    const [dimension, scale] = scales[match[2]];
    if (!result.has(dimension)) result.set(dimension, new Set());
    result.get(dimension).add(Math.round(Number(match[1]) * scale * 1_000_000) / 1_000_000);
  }
  return result;
}

function compatible(left, right, aliasMatch) {
  if (left.unit !== right.unit) return false;
  if (left.category !== right.category) {
    // A recorded name alias is stronger evidence than an old ordinary-food
    // category mistake. Keep supplements, condiments and prepared batches apart.
    const foods = new Set(['vegetable', 'fruit', 'nuts', 'bread', 'dessert', 'protein', 'staple', 'other']);
    if (!aliasMatch || !foods.has(left.category) || !foods.has(right.category)) return false;
  }
  const leftBrand = normalized(left.brand), rightBrand = normalized(right.brand);
  if (leftBrand && rightBrand && leftBrand !== rightBrand) return false;
  if (Number.isFinite(left.gramsPerUnit) && left.gramsPerUnit > 0
    && Number.isFinite(right.gramsPerUnit) && right.gramsPerUnit > 0
    && left.gramsPerUnit !== right.gramsPerUnit) return false;
  const leftSpecs = specifications(left), rightSpecs = specifications(right);
  for (const [dimension, values] of leftSpecs) {
    const other = rightSpecs.get(dimension);
    if (other && ![...values].some(value => other.has(value))) return false;
  }
  return true;
}

/** Exact normalized names/verified aliases only; no fuzzy brand/flavour guesses. */
export function matchExistingProducts(items, candidate) {
  if (!Array.isArray(items) || !isReusableProduct(candidate)) return [];
  const candidateNames = names(candidate);
  if (!candidateNames.size) return [];
  const rank = { available: 0, pending: 1, depleted: 2, archived: 3 };
  return items.filter(item => {
    if (item.id === candidate.id || !isReusableProduct(item)) return false;
    const existingNames = names(item);
    if (![...existingNames].some(name => candidateNames.has(name))) return false;
    const aliasMatch = (item.aliases ?? []).map(normalized).some(name => candidateNames.has(name))
      || (candidate.aliases ?? []).map(normalized).some(name => existingNames.has(name));
    return compatible(item, candidate, aliasMatch);
  })
    .sort((left, right) => (rank[left.status] ?? 4) - (rank[right.status] ?? 4)
      || String(left.id).localeCompare(String(right.id)));
}
