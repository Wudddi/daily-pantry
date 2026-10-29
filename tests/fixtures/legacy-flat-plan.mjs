/** A stored v1 snapshot, not a way to create new reservations through the app. */
export function legacyFlatPlan(state, raw, at = state.updatedAt) {
  const next=structuredClone(state), amounts=new Map();
  for(const row of raw.items)amounts.set(row.itemId,(amounts.get(row.itemId)??0)+row.quantity);
  const lines=[...amounts].sort(([a],[b])=>a.localeCompare(b)).map(([itemId,quantity])=>{
    const item=next.items.find(item=>item.id===itemId);
    if(!item)throw Error('invalid legacy fixture item');
    const line={itemId,name:item.name,quantity,unit:item.unit,unknownQuantity:item.quantity===null,baselineToken:item.quantityBaselineToken??item.confirmedAt??'initial'};
    if(item.quantity!==null){item.quantity=Math.round((item.quantity-quantity)*1e6)/1e6;item.status=item.quantity===0?'depleted':'available';}
    return line;
  });
  next.plans??=[];next.plans.push({...raw,notes:raw.notes??'',items:lines,status:'reserved',createdAt:at,updatedAt:at});
  return next;
}
