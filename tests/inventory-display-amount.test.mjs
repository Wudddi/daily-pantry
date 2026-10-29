import test from 'node:test';
import assert from 'node:assert/strict';
import { inventoryDisplayAmount } from '../lib/food-display-amount.mjs';
test('packaged Wasa uses known grams for display while retaining original accounting quantity and unit',()=>{
  const item={quantity:.949091,unit:'包',category:'bread',gramsPerUnit:275,nutrition:{basisUnit:'g'}};
  const before=structuredClone(item),display=inventoryDisplayAmount(item);assert.equal(display.unit,'g');assert.equal(display.quantity,261.000025);assert.equal(display.converted,true);assert.deepEqual(item,before);
});
test('prepared bags and individual portions retain their useful stock unit',()=>{
  assert.equal(inventoryDisplayAmount({quantity:1,unit:'袋',category:'prepared',gramsPerUnit:132}).unit,'袋');
  assert.equal(inventoryDisplayAmount({quantity:12,unit:'个',category:'protein',gramsPerUnit:50}).unit,'个');
});
test('packaging mass cannot turn an unmeasured remaining balance into a full bag',()=>{
  const display=inventoryDisplayAmount({quantity:null,unit:'袋',category:'vegetable',gramsPerUnit:500});assert.equal(display.quantity,null);
});
