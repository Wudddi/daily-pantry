export type InventoryScope = 'food' | 'supplement' | 'condiment' | 'archive';
type OrganizationItem = { id:string; name:string; category:string; status:string; quantity:number|null; priority?:boolean; brand?:string; aliases?:string[]; notes?:string; ingredients?:string; supplementFacts?:string; nutrition?:{kcal:number|null; protein:number|null; carbs:number|null; fat:number|null} };
export const FOOD_CATEGORY_ORDER: string[];
export function isInventoryArchived(item:OrganizationItem):boolean;
export function inventoryItemInScope(item:OrganizationItem, scope:InventoryScope):boolean;
export function inventoryScopeCounts(items:OrganizationItem[]):Record<InventoryScope,number>;
export function compareInventoryItems(a:OrganizationItem,b:OrganizationItem):number;
export function inventoryViewItems<T extends OrganizationItem>(items:T[],options?:{scope?:InventoryScope;filter?:'all'|'priority'|'missing'|'pending';category?:string;query?:string}):T[];
export function groupInventoryItems<T extends OrganizationItem>(items:T[]):{category:string;items:T[]}[];
