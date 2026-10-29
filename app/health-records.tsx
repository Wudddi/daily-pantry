"use client";

import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode, type TextareaHTMLAttributes } from "react";
import { Archive, ArchiveRestore, ArrowDownToLine, Check, ChevronDown, Copy, Dumbbell, Loader2, Pencil, Plus, RefreshCw, Scale, Trash2, X } from "lucide-react";
import type { BodyMeasurement, HealthResponse, TrainingExercise, TrainingSession, TrainingSet } from "@/lib/health-types";
import { BODY_PARTS, classifyExercise, filterSessionsByBodyPart, groupExercises, type BodyPartId } from "@/lib/training-navigation.mjs";
import { weightStats, type WeightStats } from "@/lib/weight-stats.mjs";
import TrainingCalendar from "./training-calendar";
import WeightChart from "./weight-chart";
import "./health.css";

type HealthView = "weight" | "training";
type HealthAction = "upsert_measurement" | "archive_measurement" | "upsert_session" | "archive_session";
const sourceLabels = { manual: "手动记录", user_note: "备忘录导入", chat: "聊天记录" };
const setKinds = { unknown: "未注明", warmup: "热身组", working: "正式组", drop: "递减组" };
const loadBases = { unknown: "未注明", single_hand: "单手", total: "总重量", machine: "器械标重", bodyweight: "自重" };
const displayNumber = (value: number | null | undefined, digits = 2) => value == null ? "—" : new Intl.NumberFormat("zh-CN", { maximumFractionDigits: digits }).format(value);
const nullableNumber = (value: string) => value.trim() === "" ? null : Number(value);
function localToday() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  return ["year", "month", "day"].map(key => parts.find(part => part.type === key)?.value).join("-");
}
function signed(value: number | null | undefined) { return value == null ? "—" : (value > 0 ? "+" : "") + displayNumber(value); }
function measurementDraft(): BodyMeasurement {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), date: localToday(), weightKg: null, waistCm: null, bodyFatPct: null, condition: "", notes: "", sourceText: "", source: "manual", archived: false, createdAt: now, updatedAt: now };
}
function blankSet(previous?: TrainingSet): TrainingSet {
  return { weight: null, unit: previous ? previous.unit : "kg", reps: null, kind: previous?.kind ?? "unknown", loadBasis: previous?.loadBasis ?? "unknown", effortFromRep: null, rir: null, rpe: null, notes: "", sourceText: "" };
}
function blankExercise(): TrainingExercise { return { name: "", equipment: "", notes: "", sets: [blankSet()] }; }
function sessionDraft(): TrainingSession {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), date: localToday(), title: "", status: "completed", durationMinutes: null, notes: "", sourceText: "", source: "manual", exercises: [blankExercise()], archived: false, createdAt: now, updatedAt: now };
}
function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a"); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function csv(rows: unknown[][]) {
  return "\uFEFF" + rows.map(row => row.map(value => '"' + String(value ?? "").replaceAll('"', '""') + '"').join(",")).join("\r\n");
}
async function responseJson(response: Response): Promise<HealthResponse> {
  try { return await response.json() as HealthResponse; }
  catch { throw new Error("健康记录服务暂未返回可读取的数据，请刷新重试。"); }
}
function editorRevisionIsStale(openedRevision: number | null, currentRevision: number | undefined) {
  return openedRevision === null || currentRevision === undefined || openedRevision !== currentRevision;
}
function validResponse(data: HealthResponse) {
  if (!data?.state || !Array.isArray(data.state.measurements) || !Array.isArray(data.state.sessions) || !data.summary || !Number.isSafeInteger(data.state.revision)) throw new Error("返回的健康记录格式不完整，请刷新重试。");
  return data;
}

