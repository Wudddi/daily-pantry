"use client";
import { uiText, uiLocale, getUiLanguage } from '@/lib/ui-language.mjs';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowRightLeft, Check, ChevronDown, Loader2, X } from 'lucide-react';
import type { DietPlan } from '@/lib/diet-types';
import type { FoodItem } from '@/lib/inventory-types';
import { foodDisplayAmount } from '@/lib/food-display-amount.mjs';
import { previewRecipeGroupAction, recipeGroupEditView, type RecipeGroupAction } from '@/lib/recipe-group-actions.mjs';
import './recipe-portion-editor.css';

export type RecipePortionEditorProps = {
  plan:DietPlan;items:FoodItem[];revision:number;mealId:string;groupId:string;busy:boolean;
  mutate:(action:string,payload:Record<string,unknown>,message:string)=>Promise<boolean>;onClose:()=>void;
};
const slots:Record<string,string>={breakfast:uiText("Breakfast"),lunch:uiText("Lunch"),snack:uiText("Snack"),dinner:uiText("Dinner"),other:uiText("Other")};
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const n=(value:number)=>new Intl.NumberFormat(uiLocale(),{maximumFractionDigits:3}).format(value);

export default function RecipePortionEditor({plan,items,revision,mealId,groupId,busy,mutate,onClose}:RecipePortionEditorProps){
  const source=plan.meals.find(meal=>meal.id===mealId),group=source?.recipeGroups?.find(group=>group.id===groupId);
  const edit=useMemo(()=>{try{return{value:recipeGroupEditView(plan,items,mealId,groupId),error:''};}catch(cause){return{value:null,error:cause instanceof Error?uiText(cause.message):uiText("Recipe not found. Refresh the menu and try again.")};}},[plan,items,mealId,groupId]);
  const [basisFingerprint]=useState(()=>edit.value?.fingerprint??'');
  const [mode,setMode]=useState<'scale'|'move'>('scale');
  const [portion,setPortion]=useState(()=>String(edit.value?.portion??1)),[customPortion,setCustomPortion]=useState(()=>![.5,1].includes(edit.value?.portion??1));
  const [fraction,setFraction]=useState('100'),[customFraction,setCustomFraction]=useState(false);
  const destinations=plan.meals.filter(meal=>meal.id!==mealId&&meal.state!=='cancelled');
  const [targetMealId,setTargetMealId]=useState(()=>{
    const preferred={breakfast:'lunch',lunch:'dinner',snack:'dinner',dinner:'lunch'}[source?.slot as 'breakfast'|'lunch'|'snack'|'dinner'];
    return (destinations.find(meal=>meal.slot===preferred)??destinations[0])?.id??'';
  });
  const [transferId]=useState(()=>crypto.randomUUID());
  const [writing,setWriting]=useState(false),[localError,setLocalError]=useState(''),[unknown,setUnknown]=useState(false);
  const request=useRef<{action:string;payload:Record<string,unknown>}|null>(null),writeLock=useRef(false),box=useRef<HTMLDivElement>(null);
  const closeRef=useRef(onClose),busyRef=useRef(false);closeRef.current=onClose;busyRef.current=busy||writing;
  const heading=useId(),body=useId(),scalePanel=useId(),movePanel=useId();
  const portionValue=portion.trim()?Number(portion):NaN,fractionValue=fraction.trim()?Number(fraction)/100:NaN;
  const validNumber=mode==='scale'?finite(portionValue)&&portionValue>=.01&&portionValue<=100:finite(fractionValue)&&fractionValue>0&&fractionValue<=1&&!!targetMealId;
  const stale=!!edit.value&&basisFingerprint!==edit.value.fingerprint;
  const action:RecipeGroupAction=mode==='scale'
    ?{action:'scale_recipe_group',planId:plan.id,mealId,groupId,targetPortion:portionValue,expectedFingerprint:basisFingerprint}
    :{action:'move_recipe_group',planId:plan.id,fromMealId:mealId,groupId,toMealId:targetMealId,fractionOfRemaining:fractionValue,transferId,expectedFingerprint:basisFingerprint};
  const preview=useMemo(()=>{
    if(!validNumber||!edit.value||stale)return{value:null,error:''};
    try{return{value:previewRecipeGroupAction(plan,items,action),error:''};}catch(cause){return{value:null,error:cause instanceof Error?uiText(cause.message):uiText("Unable to adjust this recipe. Review the existing records.")};}
  },[plan,items,mode,portionValue,fractionValue,targetMealId,transferId,basisFingerprint,validNumber,stale,edit.value]);
  const allowed=mode==='scale'?edit.value?.canScale:edit.value?.canMove;
  const locked=busy||writing||unknown,canSave=!locked&&!stale&&!!allowed&&validNumber&&!!preview.value&&!preview.value.noChange;
  const target=plan.meals.find(meal=>meal.id===targetMealId),sourceName=slots[source?.slot??'other']??source?.title??uiText("This meal");
  const changeRows=preview.value?.changes??[];
  function display(changeMealId:string,lineId:string,quantity:number,unit:string){
    const line=plan.meals.find(meal=>meal.id===changeMealId)?.plannedItems.find(line=>line.id===lineId)
      ??preview.value?.plan.meals.find(meal=>meal.id===changeMealId)?.plannedItems.find(line=>line.id===lineId);
    return foodDisplayAmount({...line,quantity,unit}).text;
  }
  useEffect(()=>{
    if(typeof document==='undefined')return;
    const previous=document.activeElement as HTMLElement|null,overflow=document.body.style.overflow;
    document.body.style.overflow='hidden';box.current?.focus();
    function keydown(event:KeyboardEvent){
      if(event.key==='Escape'&&!busyRef.current)closeRef.current();
      if(event.key!=='Tab')return;
      const fields=box.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled])');
      if(!fields?.length)return;const first=fields[0],last=fields[fields.length-1];
      if(event.shiftKey&&(document.activeElement===first||document.activeElement===box.current)){event.preventDefault();last.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
    }
    document.addEventListener('keydown',keydown);return()=>{document.body.style.overflow=overflow;document.removeEventListener('keydown',keydown);previous?.focus();};
  },[]);
  async function save(retry=false){
    if(writeLock.current||busy||!retry&&!canSave||retry&&!request.current)return;
    if(!request.current){const{action:actionName,...fields}=action;request.current={action:actionName,payload:{...fields,expectedRevision:revision,operationId:crypto.randomUUID()}};}
    writeLock.current=true;setWriting(true);setLocalError('');
    try{
      const sent=request.current!;
      const ok=await mutate(sent.action,sent.payload,sent.action==='scale_recipe_group'?uiText("Whole recipe amount saved; daily nutrition updated"):uiText("Remaining recipe moved; daily totals unchanged"));
      if(!ok)throw new Error(uiText("Saving is unconfirmed. Retry the same action, or close and refresh to verify."));
      setUnknown(false);onClose();
    }catch(cause){setUnknown(true);setLocalError(cause instanceof Error?uiText(cause.message):uiText("Saving is unconfirmed. Review before retrying."));}
    finally{writeLock.current=false;setWriting(false);}
  }
  return <div className="recipe-portion-overlay" onPointerDown={event=>{if(event.target===event.currentTarget&&!busy&&!writing)onClose();}}><div className="recipe-portion-sheet" ref={box} role="dialog" aria-modal="true" aria-labelledby={heading} aria-describedby={body} tabIndex={-1}>
    <header><div><span>{sourceName}{uiText(" · Whole recipe")}</span><h2 id={heading}>{group?.name??uiText("Recipe portion")}</h2></div><button type="button" className="recipe-portion-close" aria-label={uiText("Close recipe adjustment")} disabled={busy||writing} onClick={onClose}><X size={20}/></button></header>
    <p className="recipe-portion-current" id={body}>{uiText("Current: ")}{n(edit.value?.portion??1)}{uiText(" portions · all ingredients adjust together")}</p>
    <div className="recipe-portion-tabs" role="tablist" aria-label={uiText("Whole recipe adjustment method")}><button type="button" id={scalePanel+'-tab'} role="tab" aria-selected={mode==='scale'} aria-controls={scalePanel} disabled={locked} onClick={()=>setMode('scale')}>{uiText("Recipe amount")}</button><button type="button" id={movePanel+'-tab'} role="tab" aria-selected={mode==='move'} aria-controls={movePanel} disabled={locked} onClick={()=>setMode('move')}><ArrowRightLeft size={14}/>{uiText("Move to another meal")}</button></div>
    <div id={scalePanel} role="tabpanel" aria-labelledby={scalePanel+'-tab'} hidden={mode!=='scale'}>
      <div className="recipe-portion-choices" role="group" aria-label={uiText("Choose whole recipe amount")}><button type="button" aria-pressed={!customPortion&&portionValue===.5} disabled={locked} onClick={()=>{setCustomPortion(false);setPortion('.5');}}>{uiText("Half portion")}</button><button type="button" aria-pressed={!customPortion&&portionValue===1} disabled={locked} onClick={()=>{setCustomPortion(false);setPortion('1');}}>{uiText("Whole portion")}</button><button type="button" aria-pressed={customPortion} disabled={locked} onClick={()=>setCustomPortion(true)}>{uiText("Custom")}</button></div>
      {customPortion&&<label className="recipe-portion-field">{uiText("Portions for this meal")}<div><input autoFocus type="number" inputMode="decimal" min="0.01" max="100" step="any" aria-label={uiText("Planned recipe portions")} value={portion} disabled={locked} onChange={event=>setPortion(event.target.value)}/><span>{uiText("portions")}</span></div></label>}
      <div className="recipe-portion-result"><span>{sourceName}{uiText(" allocation")}</span><strong>{finite(portionValue)?n(portionValue):uiText("Enter amount")}{uiText(" portions")}</strong></div>
      <p className="recipe-portion-note">{uiText("Changes the planned daily amount of this recipe. Reported intake is retained; inventory is not deducted.")}</p>
      {edit.value?.legacyBasis&&<p className="recipe-portion-basis">{uiText("One portion uses this saved ingredient group as its basis; amounts are not inferred from the dish name.")}</p>}
    </div>
    <div id={movePanel} role="tabpanel" aria-labelledby={movePanel+'-tab'} hidden={mode!=='move'}>
      <label className="recipe-portion-field">{uiText("Destination meal")}<select aria-label={uiText("Destination for the remaining recipe")} value={targetMealId} disabled={locked||!destinations.length} onChange={event=>setTargetMealId(event.target.value)}>{destinations.map(meal=><option key={meal.id} value={meal.id}>{slots[meal.slot]??meal.title}</option>)}</select></label>
      <div className="recipe-portion-choices" role="group" aria-label={uiText("Choose remaining amount to move")}><button type="button" aria-pressed={!customFraction&&fractionValue===.5} disabled={locked} onClick={()=>{setCustomFraction(false);setFraction('50');}}>{uiText("Half remaining")}</button><button type="button" aria-pressed={!customFraction&&fractionValue===1} disabled={locked} onClick={()=>{setCustomFraction(false);setFraction('100');}}>{uiText("All remaining")}</button><button type="button" aria-pressed={customFraction} disabled={locked} onClick={()=>setCustomFraction(true)}>{uiText("Custom percentage")}</button></div>
      {customFraction&&<label className="recipe-portion-field">{uiText("Share of the remaining amount")}<div><input autoFocus type="number" inputMode="decimal" min="0.01" max="100" step="any" aria-label={uiText("Remaining recipe transfer percentage")} value={fraction} disabled={locked} onChange={event=>setFraction(event.target.value)}/><span>%</span></div></label>}
      <div className="recipe-portion-result"><span>{slots[target?.slot??'other']??target?.title??uiText("Target meal")}{uiText(" receives")}</span><strong>{finite(fractionValue)?n(fractionValue*100):uiText("Enter amount")}{uiText("% remaining")}</strong></div>
      <p className="recipe-portion-note">{uiText("Moves all remaining ingredients in the same proportion and keeps the dish grouped in the other meal. Daily food and nutrition totals stay the same.")}</p>
      {!destinations.length&&<p className="recipe-portion-warning">{uiText("No other meal is available for this date.")}</p>}
    </div>
    {edit.value?.hasIntakeDraft&&<p className="recipe-portion-warning">{uiText("An unsubmitted intake draft will be retained. Review it after changing the menu.")}</p>}
    {source?.actualEntries.length? <p className="recipe-portion-basis">{uiText("Reported intake stays unchanged. Planned amounts cannot fall below recorded consumption.")}</p>:null}
    {stale&&<p className="recipe-portion-warning" role="alert">{uiText("This recipe or its intake records changed. Close and reopen to adjust the latest version.")}</p>}
    {(edit.error||preview.error||localError)&&<p className="recipe-portion-warning" role="alert">{localError||edit.error||preview.error}</p>}
    {!allowed&&edit.value&&!preview.error&&edit.value.issues.length>0&&<div className="recipe-portion-warning" role="alert">{edit.value.issues.map((issue,index)=><p key={issue.code+index}>{uiText(issue.message)}</p>)}</div>}
    {changeRows.length>0&&<details className="recipe-portion-details"><summary>{uiText("View ingredient changes")}<ChevronDown size={14}/></summary><ul>{changeRows.map(change=><li key={change.mealId+':'+change.lineId}><span>{change.name}</span><strong>{display(change.mealId,change.lineId,change.before,change.unit)} → {display(change.mealId,change.lineId,change.after,change.unit)}</strong></li>)}</ul></details>}
    <footer>{unknown?<><button type="button" className="button secondary" disabled={busy||writing} onClick={onClose}>{uiText("Close and review")}</button><button type="button" className="button primary" disabled={busy||writing} onClick={()=>void save(true)}>{writing?<Loader2 size={15} className="spin"/>:null}{uiText("Retry same action")}</button></>:<><button type="button" className="button secondary" disabled={busy||writing} onClick={onClose}>{uiText("Cancel")}</button><button type="button" className="button primary" disabled={!canSave} onClick={()=>void save()}>{writing?<Loader2 size={15} className="spin"/>:<Check size={15}/>} {mode==='scale'?uiText("Save recipe amount"):uiText("Save meal allocation")}</button></>}</footer>
  </div></div>;
}
