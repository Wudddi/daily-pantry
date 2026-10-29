export type DailyMenuSettlement={version:1;date:string;effectiveDate:string;source:'automatic_menu';basis:'auto_planned';policyStartDate:string;
  attemptedAt:string;settledAt:string|null;lastReconciledAt:string;plannedFingerprint:string;
  plannedMeals:{mealId:string;plannedItems:{id:string;itemId:string|null;name?:string;quantity:number;unit:string}[]}[];
  assumedMealIds:string[];accounting:'settled'|'pending_reconciliation'};
export function torontoLocalDate(at?:string):string;
export function dailyMenuPlannedFingerprint(plan:any):string;
export function dailyMenuAccountingPlan(plan:any):any;
export function dailyMenuAssumedMealIds(plan:any):string[];
export function prepareDailyMenuSettlement(state:any,plan:any,payload:unknown,at:string):{noChange:true;detail:string}|{noChange:false;plan:any};