export default function HealthRecords({ view }: { view: HealthView }) {
  const [data, setData] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(""), [conflict, setConflict] = useState(false), [auth, setAuth] = useState(false);
  const [measurement, setMeasurement] = useState<BodyMeasurement | null>(null), [session, setSession] = useState<TrainingSession | null>(null), [copyReference, setCopyReference] = useState<TrainingSession | null>(null);
  const [editorRevision, setEditorRevision] = useState<number | null>(null);
  const [measurementPage, setMeasurementPage] = useState(1);
  const [sessionExpansion, setSessionExpansion] = useState<Record<string, boolean>>({});
  const [trainingMonth, setTrainingMonth] = useState(() => localToday().slice(0, 7));
  const [selectedTrainingDate, setSelectedTrainingDate] = useState<string | null>(null), [trainingPage, setTrainingPage] = useState(1);
  const [bodyPartFilter, setBodyPartFilter] = useState<BodyPartId | "all">("all");
  const trainingSelectionInitialized = useRef(false);
  const [year, setYear] = useState("all"), [range, setRange] = useState<"30" | "90" | "all">("90"), [showArchived, setShowArchived] = useState(false), [sessionFilter, setSessionFilter] = useState<"all" | "completed" | "planned">("all");
  const saveLock = useRef(false), pending = useRef<{ signature: string; operationId: string } | null>(null);
  async function load() {
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/health", { cache: "no-store" });
      const result = await responseJson(response);
      setAuth(response.status === 401);
      if (!response.ok) throw new Error(result.error || "健康记录暂时无法读取，请重试。");
      setData(validResponse(result)); setConflict(false);
      if (conflict) setNotice(measurement || session ? "已读取最新版本。请先复制旧草稿，再关闭窗口并重新打开最新记录。" : "已读取最新版本，可以继续记录。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "读取失败，请重试。"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(""), 6000); return () => clearTimeout(timer); }, [notice]);
  async function save(action: HealthAction, payload: Record<string, unknown>, success: string, requiredRevision?: number | null) {
    if (!data || saveLock.current || conflict || loading) return false;
    if (requiredRevision !== undefined && editorRevisionIsStale(requiredRevision, data.state.revision)) {
      setError("当前草稿基于旧版本，无法保存。请先复制草稿，再关闭窗口并重新打开最新记录。");
      return false;
    }
    saveLock.current = true; setSaving(true); setError("");
    const signature = JSON.stringify({ action, ...payload });
    if (pending.current?.signature !== signature) pending.current = { signature, operationId: crypto.randomUUID() };
    try {
      const response = await fetch("/api/health", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...payload, operationId: pending.current.operationId, expectedRevision: requiredRevision ?? data.state.revision }) });
      const result = await responseJson(response);
      setAuth(response.status === 401);
      if (response.status === 409) { setConflict(true); throw new Error(requiredRevision !== undefined ? "健康记录已在其他地方更新。请刷新核对，复制草稿后关闭并重新打开最新记录。" : "健康记录已在其他地方更新，请刷新后重试。"); }
      if (!response.ok) throw new Error(result.error || "保存未完成，请重试。");
      setData(validResponse(result)); pending.current = null; setNotice(success); return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存结果暂无法确认，请刷新核对。"); return false; }
    finally { saveLock.current = false; setSaving(false); }
  }
  const state = data?.state;
  const measurements = useMemo(() => (state?.measurements ?? []).filter(entry => showArchived || !entry.archived).toSorted((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt)), [state, showArchived]);
  const weightProgress = useMemo(() => weightStats(state?.measurements ?? []), [state]);
  const activeWeights = weightProgress.points;
  const years = [...new Set((state?.measurements ?? []).map(entry => entry.date.slice(0, 4)))].sort().reverse();
  const filteredMeasurements = measurements.filter(entry => year === "all" || entry.date.startsWith(year));
  const measurementPages = Math.max(1, Math.ceil(filteredMeasurements.length / 30));
  const currentMeasurementPage = Math.min(measurementPage, measurementPages);
  const pagedMeasurements = filteredMeasurements.slice((currentMeasurementPage - 1) * 30, currentMeasurementPage * 30);
  const eligibleSessions = useMemo(() => (state?.sessions ?? []).filter(entry => (showArchived || !entry.archived) && (sessionFilter === "all" || entry.status === sessionFilter)).toSorted((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt)), [state, showArchived, sessionFilter]);
  const sessions = useMemo(() => filterSessionsByBodyPart(eligibleSessions, bodyPartFilter), [eligibleSessions, bodyPartFilter]);
  // Calendar-only projection: editing, copying and rendering still use whole records.
  const calendarSessions = useMemo(() => bodyPartFilter === "all" ? sessions : sessions.map(entry => ({ ...entry, exercises: entry.exercises.filter(exercise => classifyExercise(exercise.name) === bodyPartFilter) })), [sessions, bodyPartFilter]);
  const bodyPartLabel = BODY_PARTS.find(part => part.id === bodyPartFilter)?.label ?? "全部部位";
  const unfilteredMonthSessions = eligibleSessions.filter(entry => entry.date.startsWith(trainingMonth + "-"));
  const monthSessions = sessions.filter(entry => entry.date.startsWith(trainingMonth + "-"));
  const selectedSessions = selectedTrainingDate ? monthSessions.filter(entry => entry.date === selectedTrainingDate) : monthSessions;
  const trainingPages = Math.max(1, Math.ceil(selectedSessions.length / 5));
  const currentTrainingPage = Math.min(trainingPage, trainingPages);
  const pagedSessions = selectedTrainingDate ? selectedSessions : selectedSessions.slice((currentTrainingPage - 1) * 5, currentTrainingPage * 5);
  useEffect(() => {
    if (!data || trainingSelectionInitialized.current) return;
    trainingSelectionInitialized.current = true;
    const latest = sessions.find(entry => entry.date.startsWith(trainingMonth + "-"));
    if (latest) setSelectedTrainingDate(latest.date);
  }, [data, sessions, trainingMonth]);
  function changeTrainingMonth(month: string) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return;
    trainingSelectionInitialized.current = true;
    setTrainingMonth(month); setSelectedTrainingDate(null); setTrainingPage(1);
  }
  function selectTrainingDate(date: string | null) {
    trainingSelectionInitialized.current = true;
    if (date) setTrainingMonth(date.slice(0, 7));
    setSelectedTrainingDate(date); setTrainingPage(1);
  }
  function selectBodyPart(part: BodyPartId | "all") {
    if (part === bodyPartFilter) return;
    trainingSelectionInitialized.current = true;
    setBodyPartFilter(part); setSelectedTrainingDate(null); setTrainingPage(1);
  }
  const disabled = saving || loading || conflict || !data;
  const editorStale = editorRevisionIsStale(editorRevision, data?.state.revision);
  function openMeasurement(record: BodyMeasurement) {
    if (!data) return;
    setEditorRevision(data.state.revision); setMeasurement(record);
  }
  function openSession(record: TrainingSession, reference: TrainingSession | null = null) {
    if (!data) return;
    setEditorRevision(data.state.revision); setCopyReference(reference); setSession(record);
  }
  function exportJson() { if (data) download("健康记录-" + localToday() + ".json", JSON.stringify({ exportedAt: new Date().toISOString(), ...data }, null, 2), "application/json"); }
  function exportCsv() {
    if (!state) return;
    if (view === "weight") {
      download("体重与围度-" + localToday() + ".csv", csv([["ID", "日期", "体重kg", "腰围cm", "测量条件", "备注", "来源原文", "来源类型", "已归档"], ...state.measurements.toSorted((a, b) => a.date.localeCompare(b.date)).map(entry => [entry.id, entry.date, entry.weightKg, entry.waistCm, entry.condition, entry.notes, entry.sourceText, entry.source, entry.archived])]), "text/csv;charset=utf-8");
    } else {
      const rows: unknown[][] = [["训练ID", "日期", "标题", "计划或完成", "时长分钟", "训练备注", "训练来源原文", "动作", "器械", "动作备注", "组号", "重量", "单位", "次数", "组类型", "负重口径", "第几次开始吃力", "RIR", "RPE", "每组感受原话", "每组来源原文", "已归档"]];
      for (const entry of state.sessions) {
        if (!entry.exercises.length) rows.push([entry.id, entry.date, entry.title, entry.status, entry.durationMinutes, entry.notes, entry.sourceText, "", "", "", "", "", "", "", "", "", "", "", "", "", "", entry.archived]);
        for (const exercise of entry.exercises) {
          const sets: (TrainingSet | null)[] = exercise.sets.length ? exercise.sets : [null];
          sets.forEach((set, index) => rows.push([entry.id, entry.date, entry.title, entry.status, entry.durationMinutes, entry.notes, entry.sourceText, exercise.name, exercise.equipment, exercise.notes, set ? index + 1 : "", set?.weight, set?.unit, set?.reps, set?.kind, set?.loadBasis, set?.effortFromRep, set?.rir, set?.rpe, set?.notes, set?.sourceText, entry.archived]));
        }
      }
      download("训练记录-" + localToday() + ".csv", csv(rows), "text/csv;charset=utf-8");
    }
    setNotice("已导出记录，包含原文和归档记录。完整存档可用 JSON 导出。");
  }
  function openCopy(original: TrainingSession) {
    const draft = sessionDraft();
    openSession({ ...draft, title: original.title, status: "planned", exercises: original.exercises.map(exercise => ({ name: exercise.name, equipment: exercise.equipment, notes: "", sets: exercise.sets.map(set => blankSet(set)) })) }, original);
  }
  return <div className="health-module">
    <div className="health-heading"><div><span className="health-eyebrow">MY HEALTH NOTES</span><h1>{view === "weight" ? "体重进度" : "训练记录"}<span>.</span></h1><p>{view === "weight" ? "把真实的变化留下来，缺少的日期就留白。" : "重量、次数，还有当时的感受，都值得记下来。"}</p></div><button className="health-button primary" disabled={disabled} onClick={() => view === "weight" ? openMeasurement(measurementDraft()) : openSession(sessionDraft())}><Plus size={19}/>{view === "weight" ? "记录测量" : "记录训练"}</button></div>
    <div className="health-toolbar"><div className="health-sync"><span className={"health-sync-dot" + (error ? " error" : "")}/>{loading ? "正在读取健康记录…" : error ? "读取或保存需要检查" : data ? "健康记录已同步 · 版本 " + data.state.revision : "尚未连接"}</div><div className="health-actions"><button className="health-button quiet" onClick={() => void load()} disabled={loading || saving}><RefreshCw size={16} className={loading ? "spin" : ""}/>刷新健康记录</button><details className="health-export"><summary><ArrowDownToLine size={16}/>导出</summary><div><button disabled={!data} onClick={exportJson}>完整 JSON</button><button disabled={!data} onClick={exportCsv}>{view === "weight" ? "体重 CSV" : "训练 CSV"}</button></div></details></div></div>
    {error && <div className="health-alert" role="alert"><span>{error}{data && " 页面保留上次成功读取的数据。"}</span>{auth ? <a href="/signin-with-chatgpt?return_to=%2F" target="_top">登录后重试</a> : <button onClick={() => void load()} disabled={loading || saving}>刷新核对</button>}</div>}
    {notice && <div className="health-notice" role="status"><Check size={17}/>{notice}<button aria-label="关闭提示" onClick={() => setNotice("")}><X size={16}/></button></div>}
    {!data ? <section className="health-panel health-loading">{loading ? <><Loader2 size={28} className="spin"/><h2>正在读取你的记录</h2></> : <><Scale size={30}/><h2>健康记录尚未读取成功</h2><p>刷新成功后显示记录；目前不将它当作空记录。</p><button className="health-button" onClick={() => void load()}>重新读取</button></>}</section> : view === "weight" ? <>
      <WeightSummary progress={weightProgress}/>
      <section className="health-panel health-chart-panel"><div className="health-section-heading"><div><h2>体重趋势</h2><p>每个点是一条记录。空缺日不补值，超过 7 天的间隔断线显示。</p></div><div className="health-segmented" aria-label="趋势时间范围">{(["30", "90", "all"] as const).map(value => <button key={value} aria-pressed={range === value} className={range === value ? "selected" : ""} onClick={() => setRange(value)}>{value === "all" ? "全部" : value + " 天"}</button>)}</div></div><WeightChart measurements={activeWeights} range={range}/></section>
      <WeightComparisons progress={weightProgress}/>
      <section className="health-panel"><div className="health-section-heading"><div><h2>测量明细</h2><p>按实际日期倒序排列；原文和备注完整保留。</p></div><div className="health-list-filters"><label>年份<select value={year} onChange={event => { setYear(event.target.value); setMeasurementPage(1); }}><option value="all">全部年份</option>{years.map(value => <option key={value}>{value}</option>)}</select></label><label className="health-check"><input type="checkbox" checked={showArchived} onChange={event => { setShowArchived(event.target.checked); setMeasurementPage(1); }}/>显示归档</label></div></div>
        {filteredMeasurements.length ? <div className="health-table-scroll"><table className="health-measurement-table"><thead><tr><th>日期</th><th>体重 kg</th><th>腰围 cm</th><th>条件、原文与备注</th><th>操作</th></tr></thead><tbody>{pagedMeasurements.map(entry => <tr key={entry.id} className={entry.archived ? "health-archived" : ""}><td><strong>{entry.date}</strong><small>{sourceLabels[entry.source]}{entry.archived ? " · 已归档" : ""}</small></td><td className="health-number">{displayNumber(entry.weightKg)}</td><td>{displayNumber(entry.waistCm)}</td><td><div className="health-condition">{entry.condition || "测量条件未注明"}</div><details className="health-source"><summary>查看原文与备注</summary>{entry.notes && <p className="health-original">{entry.notes}</p>}<strong>来源原文</strong><p className="health-original">{entry.sourceText || "未提供来源原文"}</p></details></td><td><div className="health-row-actions"><button aria-label={"编辑 " + entry.date + " 测量"} title="编辑" disabled={disabled || entry.archived} onClick={() => openMeasurement(structuredClone(entry))}><Pencil size={17}/></button><button aria-label={(entry.archived ? "恢复 " : "归档 ") + entry.date + " 测量"} title={entry.archived ? "恢复记录" : "归档记录"} disabled={disabled} onClick={() => void save("archive_measurement", { id: entry.id, archived: !entry.archived }, entry.archived ? "测量记录已恢复" : "测量记录已归档")}>{entry.archived ? <ArchiveRestore size={17}/> : <Archive size={17}/>}</button></div></td></tr>)}</tbody></table></div> : <HealthEmpty title="这个范围暂时没有测量记录" text="可以切换年份，或手动补录已知的体重、腰围。"/>}
        {filteredMeasurements.length > 0 && <div className="health-pagination"><span>共 {filteredMeasurements.length} 条 · 每页 30 条 · 第 {currentMeasurementPage}/{measurementPages} 页</span><div><button className="health-button" disabled={currentMeasurementPage <= 1} onClick={() => setMeasurementPage(currentMeasurementPage - 1)}>上一页</button><button className="health-button" disabled={currentMeasurementPage >= measurementPages} onClick={() => setMeasurementPage(currentMeasurementPage + 1)}>下一页</button></div></div>}
      </section>
    </> : <>
      <div className="health-stats training"><Stat label="已完成训练" value={String(data.summary.completedSessionCount)} unit="次" detail="只统计明确标记已完成的记录"/><Stat label="待执行计划" value={String(data.summary.plannedSessionCount)} unit="次" detail="计划与实际完成分别保存"/></div>
      <section className="health-panel health-training-browser">
        <div className="health-section-heading"><div><h2>我的训练</h2><p>按日期找到训练，再按部位查看完整逐组记录。复制训练只创建未保存的计划草稿。</p></div><label className="health-check"><input type="checkbox" checked={showArchived} onChange={event => { setShowArchived(event.target.checked); setTrainingPage(1); }}/>显示归档</label></div>
        <div className="health-segmented health-training-tabs" aria-label="训练类型">{([{ id: "all", label: "全部记录" }, { id: "completed", label: "已完成" }, { id: "planned", label: "训练计划" }] as const).map(tab => <button key={tab.id} aria-pressed={sessionFilter === tab.id} className={sessionFilter === tab.id ? "selected" : ""} onClick={() => { setSessionFilter(tab.id); setTrainingPage(1); }}>{tab.label}</button>)}</div>
        <div className="health-global-body-filter"><div className="health-global-body-heading"><strong>按部位查训练</strong><p>月历和记录一起筛选，展开后直接查看所选部位。</p></div><div className="health-global-body-buttons" role="group" aria-label="按训练部位筛选月历和记录"><button type="button" aria-pressed={bodyPartFilter === "all"} onClick={() => selectBodyPart("all")}>全部<span>{unfilteredMonthSessions.length}</span></button>{BODY_PARTS.map(part => <button type="button" key={part.id} aria-pressed={bodyPartFilter === part.id} onClick={() => selectBodyPart(part.id)}>{part.label}<span>{filterSessionsByBodyPart(unfilteredMonthSessions, part.id).length}</span></button>)}</div></div>
        <TrainingCalendar sessions={calendarSessions} month={trainingMonth} onMonthChange={changeTrainingMonth} selectedDate={selectedTrainingDate} onSelectDate={selectTrainingDate}/>
        <div className="health-training-selection" aria-live="polite"><div><h3>{selectedTrainingDate ? selectedTrainingDate + " 的训练" : trainingMonth.replace("-", " 年 ") + " 月的训练"}</h3><p>{bodyPartLabel} · {selectedSessions.length} 条{sessionFilter === "completed" ? "已完成训练" : sessionFilter === "planned" ? "训练计划" : "训练记录"}{showArchived ? " · 包含归档" : ""}{selectedTrainingDate ? " · 显示当天匹配记录" : " · 按日期倒序"}</p></div>{selectedTrainingDate && <button className="health-button quiet" onClick={() => selectTrainingDate(null)}>查看整月记录</button>}</div>
        {selectedSessions.length ? <div className="health-session-list">{pagedSessions.map(entry => {
          const expanded = sessionExpansion[entry.id] ?? false;
          const detailsId = "training-details-" + entry.id;
          const matchedGroup = bodyPartFilter === "all" ? null : groupExercises(entry.exercises).find(group => group.id === bodyPartFilter);
          return <article className={"health-session" + (entry.archived ? " health-archived" : "")} key={entry.id}><div className="health-session-heading"><div><div className="health-session-meta"><time>{entry.date}</time><span className={"health-status " + entry.status}>{entry.status === "completed" ? "已完成" : "计划 · 未完成"}</span>{entry.archived && <span className="health-status">已归档</span>}</div><h3>{entry.title}</h3><p className="health-session-count">{entry.exercises.length} 个动作 · {entry.exercises.reduce((count, exercise) => count + exercise.sets.length, 0)} 组{entry.durationMinutes !== null && " · " + entry.durationMinutes + " 分钟"}</p>{matchedGroup && <p className="health-session-filter-count">筛选匹配：{matchedGroup.label} · {matchedGroup.exercises.length} 个动作 · {matchedGroup.exercises.reduce((count, item) => count + item.exercise.sets.length, 0)} 组</p>}</div><div className="health-row-actions"><button title="编辑训练" aria-label={"编辑 " + entry.title} disabled={disabled || entry.archived} onClick={() => openSession(structuredClone(entry))}><Pencil size={18}/></button><button title="复制为未保存计划草稿" aria-label={"复制 " + entry.title + " 为未保存计划草稿"} disabled={disabled} onClick={() => openCopy(entry)}><Copy size={18}/></button><button title={entry.archived ? "恢复训练" : "归档训练"} aria-label={(entry.archived ? "恢复 " : "归档 ") + entry.title} disabled={disabled} onClick={() => void save("archive_session", { id: entry.id, archived: !entry.archived }, entry.archived ? "训练记录已恢复" : "训练记录已归档")}>{entry.archived ? <ArchiveRestore size={18}/> : <Archive size={18}/>}</button></div></div>
          <button className="health-button quiet health-session-toggle" aria-expanded={expanded} aria-controls={detailsId} aria-label={(expanded ? "收起 " : "展开 ") + entry.date + " " + entry.title + " 的分部位逐组记录与原文"} onClick={() => setSessionExpansion(previous => ({ ...previous, [entry.id]: !expanded }))}><span>{expanded ? "收起分部位记录与原文" : "展开分部位记录与原文"}</span><ChevronDown size={18} className={expanded ? "expanded" : ""}/></button>
          <div id={detailsId} hidden={!expanded}>{expanded && <>
            <TrainingBodyTabs key={entry.id + "-" + bodyPartFilter} entry={entry} initialPart={bodyPartFilter === "all" ? null : bodyPartFilter}/>
            {entry.notes && <div className="health-session-notes"><strong>训练备注</strong><p className="health-original">{entry.notes}</p></div>}
            <details className="health-source session-source"><summary>完整来源原文 · {sourceLabels[entry.source]}</summary><p className="health-original">{entry.sourceText || "未提供来源原文"}</p></details>
            <button className="health-button quiet" disabled={disabled} onClick={() => openCopy(entry)}><Copy size={16}/>用这次动作创建未保存草稿</button>
          </>}</div>
        </article>; })}</div> : <HealthEmpty title={selectedTrainingDate ? "这一天在当前筛选下尚无训练记录" : "这个月在当前筛选下尚无训练记录"} text="未记录不代表休息。可以切换日期、月份或训练类型查看，也可以补录已确认的训练内容。"/>}
        {!selectedTrainingDate && selectedSessions.length > 0 && <div className="health-pagination"><span>共 {selectedSessions.length} 条 · 每页 5 条 · 第 {currentTrainingPage}/{trainingPages} 页</span><div><button className="health-button" disabled={currentTrainingPage <= 1} onClick={() => setTrainingPage(currentTrainingPage - 1)}>上一页</button><button className="health-button" disabled={currentTrainingPage >= trainingPages} onClick={() => setTrainingPage(currentTrainingPage + 1)}>下一页</button></div></div>}
      </section>
    </>}
    {measurement && <MeasurementEditor initial={measurement} stale={editorStale} saving={saving} conflict={conflict} error={error} loading={loading} onRefresh={() => void load()} onClose={() => setMeasurement(null)} onSave={async record => { if (await save("upsert_measurement", { measurement: record }, "测量记录已保存", editorRevision)) setMeasurement(null); }}/>}
    {session && <SessionEditor initial={session} stale={editorStale} reference={copyReference} sessions={state?.sessions ?? []} saving={saving} conflict={conflict} error={error} loading={loading} onRefresh={() => void load()} onClose={() => setSession(null)} onSave={async record => { if (await save("upsert_session", { session: record }, record.status === "planned" ? "训练计划已保存，尚未完成" : "已完成训练已保存", editorRevision)) { setSession(null); setCopyReference(null); } }}/>}
  </div>;
}

