export type PersonalFoodCheck={mealId:string;lineId:string;checked:boolean;updatedAt:string};
export type PersonalFoodChecks={version:1;checks:PersonalFoodCheck[];updatedAt:string};
export function isPersonalFoodChecked(plan:unknown,mealId:string,lineId:string):boolean;
export function applyPersonalFoodCheck(state:any,payload:unknown,at:string):{items:any[];plans:any[];detail:string;noChange?:true};
