// Entirely invented examples. These are not copied from production menus.
export const KEYS = ['kcal','protein','carbs','fat'];
export const copy = value => structuredClone(value);
export function snapshot(name, values = {kcal:1,protein:0.1,carbs:0.2,fat:0.03}, unit = 'g') {
  return {name,unit,gramsPerUnit:null,ingredients:'',supplementFacts:'',
    nutrition:{basisAmount:1,basisUnit:unit,...values,source:'estimate',sourceText:'DEMO synthetic nutrition basis'}};
}
export function line(id, quantity, patch = {}) {
  return {id,itemId:id,name:'DEMO '+id,quantity,unit:'g',nutritionSnapshot:snapshot('DEMO '+id),sourceText:'DEMO planned food',...patch};
}
export function actual(planned, quantity, patch = {}) {
  return {id:'reported-'+planned.id,itemId:planned.itemId,name:planned.name,quantity,unit:planned.unit,
    nutritionSnapshot:copy(planned.nutritionSnapshot),sourceText:'DEMO actual report',quantitySource:'reported',...patch};
}
export function basisFixture() {
  const breakfast=line('demo-breakfast-food',100),lunch=line('demo-lunch-food',200);
  const plan={id:'demo-nutrition-day',format:'meals_v1',date:'2026-01-15',title:'DEMO independent nutrition bases',status:'reserved',
    createdAt:'2026-01-15T12:00:00.000Z',updatedAt:'2026-01-15T12:00:00.000Z',foodAccounting:'actual_only',supplementAccounting:'actual_only',
    inventoryAccounting:'settled',accountingIssues:[],accountedDebits:[],items:[],
    meals:[{id:'breakfast',slot:'breakfast',title:'DEMO breakfast',state:'completed',plannedItems:[breakfast],actualEntries:[actual(breakfast,150)],reportHistory:[]},
      {id:'lunch',slot:'lunch',title:'DEMO lunch',state:'reserved',plannedItems:[lunch],actualEntries:[],reportHistory:[]}],
    supplementDoses:[{id:'demo-dose',itemId:'demo-supplement',plannedQuantity:1,unit:'粒',requirement:'daily',scheduled:true,state:'reserved',
      nutritionSnapshot:snapshot('DEMO supplement',{kcal:10,protein:0,carbs:0,fat:1},'粒'),actualEntries:[],reportHistory:[]}]};
  const items=[breakfast,lunch].map(food=>({id:food.itemId,name:food.name,quantity:1000,unit:'g',category:'other',status:'available',
    nutrition:copy(food.nutritionSnapshot.nutrition),gramsPerUnit:null,quantityBaselineToken:'demo-count',location:'',confirmedAt:plan.createdAt,updatedAt:plan.updatedAt}));
  return {schemaVersion:1,revision:0,updatedAt:plan.updatedAt,items,plans:[plan],preferences:[],events:[],operationIds:[]};
}
export const values = totals => Object.fromEntries(totals.map(total=>[total.key,total.value]));
export const keyed = totals => Object.fromEntries(totals.map(total=>[total.key,total]));
export const freezeDeep = value => {
  if(value&&typeof value==='object'){for(const child of Object.values(value))freezeDeep(child);Object.freeze(value);}return value;
};