function TrainingBodyTabs({ entry, initialPart = null }: { entry: TrainingSession; initialPart?: BodyPartId | null }) {
  const groups = useMemo(() => groupExercises(entry.exercises), [entry.exercises]);
  const [selectedId, setSelectedId] = useState<string | null>(initialPart);
  const tabsId = useId(), tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const selectedGroup = groups.find(group => group.id === selectedId) ?? groups[0];
  if (!selectedGroup) return <p className="health-help health-training-no-exercises">这条记录尚未列出动作；训练备注与来源原文保留在下方。</p>;
  return <div className="health-body-pager">
    <div className="health-body-tabs" role="tablist" aria-label={entry.title + "的训练部位"} aria-orientation="horizontal">{groups.map((group, index) => <button type="button" role="tab" key={group.id} id={tabsId + "-tab-" + group.id} aria-selected={selectedGroup.id === group.id} aria-controls={tabsId + "-panel-" + group.id} tabIndex={selectedGroup.id === group.id ? 0 : -1} ref={node => { tabRefs.current[group.id] = node; }} onClick={() => setSelectedId(group.id)} onKeyDown={event => {
      let nextIndex = index;
      if (event.key === "ArrowRight") nextIndex = (index + 1) % groups.length;
      else if (event.key === "ArrowLeft") nextIndex = (index - 1 + groups.length) % groups.length;
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = groups.length - 1;
      else return;
      event.preventDefault();
      setSelectedId(groups[nextIndex].id); tabRefs.current[groups[nextIndex].id]?.focus();
    }}><strong>{group.label}</strong><span>{group.exercises.length} 动作 · {group.exercises.reduce((count, item) => count + item.exercise.sets.length, 0)} 组</span></button>)}</div>
    {groups.map(group => <div key={group.id} className="health-body-panel" role="tabpanel" tabIndex={selectedGroup.id === group.id ? 0 : -1} hidden={selectedGroup.id !== group.id} id={tabsId + "-panel-" + group.id} aria-labelledby={tabsId + "-tab-" + group.id}>{selectedGroup.id === group.id && <>
      <div className="health-body-panel-heading"><h4>{group.label}</h4><p>只显示本次这个部位的动作；逐组重量、次数与原话完整保留。</p></div>
      {group.exercises.map(({ exercise, index }) => <TrainingExerciseRecord key={index} exercise={exercise} originalIndex={index}/>)}
    </>}</div>)}
  </div>;
}
function TrainingExerciseRecord({ exercise, originalIndex }: { exercise: TrainingExercise; originalIndex: number }) {
  return <div className="health-exercise-record"><h4><span className="health-exercise-order">动作 {originalIndex + 1}</span>{exercise.name}{exercise.equipment && <small>{exercise.equipment}</small>}</h4>{exercise.notes && <p className="health-original">{exercise.notes}</p>}<div className="health-set-history">{exercise.sets.map((set, setIndex) => <div className="health-set-record" key={set.setId ?? setIndex}><span className="health-set-index">{setIndex + 1}</span><div><strong>{set.loadBasis === "bodyweight" && set.weight === null ? "自重" : displayNumber(set.weight) + (set.unit ? " " + set.unit : "（单位未注明）")}<span> × {displayNumber(set.reps, 0)} 次</span></strong><div className="health-set-meta">{set.kind !== "unknown" && <span>{setKinds[set.kind]}</span>}{set.loadBasis !== "unknown" && <span>{loadBases[set.loadBasis]}</span>}{set.effortFromRep !== null && <span>第 {set.effortFromRep} 次开始吃力</span>}{set.rir !== null && <span>RIR {set.rir}</span>}{set.rpe !== null && <span>RPE {set.rpe}</span>}</div>{set.notes && <p className="health-original health-feeling">{set.notes}</p>}{set.sourceText && <details className="health-source"><summary>这组的来源原话</summary><p className="health-original">{set.sourceText}</p></details>}</div></div>)}</div></div>;
}

function Stat({ label, value, unit, detail }: { label: string; value: string; unit: string; detail: string }) {
  return <article className="health-stat"><span>{label}</span><div><strong>{value}</strong><small>{unit}</small></div><p>{detail}</p></article>;
}
function WeightSummary({ progress }: { progress: WeightStats<BodyMeasurement> }) {
  const first = progress.points[0], latest = progress.points.at(-1);
  return <div className="health-stats"><Stat label="最新体重" value={displayNumber(latest?.weightKg)} unit="kg" detail={latest ? "记录于 " + latest.date : "尚未记录体重"}/><Stat label="较首条记录变化" value={signed(first && latest ? latest.weightKg! - first.weightKg! : null)} unit="kg" detail={first ? "起始 " + first.date + " · " + displayNumber(first.weightKg) + " kg" : "需要至少一条体重记录"}/><Stat label="最近 7 日平均" value={displayNumber(progress.weeks.current.averageKg)} unit="kg" detail={"覆盖 " + progress.weeks.current.coverageDays + "/7 天 · 缺失日不补值"}/><Stat label="累计记录天数" value={String(progress.dayCount)} unit="天" detail="按实测日期统计 · 缺失天不计为 0"/></div>;
}
function WeightComparisons({ progress }: { progress: WeightStats<BodyMeasurement> }) {
  return <section className="health-panel health-progress-panel"><div className="health-section-heading"><div><h2>近期变化</h2><p>{progress.anchorDate ? "截至 " + progress.anchorDate + " · 均值只计算有称重记录的日期" : "记录体重后，这里会显示近期变化"}</p></div></div><div className="health-progress-grid">{([{ days: 7, comparison: progress.weeks }, { days: 30, comparison: progress.months }]).map(({ days, comparison }) => {
    const { current, previous, averageChangeKg } = comparison;
    return <article className="health-progress-card" key={days}><header><h3>近 {days} 天</h3><span>{current.from && current.to ? current.from.slice(5) + " 至 " + current.to.slice(5) : "尚无记录"}</span></header><div className="health-progress-change"><strong>{signed(current.changeKg)}</strong><span>kg</span><small>首末实测变化</small></div><p className="health-progress-endpoints">{current.first && current.last && current.coverageDays >= 2 ? current.first.date + " · " + displayNumber(current.first.weightKg) + " → " + current.last.date + " · " + displayNumber(current.last.weightKg) + " kg" : "至少需要两个日期的称重记录"}</p><div className="health-progress-averages"><div><span>本期均重</span><strong>{displayNumber(current.averageKg)} <small>kg</small></strong></div><div><span>前 {days} 天均重</span><strong>{displayNumber(previous.averageKg)} <small>kg</small></strong></div><div><span>均重变化</span><strong>{signed(averageChangeKg)} <small>kg</small></strong></div></div><p className="health-progress-coverage">本期 {current.coverageDays}/{days} 天 · 前期 {previous.coverageDays}/{days} 天{previous.from && previous.to ? "（" + previous.from.slice(5) + " 至 " + previous.to.slice(5) + "）" : ""}</p>{averageChangeKg === null && <p className="health-progress-insufficient">两期各有至少 2 天记录后显示均重变化。</p>}</article>;
  })}</div>{progress.duplicateDayCount > 0 && <p className="health-help">有 {progress.duplicateDayCount} 天存在多条记录，统计按该日最近更新的体重记录计算；原始明细均保留。</p>}</section>;
}
function HealthEmpty({ title, text }: { title: string; text: string }) { return <div className="health-empty"><Dumbbell size={29} strokeWidth={1.4}/><h3>{title}</h3><p>{text}</p></div>; }

function HealthModal({ title, subtitle, children, saving, onClose }: { title: string; subtitle: string; children: ReactNode; saving: boolean; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null), closeRef = useRef(onClose), titleId = useId(); closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null, overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden"; box.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !saving) closeRef.current();
      if (event.key !== "Tab") return;
      const controls = box.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,a[href]');
      if (!controls?.length) return;
      const visible = [...controls].filter(element => element.getClientRects().length);
      const first = visible[0], last = visible.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === box.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    document.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = overflow; document.removeEventListener("keydown", onKey); previous?.focus(); };
  }, [saving]);
  return <div className="health-modal-backdrop" onMouseDown={event => { if (event.currentTarget === event.target && !saving) onClose(); }}><div className="health-modal" ref={box} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}><header><div><span className="health-eyebrow">HEALTH NOTES</span><h2 id={titleId}>{title}</h2><p>{subtitle}</p></div><button type="button" className="health-icon-button" onClick={onClose} disabled={saving} aria-label="关闭"><X size={22}/></button></header>{children}</div></div>;
}
type EditorStatus = { stale: boolean; saving: boolean; conflict: boolean; loading: boolean; error: string; onRefresh: () => void; onClose: () => void };
function EditorError({ error, conflict, loading, onRefresh }: Pick<EditorStatus, "error" | "conflict" | "loading" | "onRefresh">) {
  return error || conflict ? <div className="health-alert" role="alert"><span>{error || "请刷新并核对未保存的草稿。"}</span><button type="button" disabled={loading} onClick={onRefresh}>{loading ? "正在读取…" : "刷新，保留草稿"}</button></div> : null;
}
function StaleDraftNotice({ draft }: { draft: BodyMeasurement | TrainingSession }) {
  const [feedback, setFeedback] = useState("");
  const text = JSON.stringify(draft, null, 2);
  async function copyDraft() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text); setFeedback("完整草稿已复制。请关闭弹窗，再重新打开最新记录。");
    } catch { setFeedback("自动复制未完成。请展开下方草稿，长按或全选后手动复制。"); }
  }
  return <div className="health-alert health-stale-draft" role="alert"><div><strong>记录版本已更新，这份草稿暂不能保存</strong><p>请先复制未保存内容，再关闭弹窗并重新打开最新记录。刷新不会自动合并旧草稿，也不会解除保存限制。</p></div><button type="button" onClick={() => void copyDraft()}><Copy size={16}/>复制未保存内容</button>{feedback && <p className="health-copy-feedback" role="status">{feedback}</p>}<details><summary>展开完整草稿以手动复制</summary><textarea aria-label="完整未保存草稿，仅供复制" readOnly rows={8} value={text} onFocus={event => event.currentTarget.select()}/></details></div>;
}
function MeasurementEditor({ initial, onSave, ...status }: { initial: BodyMeasurement; onSave: (record: BodyMeasurement) => Promise<void> } & EditorStatus) {
  const [draft, setDraft] = useState(initial), [localError, setLocalError] = useState("");
  const update = (patch: Partial<BodyMeasurement>) => setDraft(previous => ({ ...previous, ...patch }));
  async function submit(event: FormEvent) { event.preventDefault(); if (status.stale || status.conflict || status.loading || status.saving) return; if ([draft.weightKg, draft.waistCm].every(value => value === null) && initial.bodyFatPct === null) { setLocalError("至少填写一项测量数据；未测量的项目留空。"); return; } setLocalError(""); await onSave(draft); }
  return <HealthModal title="记录体重与围度" subtitle="日期按多伦多当地时间。未测量的项目留空，不填 0。" saving={status.saving} onClose={status.onClose}><form onSubmit={submit}><div className="health-modal-body">{status.stale && <StaleDraftNotice draft={draft}/>}<div className="health-form-grid"><label className="health-field">测量日期<input type="date" required value={draft.date} onChange={event => update({ date: event.target.value })}/></label><div/><label className="health-field">体重 · kg<input type="number" min="0.01" max="1000" step="0.01" placeholder="未测量可留空" value={draft.weightKg ?? ""} onChange={event => update({ weightKg: nullableNumber(event.target.value) })}/></label><label className="health-field">腰围 · cm<input type="number" min="0.1" max="500" step="0.1" placeholder="未测量可留空" value={draft.waistCm ?? ""} onChange={event => update({ waistCm: nullableNumber(event.target.value) })}/></label><label className="health-field full">测量条件<input maxLength={1000} placeholder="例如：起床后、空腹；不确定可留空" value={draft.condition} onChange={event => update({ condition: event.target.value })}/></label><label className="health-field full">备注<LimitedTextarea rows={3} maxLength={6000} placeholder="当天情况，按原话记录" value={draft.notes} onChange={event => update({ notes: event.target.value })}/></label></div><details className="health-advanced"><summary>来源原文与更多信息</summary><label className="health-field">来源原文<LimitedTextarea rows={7} maxLength={12000} value={draft.sourceText} onChange={event => update({ sourceText: event.target.value })} placeholder="可粘贴原始记录；没有来源时留空"/></label><p className="health-help">来源：{sourceLabels[draft.source]}。编辑数值会保留原文，便于以后核对。</p></details>{localError && <p className="health-local-error" role="alert">{localError}</p>}<EditorError {...status}/></div><footer className="health-modal-footer"><span>{status.stale ? "草稿版本已变，请复制后关闭重开" : "未知值始终保留为空"}</span><div><button type="button" className="health-button" disabled={status.saving} onClick={status.onClose}>取消</button><button type="submit" className="health-button primary" disabled={status.saving || status.conflict || status.loading || status.stale}>{status.saving ? <Loader2 size={17} className="spin"/> : <Check size={17}/>}保存测量</button></div></footer></form></HealthModal>;
}
function SessionEditor({ initial, reference, sessions, onSave, ...status }: { initial: TrainingSession; reference: TrainingSession | null; sessions: TrainingSession[]; onSave: (record: TrainingSession) => Promise<void> } & EditorStatus) {
  const [draft, setDraft] = useState(initial), [localError, setLocalError] = useState("");
  const existingSession = sessions.some(entry => entry.id === initial.id);
  const existingCompleted = existingSession && initial.status === "completed";
  const exerciseSuggestionsId = useId();
  const exerciseNames = [...new Set(sessions.flatMap(entry => entry.exercises.map(exercise => exercise.name)))].sort();
  const update = (patch: Partial<TrainingSession>) => setDraft(previous => ({ ...previous, ...patch }));
  const updateExercise = (index: number, patch: Partial<TrainingExercise>) => setDraft(previous => ({ ...previous, exercises: previous.exercises.map((exercise, number) => number === index ? { ...exercise, ...patch } : exercise) }));
  function lastExercise(name: string) {
    for (const entry of sessions.filter(entry => !entry.archived && entry.status === "completed" && entry.id !== draft.id && entry.date <= draft.date).toSorted((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt))) {
      const exercise = entry.exercises.find(exercise => exercise.name.trim() === name.trim());
      if (exercise) return { date: entry.date, exercise };
    }
    return null;
  }
  function copyLast(index: number) {
    if (existingSession) return;
    const previous = lastExercise(draft.exercises[index].name);
    if (!previous) return;
    update({ status: "planned", exercises: draft.exercises.map((exercise, number) => number === index ? { ...exercise, equipment: previous.exercise.equipment, sets: previous.exercise.sets.map(set => blankSet(set)) } : exercise) });
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (status.stale || status.conflict || status.loading || status.saving) return;
    if (existingCompleted && draft.status !== "completed") { setLocalError("已有实际训练不能沿原记录改成计划。请关闭后回列表复制为新的计划草稿。"); return; }
    if (!draft.title.trim()) { setLocalError("给这次训练填一个标题。"); return; }
    if (draft.exercises.some(exercise => !exercise.name.trim())) { setLocalError("请填写动作名称，或移除空白动作。"); return; }
    setLocalError(""); await onSave({ ...draft, title: draft.title.trim(), exercises: draft.exercises.map(exercise => ({ ...exercise, name: exercise.name.trim() })) });
  }
  return <HealthModal title={reference ? "复制为待填写计划" : "记录一次训练"} subtitle="先写重量、次数和当时感受；更多口径可以稍后补充。留空表示未知。" saving={status.saving} onClose={status.onClose}><form onSubmit={submit}><div className="health-modal-body">
    {status.stale && <StaleDraftNotice draft={draft}/>}
    {reference && <div className="health-copy-banner"><Copy size={18}/><div><strong>已复制 {reference.date} 的动作与组结构</strong><p>当前为未保存的计划。重量、次数和感受已留空，按这次训练填写。</p><details className="health-source"><summary>查看上次原文与备注</summary><p className="health-original">{reference.notes || "无训练备注"}</p><p className="health-original">{reference.sourceText || "无来源原文"}</p></details></div></div>}
    <div className="health-form-grid"><label className="health-field">训练日期<input type="date" required value={draft.date} onChange={event => update({ date: event.target.value })}/></label><label className="health-field">这条记录是<select value={draft.status} onChange={event => update({ status: event.target.value as TrainingSession["status"] })}><option value="completed">已完成的训练</option><option value="planned" disabled={existingCompleted}>待执行的计划</option></select>{existingCompleted && <small className="health-help">已有实际记录保留为实际训练；新计划请从列表复制创建。</small>}</label><label className="health-field full">训练标题<input required maxLength={160} placeholder="例如：胸和三头 / 腿部训练" value={draft.title} onChange={event => update({ title: event.target.value })}/></label></div>
    <datalist id={exerciseSuggestionsId}>{exerciseNames.map(name => <option key={name} value={name}/>)}</datalist>
    <div className="health-exercise-editors">{draft.exercises.map((exercise, exerciseIndex) => {
      const last = exercise.name.trim() ? lastExercise(exercise.name) : null;
      return <section className="health-exercise-editor" key={exerciseIndex}><div className="health-exercise-editor-heading"><span className="health-exercise-number">{exerciseIndex + 1}</span><label className="health-field">动作名称<input required maxLength={160} placeholder="例如：哑铃卧推" list={exerciseSuggestionsId} value={exercise.name} onChange={event => updateExercise(exerciseIndex, { name: event.target.value })}/></label><button type="button" className="health-icon-button" aria-label={"移除动作 " + (exerciseIndex + 1)} onClick={() => update({ exercises: draft.exercises.filter((_, index) => index !== exerciseIndex) })}><Trash2 size={18}/></button></div>
        {last && <details className="health-last-exercise"><summary>上次同动作 · {last.date}</summary><div>{last.exercise.sets.map((set, index) => <p className="health-original" key={index}>{"第 " + (index + 1) + " 组：" + displayNumber(set.weight) + (set.unit ? " " + set.unit : "（单位未注明）") + " × " + displayNumber(set.reps, 0) + " 次"}{set.notes ? "\n" + set.notes : ""}{set.sourceText ? "\n" + set.sourceText : ""}</p>)}</div><button type="button" className="health-button quiet" disabled={existingSession} onClick={() => copyLast(exerciseIndex)}><Copy size={15}/>沿用上次组结构，创建未保存计划草稿</button>{existingSession && <p className="health-help">已有训练不在此替换组结构。请关闭编辑，回列表点击“复制为未保存计划草稿”新建记录。</p>}</details>}
        <div className="health-edit-sets">{exercise.sets.map((set, setIndex) => <SetEditor key={setIndex} set={set} index={setIndex} onChange={patch => updateExercise(exerciseIndex, { sets: exercise.sets.map((current, index) => index === setIndex ? { ...current, ...patch } : current) })} onRemove={() => updateExercise(exerciseIndex, { sets: exercise.sets.filter((_, index) => index !== setIndex) })}/>)}</div>
        <button type="button" className="health-button quiet" disabled={exercise.sets.length >= 100} onClick={() => updateExercise(exerciseIndex, { sets: [...exercise.sets, blankSet(exercise.sets.at(-1))] })}><Plus size={16}/>添加一组</button>
        <details className="health-advanced"><summary>器械与动作备注</summary><label className="health-field">器械说明<input maxLength={300} placeholder="没有注明就留空" value={exercise.equipment} onChange={event => updateExercise(exerciseIndex, { equipment: event.target.value })}/></label><label className="health-field">动作备注<LimitedTextarea rows={3} maxLength={2000} value={exercise.notes} onChange={event => updateExercise(exerciseIndex, { notes: event.target.value })}/></label></details>
      </section>;
    })}</div><button type="button" className="health-button health-add-exercise" disabled={draft.exercises.length >= 40} onClick={() => update({ exercises: [...draft.exercises, blankExercise()] })}><Plus size={18}/>添加动作</button>
    <label className="health-field health-session-note-field">这次训练的备注<LimitedTextarea rows={4} maxLength={6000} placeholder="当时的状态、恢复、感受，保留自己的说法" value={draft.notes} onChange={event => update({ notes: event.target.value })}/></label>
    <details className="health-advanced"><summary>训练时长与完整来源原文</summary><label className="health-field">训练时长 · 分钟<input type="number" min="0" max="1440" step="1" value={draft.durationMinutes ?? ""} onChange={event => update({ durationMinutes: nullableNumber(event.target.value) })}/></label><label className="health-field">完整来源原文<LimitedTextarea rows={8} maxLength={30000} placeholder="粘贴完整训练记录；无需压缩成摘要" value={draft.sourceText} onChange={event => update({ sourceText: event.target.value })}/></label><p className="health-help">来源：{sourceLabels[draft.source]}。未注明的单位、次数和负重口径保持未知。</p></details>
    {localError && <p className="health-local-error" role="alert">{localError}</p>}<EditorError {...status}/>
  </div><footer className="health-modal-footer"><span>{status.stale ? "草稿版本已变，请复制后关闭重开" : draft.status === "planned" ? "保存为计划，未完成" : "保存为已完成记录"}</span><div><button type="button" className="health-button" onClick={status.onClose} disabled={status.saving}>取消</button><button type="submit" className="health-button primary" disabled={status.saving || status.conflict || status.loading || status.stale}>{status.saving ? <Loader2 size={17} className="spin"/> : <Check size={17}/>}保存{draft.status === "planned" ? "计划" : "训练"}</button></div></footer></form></HealthModal>;
}
function SetEditor({ set, index, onChange, onRemove }: { set: TrainingSet; index: number; onChange: (patch: Partial<TrainingSet>) => void; onRemove: () => void }) {
  return <div className="health-set-editor"><div className="health-set-editor-main"><span className="health-set-index">{index + 1}</span><label className="health-field">重量<input type="number" min="0" max="5000" step="any" inputMode="decimal" placeholder="未知" value={set.weight ?? ""} onChange={event => onChange({ weight: nullableNumber(event.target.value) })}/></label><label className="health-field">单位<select value={set.unit ?? ""} onChange={event => onChange({ unit: event.target.value === "" ? null : event.target.value as "kg" | "lb" })}><option value="">未注明</option><option value="kg">kg</option><option value="lb">lb</option></select></label><label className="health-field">次数<input type="number" min="0" max="2000" step="1" inputMode="numeric" placeholder="未知" value={set.reps ?? ""} onChange={event => onChange({ reps: nullableNumber(event.target.value) })}/></label><button type="button" className="health-icon-button" aria-label={"移除第 " + (index + 1) + " 组"} onClick={onRemove}><X size={18}/></button><label className="health-field health-feeling-input">这组感受 · 保留原话<LimitedTextarea rows={2} maxLength={2000} placeholder="例如：从第8次开始吃力，最后两次动作有点变形" value={set.notes} onChange={event => onChange({ notes: event.target.value })}/></label></div><details className="health-advanced health-set-advanced"><summary>这组的更多信息</summary><div className="health-form-grid"><label className="health-field">组类型<select value={set.kind} onChange={event => onChange({ kind: event.target.value as TrainingSet["kind"] })}>{Object.entries(setKinds).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label className="health-field">负重口径<select value={set.loadBasis} onChange={event => onChange({ loadBasis: event.target.value as TrainingSet["loadBasis"] })}>{Object.entries(loadBases).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label className="health-field">第几次开始吃力 · 可选<input type="number" min="1" max="2000" step="1" value={set.effortFromRep ?? ""} onChange={event => onChange({ effortFromRep: nullableNumber(event.target.value) })}/></label><label className="health-field">剩余次数 RIR · 可选<input type="number" min="0" max="100" step="0.5" value={set.rir ?? ""} onChange={event => onChange({ rir: nullableNumber(event.target.value) })}/></label><label className="health-field">主观强度 RPE · 可选<input type="number" min="0" max="10" step="0.5" value={set.rpe ?? ""} onChange={event => onChange({ rpe: nullableNumber(event.target.value) })}/></label><label className="health-field full">这组的来源原文<LimitedTextarea rows={4} maxLength={6000} value={set.sourceText} onChange={event => onChange({ sourceText: event.target.value })} placeholder="未提供时留空"/></label></div></details></div>;
}

export function LimitedTextarea({ maxLength = 6000, onChange, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const [warning, setWarning] = useState("");
  const count = String(props.value ?? "").length;
  return <div className="health-textarea-wrap"><textarea {...props} maxLength={maxLength} onPaste={event => {
    const input = event.currentTarget;
    const resultLength = input.value.length - (input.selectionEnd - input.selectionStart) + event.clipboardData.getData("text").length;
    if (resultLength > maxLength) { event.preventDefault(); setWarning("本字段最多 " + maxLength + " 字。这次超长内容未粘贴，原文未被截断；请分到其他记录保存。"); } else setWarning("");
  }} onChange={event => { setWarning(""); onChange?.(event); }}/><small className="health-text-count">{count}/{maxLength} 字</small>{warning && <p className="health-local-error" role="alert">{warning}</p>}</div>;
}
