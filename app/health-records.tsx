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
const sourceLabels = { manual: "Manual entry", user_note: "Notes import", chat: "Chat record" };
const setKinds = { unknown: "Unspecified", warmup: "Warm-up set", working: "Working set", drop: "Drop set" };
const loadBases = { unknown: "Unspecified", single_hand: "Per hand", total: "Total load", machine: "Machine label", bodyweight: "Bodyweight" };
const displayNumber = (value: number | null | undefined, digits = 2) => value == null ? "—" : new Intl.NumberFormat("en-CA", { maximumFractionDigits: digits }).format(value);
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
  catch { throw new Error("No readable health data returned. Refresh and try again."); }
}
function editorRevisionIsStale(openedRevision: number | null, currentRevision: number | undefined) {
  return openedRevision === null || currentRevision === undefined || openedRevision !== currentRevision;
}
function validResponse(data: HealthResponse) {
  if (!data?.state || !Array.isArray(data.state.measurements) || !Array.isArray(data.state.sessions) || !data.summary || !Number.isSafeInteger(data.state.revision)) throw new Error("Health records are incomplete. Refresh and try again.");
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
      if (!response.ok) throw new Error(result.error || "Unable to load health records. Try again.");
      setData(validResponse(result)); setConflict(false);
      if (conflict) setNotice(measurement || session ? "Latest version loaded. Copy your old draft, close the dialog and reopen the latest record." : "Latest version loaded. You can continue recording.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to load. Try again."); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(""), 6000); return () => clearTimeout(timer); }, [notice]);
  async function save(action: HealthAction, payload: Record<string, unknown>, success: string, requiredRevision?: number | null) {
    if (!data || saveLock.current || conflict || loading) return false;
    if (requiredRevision !== undefined && editorRevisionIsStale(requiredRevision, data.state.revision)) {
      setError("This draft is based on an older version and cannot be saved. Copy it, close the dialog and reopen the latest record.");
      return false;
    }
    saveLock.current = true; setSaving(true); setError("");
    const signature = JSON.stringify({ action, ...payload });
    if (pending.current?.signature !== signature) pending.current = { signature, operationId: crypto.randomUUID() };
    try {
      const response = await fetch("/api/health", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...payload, operationId: pending.current.operationId, expectedRevision: requiredRevision ?? data.state.revision }) });
      const result = await responseJson(response);
      setAuth(response.status === 401);
      if (response.status === 409) { setConflict(true); throw new Error(requiredRevision !== undefined ? "Health records changed elsewhere. Refresh to review, copy your draft, then close and reopen the latest record." : "Health records changed elsewhere. Refresh and try again."); }
      if (!response.ok) throw new Error(result.error || "Saving did not complete. Try again.");
      setData(validResponse(result)); pending.current = null; setNotice(success); return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Save result is unconfirmed. Refresh to verify."); return false; }
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
  const bodyPartLabel = BODY_PARTS.find(part => part.id === bodyPartFilter)?.label ?? "All body parts";
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
  function exportJson() { if (data) download("health-records-" + localToday() + ".json", JSON.stringify({ exportedAt: new Date().toISOString(), ...data }, null, 2), "application/json"); }
  function exportCsv() {
    if (!state) return;
    if (view === "weight") {
      download("measurements-" + localToday() + ".csv", csv([["ID", "Date", "weight_kg", "waist_cm", "Measurement conditions", "Notes", "Original source text", "Source type", "Archived"], ...state.measurements.toSorted((a, b) => a.date.localeCompare(b.date)).map(entry => [entry.id, entry.date, entry.weightKg, entry.waistCm, entry.condition, entry.notes, entry.sourceText, entry.source, entry.archived])]), "text/csv;charset=utf-8");
    } else {
      const rows: unknown[][] = [["Training ID", "Date", "Title", "Planned or completed", "Duration (minutes)", "Training notes", "Original training source", "Exercise", "Equipment", "Exercise notes", "Set number", "Weight", "Unit", "Reps", "Set type", "Load basis", "Difficulty began at rep", "RIR", "RPE", "Original set feedback", "Original set source", "Archived"]];
      for (const entry of state.sessions) {
        if (!entry.exercises.length) rows.push([entry.id, entry.date, entry.title, entry.status, entry.durationMinutes, entry.notes, entry.sourceText, "", "", "", "", "", "", "", "", "", "", "", "", "", "", entry.archived]);
        for (const exercise of entry.exercises) {
          const sets: (TrainingSet | null)[] = exercise.sets.length ? exercise.sets : [null];
          sets.forEach((set, index) => rows.push([entry.id, entry.date, entry.title, entry.status, entry.durationMinutes, entry.notes, entry.sourceText, exercise.name, exercise.equipment, exercise.notes, set ? index + 1 : "", set?.weight, set?.unit, set?.reps, set?.kind, set?.loadBasis, set?.effortFromRep, set?.rir, set?.rpe, set?.notes, set?.sourceText, entry.archived]));
        }
      }
      download("training-records-" + localToday() + ".csv", csv(rows), "text/csv;charset=utf-8");
    }
    setNotice("Records exported, including original text and archived entries. Use JSON for a complete archive.");
  }
  function openCopy(original: TrainingSession) {
    const draft = sessionDraft();
    openSession({ ...draft, title: original.title, status: "planned", exercises: original.exercises.map(exercise => ({ name: exercise.name, equipment: exercise.equipment, notes: "", sets: exercise.sets.map(set => blankSet(set)) })) }, original);
  }
  return <div className="health-module">
    <div className="health-heading"><div><span className="health-eyebrow">MY HEALTH NOTES</span><h1>{view === "weight" ? "Weight progress" : "Training records"}<span>.</span></h1><p>{view === "weight" ? "Keep real measurements. Leave missing dates blank." : "Record the weight, reps and how each set felt."}</p></div><button className="health-button primary" disabled={disabled} onClick={() => view === "weight" ? openMeasurement(measurementDraft()) : openSession(sessionDraft())}><Plus size={19}/>{view === "weight" ? "Add measurement" : "Add training"}</button></div>
    <div className="health-toolbar"><div className="health-sync"><span className={"health-sync-dot" + (error ? " error" : "")}/>{loading ? "Loading health records…" : error ? "Review loading or saving" : data ? "Health records synced · revision " + data.state.revision : "Not connected"}</div><div className="health-actions"><button className="health-button quiet" onClick={() => void load()} disabled={loading || saving}><RefreshCw size={16} className={loading ? "spin" : ""}/>Refresh health records</button><details className="health-export"><summary><ArrowDownToLine size={16}/>Export</summary><div><button disabled={!data} onClick={exportJson}>Full JSON</button><button disabled={!data} onClick={exportCsv}>{view === "weight" ? "Weight CSV" : "Training CSV"}</button></div></details></div></div>
    {error && <div className="health-alert" role="alert"><span>{error}{data && " The last successfully loaded data remains visible."}</span>{auth ? <a href="/signin-with-chatgpt?return_to=%2F" target="_top">Sign in and retry</a> : <button onClick={() => void load()} disabled={loading || saving}>Refresh and review</button>}</div>}
    {notice && <div className="health-notice" role="status"><Check size={17}/>{notice}<button aria-label="Dismiss notice" onClick={() => setNotice("")}><X size={16}/></button></div>}
    {!data ? <section className="health-panel health-loading">{loading ? <><Loader2 size={28} className="spin"/><h2>Loading your records</h2></> : <><Scale size={30}/><h2>Health records have not loaded successfully</h2><p>Records will appear after a successful refresh. A failed read is not treated as an empty history.</p><button className="health-button" onClick={() => void load()}>Retry loading</button></>}</section> : view === "weight" ? <>
      <WeightSummary progress={weightProgress}/>
      <section className="health-panel health-chart-panel"><div className="health-section-heading"><div><h2>Weight trend</h2><p>Each point is a measurement. Missing days are not filled; gaps over 7 days are not connected.</p></div><div className="health-segmented" aria-label="Trend time range">{(["30", "90", "all"] as const).map(value => <button key={value} aria-pressed={range === value} className={range === value ? "selected" : ""} onClick={() => setRange(value)}>{value === "all" ? "All" : value + " days"}</button>)}</div></div><WeightChart measurements={activeWeights} range={range}/></section>
      <WeightComparisons progress={weightProgress}/>
      <section className="health-panel"><div className="health-section-heading"><div><h2>Measurement details</h2><p>Newest measurements first. Original text and notes are retained.</p></div><div className="health-list-filters"><label>Year<select value={year} onChange={event => { setYear(event.target.value); setMeasurementPage(1); }}><option value="all">All years</option>{years.map(value => <option key={value}>{value}</option>)}</select></label><label className="health-check"><input type="checkbox" checked={showArchived} onChange={event => { setShowArchived(event.target.checked); setMeasurementPage(1); }}/>Show archived</label></div></div>
        {filteredMeasurements.length ? <div className="health-table-scroll"><table className="health-measurement-table"><thead><tr><th>Date</th><th>Weight (kg)</th><th>Waist (cm)</th><th>Conditions, source and notes</th><th>Actions</th></tr></thead><tbody>{pagedMeasurements.map(entry => <tr key={entry.id} className={entry.archived ? "health-archived" : ""}><td><strong>{entry.date}</strong><small>{sourceLabels[entry.source]}{entry.archived ? " · Archived" : ""}</small></td><td className="health-number">{displayNumber(entry.weightKg)}</td><td>{displayNumber(entry.waistCm)}</td><td><div className="health-condition">{entry.condition || "Conditions unspecified"}</div><details className="health-source"><summary>View original text and notes</summary>{entry.notes && <p className="health-original">{entry.notes}</p>}<strong>Original source text</strong><p className="health-original">{entry.sourceText || "Original source not provided"}</p></details></td><td><div className="health-row-actions"><button aria-label={"Edit " + entry.date + " measurement"} title="Edit" disabled={disabled || entry.archived} onClick={() => openMeasurement(structuredClone(entry))}><Pencil size={17}/></button><button aria-label={(entry.archived ? "Restore " : "Archive ") + entry.date + " measurement"} title={entry.archived ? "Restore record" : "Archive record"} disabled={disabled} onClick={() => void save("archive_measurement", { id: entry.id, archived: !entry.archived }, entry.archived ? "Measurement restored" : "Measurement archived")}>{entry.archived ? <ArchiveRestore size={17}/> : <Archive size={17}/>}</button></div></td></tr>)}</tbody></table></div> : <HealthEmpty title="No measurements in this range" text="Try another year, or add known weight and waist measurements."/>}
        {filteredMeasurements.length > 0 && <div className="health-pagination"><span>Total: {filteredMeasurements.length} records · 30 per page · Page {currentMeasurementPage}/{measurementPages} </span><div><button className="health-button" disabled={currentMeasurementPage <= 1} onClick={() => setMeasurementPage(currentMeasurementPage - 1)}>Previous page</button><button className="health-button" disabled={currentMeasurementPage >= measurementPages} onClick={() => setMeasurementPage(currentMeasurementPage + 1)}>Next page</button></div></div>}
      </section>
    </> : <>
      <div className="health-stats training"><Stat label="Completed training" value={String(data.summary.completedSessionCount)} unit=" sessions" detail="Counts only records explicitly marked completed"/><Stat label="Planned sessions" value={String(data.summary.plannedSessionCount)} unit=" sessions" detail="Plans and completed sessions are saved separately"/></div>
      <section className="health-panel health-training-browser">
        <div className="health-section-heading"><div><h2>My training</h2><p>Find sessions by date, then review complete sets by body part. Copying creates an unsaved plan draft only.</p></div><label className="health-check"><input type="checkbox" checked={showArchived} onChange={event => { setShowArchived(event.target.checked); setTrainingPage(1); }}/>Show archived</label></div>
        <div className="health-segmented health-training-tabs" aria-label="Training type">{([{ id: "all", label: "All records" }, { id: "completed", label: "Completed" }, { id: "planned", label: "Training plans" }] as const).map(tab => <button key={tab.id} aria-pressed={sessionFilter === tab.id} className={sessionFilter === tab.id ? "selected" : ""} onClick={() => { setSessionFilter(tab.id); setTrainingPage(1); }}>{tab.label}</button>)}</div>
        <div className="health-global-body-filter"><div className="health-global-body-heading"><strong>Browse by body part</strong><p>Filters both calendar and records; expand to view the selected body part.</p></div><div className="health-global-body-buttons" role="group" aria-label="Filter calendar and records by body part"><button type="button" aria-pressed={bodyPartFilter === "all"} onClick={() => selectBodyPart("all")}>All<span>{unfilteredMonthSessions.length}</span></button>{BODY_PARTS.map(part => <button type="button" key={part.id} aria-pressed={bodyPartFilter === part.id} onClick={() => selectBodyPart(part.id)}>{part.label}<span>{filterSessionsByBodyPart(unfilteredMonthSessions, part.id).length}</span></button>)}</div></div>
        <TrainingCalendar sessions={calendarSessions} month={trainingMonth} onMonthChange={changeTrainingMonth} selectedDate={selectedTrainingDate} onSelectDate={selectTrainingDate}/>
        <div className="health-training-selection" aria-live="polite"><div><h3>{selectedTrainingDate ? selectedTrainingDate + " training" : trainingMonth.replace("-", "-") + " training"}</h3><p>{bodyPartLabel} · {selectedSessions.length} records{sessionFilter === "completed" ? "Completed training" : sessionFilter === "planned" ? "Training plans" : "Training records"}{showArchived ? " · Includes archived" : ""}{selectedTrainingDate ? " · Matching records for this date" : " · Newest first"}</p></div>{selectedTrainingDate && <button className="health-button quiet" onClick={() => selectTrainingDate(null)}>View whole month</button>}</div>
        {selectedSessions.length ? <div className="health-session-list">{pagedSessions.map(entry => {
          const expanded = sessionExpansion[entry.id] ?? false;
          const detailsId = "training-details-" + entry.id;
          const matchedGroup = bodyPartFilter === "all" ? null : groupExercises(entry.exercises).find(group => group.id === bodyPartFilter);
          return <article className={"health-session" + (entry.archived ? " health-archived" : "")} key={entry.id}><div className="health-session-heading"><div><div className="health-session-meta"><time>{entry.date}</time><span className={"health-status " + entry.status}>{entry.status === "completed" ? "Completed" : "Planned · not completed"}</span>{entry.archived && <span className="health-status">Archived</span>}</div><h3>{entry.title}</h3><p className="health-session-count">{entry.exercises.length} exercises · {entry.exercises.reduce((count, exercise) => count + exercise.sets.length, 0)} sets{entry.durationMinutes !== null && " · " + entry.durationMinutes + " minutes"}</p>{matchedGroup && <p className="health-session-filter-count">Matching filter: {matchedGroup.label} · {matchedGroup.exercises.length} exercises · {matchedGroup.exercises.reduce((count, item) => count + item.exercise.sets.length, 0)} sets</p>}</div><div className="health-row-actions"><button title="Edit training" aria-label={"Edit " + entry.title} disabled={disabled || entry.archived} onClick={() => openSession(structuredClone(entry))}><Pencil size={18}/></button><button title="Copy as unsaved plan" aria-label={"Copy " + entry.title + " as unsaved plan"} disabled={disabled} onClick={() => openCopy(entry)}><Copy size={18}/></button><button title={entry.archived ? "Restore training" : "Archive training"} aria-label={(entry.archived ? "Restore " : "Archive ") + entry.title} disabled={disabled} onClick={() => void save("archive_session", { id: entry.id, archived: !entry.archived }, entry.archived ? "Training restored" : "Training archived")}>{entry.archived ? <ArchiveRestore size={18}/> : <Archive size={18}/>}</button></div></div>
          <button className="health-button quiet health-session-toggle" aria-expanded={expanded} aria-controls={detailsId} aria-label={(expanded ? "Collapse " : "Expand ") + entry.date + " " + entry.title + " sets by body part and original notes"} onClick={() => setSessionExpansion(previous => ({ ...previous, [entry.id]: !expanded }))}><span>{expanded ? "Collapse body parts and original notes" : "Expand body parts and original notes"}</span><ChevronDown size={18} className={expanded ? "expanded" : ""}/></button>
          <div id={detailsId} hidden={!expanded}>{expanded && <>
            <TrainingBodyTabs key={entry.id + "-" + bodyPartFilter} entry={entry} initialPart={bodyPartFilter === "all" ? null : bodyPartFilter}/>
            {entry.notes && <div className="health-session-notes"><strong>Training notes</strong><p className="health-original">{entry.notes}</p></div>}
            <details className="health-source session-source"><summary>Complete original source · {sourceLabels[entry.source]}</summary><p className="health-original">{entry.sourceText || "Original source not provided"}</p></details>
            <button className="health-button quiet" disabled={disabled} onClick={() => openCopy(entry)}><Copy size={16}/>Create an unsaved draft from these exercises</button>
          </>}</div>
        </article>; })}</div> : <HealthEmpty title={selectedTrainingDate ? "No matching training records for this date" : "No matching training records for this month"} text="No record does not mean a rest day. Try another date, month or training type, or add confirmed training details."/>}
        {!selectedTrainingDate && selectedSessions.length > 0 && <div className="health-pagination"><span>Total: {selectedSessions.length} records · 5 per page · Page {currentTrainingPage}/{trainingPages} </span><div><button className="health-button" disabled={currentTrainingPage <= 1} onClick={() => setTrainingPage(currentTrainingPage - 1)}>Previous page</button><button className="health-button" disabled={currentTrainingPage >= trainingPages} onClick={() => setTrainingPage(currentTrainingPage + 1)}>Next page</button></div></div>}
      </section>
    </>}
    {measurement && <MeasurementEditor initial={measurement} stale={editorStale} saving={saving} conflict={conflict} error={error} loading={loading} onRefresh={() => void load()} onClose={() => setMeasurement(null)} onSave={async record => { if (await save("upsert_measurement", { measurement: record }, "Measurement saved", editorRevision)) setMeasurement(null); }}/>}
    {session && <SessionEditor initial={session} stale={editorStale} reference={copyReference} sessions={state?.sessions ?? []} saving={saving} conflict={conflict} error={error} loading={loading} onRefresh={() => void load()} onClose={() => setSession(null)} onSave={async record => { if (await save("upsert_session", { session: record }, record.status === "planned" ? "Training plan saved; not completed" : "Completed training saved", editorRevision)) { setSession(null); setCopyReference(null); } }}/>}
  </div>;
}

function TrainingBodyTabs({ entry, initialPart = null }: { entry: TrainingSession; initialPart?: BodyPartId | null }) {
  const groups = useMemo(() => groupExercises(entry.exercises), [entry.exercises]);
  const [selectedId, setSelectedId] = useState<string | null>(initialPart);
  const tabsId = useId(), tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const selectedGroup = groups.find(group => group.id === selectedId) ?? groups[0];
  if (!selectedGroup) return <p className="health-help health-training-no-exercises">No exercises listed. Training notes and original sources are retained below.</p>;
  return <div className="health-body-pager">
    <div className="health-body-tabs" role="tablist" aria-label={entry.title + " body parts"} aria-orientation="horizontal">{groups.map((group, index) => <button type="button" role="tab" key={group.id} id={tabsId + "-tab-" + group.id} aria-selected={selectedGroup.id === group.id} aria-controls={tabsId + "-panel-" + group.id} tabIndex={selectedGroup.id === group.id ? 0 : -1} ref={node => { tabRefs.current[group.id] = node; }} onClick={() => setSelectedId(group.id)} onKeyDown={event => {
      let nextIndex = index;
      if (event.key === "ArrowRight") nextIndex = (index + 1) % groups.length;
      else if (event.key === "ArrowLeft") nextIndex = (index - 1 + groups.length) % groups.length;
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = groups.length - 1;
      else return;
      event.preventDefault();
      setSelectedId(groups[nextIndex].id); tabRefs.current[groups[nextIndex].id]?.focus();
    }}><strong>{group.label}</strong><span>{group.exercises.length} exercises · {group.exercises.reduce((count, item) => count + item.exercise.sets.length, 0)} sets</span></button>)}</div>
    {groups.map(group => <div key={group.id} className="health-body-panel" role="tabpanel" tabIndex={selectedGroup.id === group.id ? 0 : -1} hidden={selectedGroup.id !== group.id} id={tabsId + "-panel-" + group.id} aria-labelledby={tabsId + "-tab-" + group.id}>{selectedGroup.id === group.id && <>
      <div className="health-body-panel-heading"><h4>{group.label}</h4><p>Only this body part is shown. All set weights, reps and original feedback are retained.</p></div>
      {group.exercises.map(({ exercise, index }) => <TrainingExerciseRecord key={index} exercise={exercise} originalIndex={index}/>)}
    </>}</div>)}
  </div>;
}
function TrainingExerciseRecord({ exercise, originalIndex }: { exercise: TrainingExercise; originalIndex: number }) {
  return <div className="health-exercise-record"><h4><span className="health-exercise-order">Exercise {originalIndex + 1}</span>{exercise.name}{exercise.equipment && <small>{exercise.equipment}</small>}</h4>{exercise.notes && <p className="health-original">{exercise.notes}</p>}<div className="health-set-history">{exercise.sets.map((set, setIndex) => <div className="health-set-record" key={set.setId ?? setIndex}><span className="health-set-index">{setIndex + 1}</span><div><strong>{set.loadBasis === "bodyweight" && set.weight === null ? "Bodyweight" : displayNumber(set.weight) + (set.unit ? " " + set.unit : "(unit unspecified)")}<span> × {displayNumber(set.reps, 0)} reps</span></strong><div className="health-set-meta">{set.kind !== "unknown" && <span>{setKinds[set.kind]}</span>}{set.loadBasis !== "unknown" && <span>{loadBases[set.loadBasis]}</span>}{set.effortFromRep !== null && <span>Rep {set.effortFromRep} became difficult</span>}{set.rir !== null && <span>RIR {set.rir}</span>}{set.rpe !== null && <span>RPE {set.rpe}</span>}</div>{set.notes && <p className="health-original health-feeling">{set.notes}</p>}{set.sourceText && <details className="health-source"><summary>Original source for this set</summary><p className="health-original">{set.sourceText}</p></details>}</div></div>)}</div></div>;
}

function Stat({ label, value, unit, detail }: { label: string; value: string; unit: string; detail: string }) {
  return <article className="health-stat"><span>{label}</span><div><strong>{value}</strong><small>{unit}</small></div><p>{detail}</p></article>;
}
function WeightSummary({ progress }: { progress: WeightStats<BodyMeasurement> }) {
  const first = progress.points[0], latest = progress.points.at(-1);
  return <div className="health-stats"><Stat label="Latest weight" value={displayNumber(latest?.weightKg)} unit="kg" detail={latest ? "Recorded on " + latest.date : "No weight recorded"}/><Stat label="Change from first record" value={signed(first && latest ? latest.weightKg! - first.weightKg! : null)} unit="kg" detail={first ? "Starting: " + first.date + " · " + displayNumber(first.weightKg) + " kg" : "At least one weight record required"}/><Stat label="Last 7 days average" value={displayNumber(progress.weeks.current.averageKg)} unit="kg" detail={"Coverage: " + progress.weeks.current.coverageDays + "/7 days · missing days not filled"}/><Stat label="Recorded days" value={String(progress.dayCount)} unit=" days" detail="Based on measurement dates · missing days are not zero"/></div>;
}
function WeightComparisons({ progress }: { progress: WeightStats<BodyMeasurement> }) {
  return <section className="health-panel health-progress-panel"><div className="health-section-heading"><div><h2>Recent change</h2><p>{progress.anchorDate ? "Through " + progress.anchorDate + " · Averages include measurement days only" : "Recent changes appear after recording weight"}</p></div></div><div className="health-progress-grid">{([{ days: 7, comparison: progress.weeks }, { days: 30, comparison: progress.months }]).map(({ days, comparison }) => {
    const { current, previous, averageChangeKg } = comparison;
    return <article className="health-progress-card" key={days}><header><h3>Last {days} days</h3><span>{current.from && current.to ? current.from.slice(5) + " to " + current.to.slice(5) : "No records"}</span></header><div className="health-progress-change"><strong>{signed(current.changeKg)}</strong><span>kg</span><small>First-to-last change</small></div><p className="health-progress-endpoints">{current.first && current.last && current.coverageDays >= 2 ? current.first.date + " · " + displayNumber(current.first.weightKg) + " → " + current.last.date + " · " + displayNumber(current.last.weightKg) + " kg" : "At least two measurement dates required"}</p><div className="health-progress-averages"><div><span>Current period average</span><strong>{displayNumber(current.averageKg)} <small>kg</small></strong></div><div><span>Previous {days} day average</span><strong>{displayNumber(previous.averageKg)} <small>kg</small></strong></div><div><span>Average change</span><strong>{signed(averageChangeKg)} <small>kg</small></strong></div></div><p className="health-progress-coverage">Current: {current.coverageDays}/{days} days · Previous: {previous.coverageDays}/{days} days{previous.from && previous.to ? " (" + previous.from.slice(5) + " to " + previous.to.slice(5) + ")" : ""}</p>{averageChangeKg === null && <p className="health-progress-insufficient">Average changes appear when each period has at least 2 recorded days.</p>}</article>;
  })}</div>{progress.duplicateDayCount > 0 && <p className="health-help">There are {progress.duplicateDayCount} days with multiple records. Statistics use the most recently updated weight for each day; all original details are retained.</p>}</section>;
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
  return <div className="health-modal-backdrop" onMouseDown={event => { if (event.currentTarget === event.target && !saving) onClose(); }}><div className="health-modal" ref={box} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}><header><div><span className="health-eyebrow">HEALTH NOTES</span><h2 id={titleId}>{title}</h2><p>{subtitle}</p></div><button type="button" className="health-icon-button" onClick={onClose} disabled={saving} aria-label="Close"><X size={22}/></button></header>{children}</div></div>;
}
type EditorStatus = { stale: boolean; saving: boolean; conflict: boolean; loading: boolean; error: string; onRefresh: () => void; onClose: () => void };
function EditorError({ error, conflict, loading, onRefresh }: Pick<EditorStatus, "error" | "conflict" | "loading" | "onRefresh">) {
  return error || conflict ? <div className="health-alert" role="alert"><span>{error || "Refresh and review the unsaved draft."}</span><button type="button" disabled={loading} onClick={onRefresh}>{loading ? "Loading…" : "Refresh and keep draft"}</button></div> : null;
}
function StaleDraftNotice({ draft }: { draft: BodyMeasurement | TrainingSession }) {
  const [feedback, setFeedback] = useState("");
  const text = JSON.stringify(draft, null, 2);
  async function copyDraft() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text); setFeedback("Complete draft copied. Close this dialog and reopen the latest record.");
    } catch { setFeedback("Automatic copying failed. Expand the draft below and manually select and copy it."); }
  }
  return <div className="health-alert health-stale-draft" role="alert"><div><strong>The record version changed; this draft cannot be saved</strong><p>Copy unsaved content, close the dialog and reopen the latest record. Refreshing does not merge an old draft or lift its save restriction.</p></div><button type="button" onClick={() => void copyDraft()}><Copy size={16}/>Copy unsaved content</button>{feedback && <p className="health-copy-feedback" role="status">{feedback}</p>}<details><summary>Expand complete draft for manual copying</summary><textarea aria-label="Complete unsaved draft, for copying only" readOnly rows={8} value={text} onFocus={event => event.currentTarget.select()}/></details></div>;
}
function MeasurementEditor({ initial, onSave, ...status }: { initial: BodyMeasurement; onSave: (record: BodyMeasurement) => Promise<void> } & EditorStatus) {
  const [draft, setDraft] = useState(initial), [localError, setLocalError] = useState("");
  const update = (patch: Partial<BodyMeasurement>) => setDraft(previous => ({ ...previous, ...patch }));
  async function submit(event: FormEvent) { event.preventDefault(); if (status.stale || status.conflict || status.loading || status.saving) return; if ([draft.weightKg, draft.waistCm].every(value => value === null) && initial.bodyFatPct === null) { setLocalError("Enter at least one measurement. Leave unmeasured fields blank."); return; } setLocalError(""); await onSave(draft); }
  return <HealthModal title="Record weight and waist" subtitle="Dates use Toronto local time. Leave unmeasured fields blank, not zero." saving={status.saving} onClose={status.onClose}><form onSubmit={submit}><div className="health-modal-body">{status.stale && <StaleDraftNotice draft={draft}/>}<div className="health-form-grid"><label className="health-field">Measurement date<input type="date" required value={draft.date} onChange={event => update({ date: event.target.value })}/></label><div/><label className="health-field">Weight · kg<input type="number" min="0.01" max="1000" step="0.01" placeholder="Leave blank if not measured" value={draft.weightKg ?? ""} onChange={event => update({ weightKg: nullableNumber(event.target.value) })}/></label><label className="health-field">Waist · cm<input type="number" min="0.1" max="500" step="0.1" placeholder="Leave blank if not measured" value={draft.waistCm ?? ""} onChange={event => update({ waistCm: nullableNumber(event.target.value) })}/></label><label className="health-field full">Measurement conditions<input maxLength={1000} placeholder="For example: after waking, before eating; leave blank if unsure" value={draft.condition} onChange={event => update({ condition: event.target.value })}/></label><label className="health-field full">Notes<LimitedTextarea rows={3} maxLength={6000} placeholder="Record the conditions in your own words" value={draft.notes} onChange={event => update({ notes: event.target.value })}/></label></div><details className="health-advanced"><summary>Original source and more information</summary><label className="health-field">Original source text<LimitedTextarea rows={7} maxLength={12000} value={draft.sourceText} onChange={event => update({ sourceText: event.target.value })} placeholder="Paste the original record; leave blank if there is no source"/></label><p className="health-help">Source: {sourceLabels[draft.source]}. Editing values retains original text for later review.</p></details>{localError && <p className="health-local-error" role="alert">{localError}</p>}<EditorError {...status}/></div><footer className="health-modal-footer"><span>{status.stale ? "Draft version changed; copy, close and reopen" : "Unknown values always remain blank"}</span><div><button type="button" className="health-button" disabled={status.saving} onClick={status.onClose}>Cancel</button><button type="submit" className="health-button primary" disabled={status.saving || status.conflict || status.loading || status.stale}>{status.saving ? <Loader2 size={17} className="spin"/> : <Check size={17}/>}Save measurement</button></div></footer></form></HealthModal>;
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
    if (existingCompleted && draft.status !== "completed") { setLocalError("A completed session cannot be changed into a plan on the same record. Close this dialog and copy it as a new plan draft from the list."); return; }
    if (!draft.title.trim()) { setLocalError("Enter a title for this session."); return; }
    if (draft.exercises.some(exercise => !exercise.name.trim())) { setLocalError("Enter an exercise name or remove the empty exercise."); return; }
    setLocalError(""); await onSave({ ...draft, title: draft.title.trim(), exercises: draft.exercises.map(exercise => ({ ...exercise, name: exercise.name.trim() })) });
  }
  return <HealthModal title={reference ? "Copy as a plan to fill in" : "Record a training session"} subtitle="Start with weight, reps and how it felt. Other details can be added later; blank means unknown." saving={status.saving} onClose={status.onClose}><form onSubmit={submit}><div className="health-modal-body">
    {status.stale && <StaleDraftNotice draft={draft}/>}
    {reference && <div className="health-copy-banner"><Copy size={18}/><div><strong>Copied exercises and set structure from {reference.date} </strong><p>This is an unsaved plan. Weight, reps and feedback were cleared for you to enter this session.</p><details className="health-source"><summary>View previous source and notes</summary><p className="health-original">{reference.notes || "No training notes"}</p><p className="health-original">{reference.sourceText || "No original source"}</p></details></div></div>}
    <div className="health-form-grid"><label className="health-field">Training date<input type="date" required value={draft.date} onChange={event => update({ date: event.target.value })}/></label><label className="health-field">This record is<select value={draft.status} onChange={event => update({ status: event.target.value as TrainingSession["status"] })}><option value="completed">Completed training</option><option value="planned" disabled={existingCompleted}>A planned session</option></select>{existingCompleted && <small className="health-help">Existing completed training remains actual. Copy from the list to create a new plan.</small>}</label><label className="health-field full">Session title<input required maxLength={160} placeholder="For example: Chest and triceps / Legs" value={draft.title} onChange={event => update({ title: event.target.value })}/></label></div>
    <datalist id={exerciseSuggestionsId}>{exerciseNames.map(name => <option key={name} value={name}/>)}</datalist>
    <div className="health-exercise-editors">{draft.exercises.map((exercise, exerciseIndex) => {
      const last = exercise.name.trim() ? lastExercise(exercise.name) : null;
      return <section className="health-exercise-editor" key={exerciseIndex}><div className="health-exercise-editor-heading"><span className="health-exercise-number">{exerciseIndex + 1}</span><label className="health-field">Exercise name<input required maxLength={160} placeholder="For example: Dumbbell bench press" list={exerciseSuggestionsId} value={exercise.name} onChange={event => updateExercise(exerciseIndex, { name: event.target.value })}/></label><button type="button" className="health-icon-button" aria-label={"Remove exercise " + (exerciseIndex + 1)} onClick={() => update({ exercises: draft.exercises.filter((_, index) => index !== exerciseIndex) })}><Trash2 size={18}/></button></div>
        {last && <details className="health-last-exercise"><summary>Previous matching exercise · {last.date}</summary><div>{last.exercise.sets.map((set, index) => <p className="health-original" key={index}>{"Rep " + (index + 1) + " sets: " + displayNumber(set.weight) + (set.unit ? " " + set.unit : "(unit unspecified)") + " × " + displayNumber(set.reps, 0) + " reps"}{set.notes ? "\n" + set.notes : ""}{set.sourceText ? "\n" + set.sourceText : ""}</p>)}</div><button type="button" className="health-button quiet" disabled={existingSession} onClick={() => copyLast(exerciseIndex)}><Copy size={15}/>Reuse previous set structure in an unsaved plan</button>{existingSession && <p className="health-help">Do not replace the set structure of existing training here. Close the editor and use Copy as unsaved plan from the list to create a new record.</p>}</details>}
        <div className="health-edit-sets">{exercise.sets.map((set, setIndex) => <SetEditor key={setIndex} set={set} index={setIndex} onChange={patch => updateExercise(exerciseIndex, { sets: exercise.sets.map((current, index) => index === setIndex ? { ...current, ...patch } : current) })} onRemove={() => updateExercise(exerciseIndex, { sets: exercise.sets.filter((_, index) => index !== setIndex) })}/>)}</div>
        <button type="button" className="health-button quiet" disabled={exercise.sets.length >= 100} onClick={() => updateExercise(exerciseIndex, { sets: [...exercise.sets, blankSet(exercise.sets.at(-1))] })}><Plus size={16}/>Add set</button>
        <details className="health-advanced"><summary>Equipment and exercise notes</summary><label className="health-field">Equipment details<input maxLength={300} placeholder="Leave blank if unspecified" value={exercise.equipment} onChange={event => updateExercise(exerciseIndex, { equipment: event.target.value })}/></label><label className="health-field">Exercise notes<LimitedTextarea rows={3} maxLength={2000} value={exercise.notes} onChange={event => updateExercise(exerciseIndex, { notes: event.target.value })}/></label></details>
      </section>;
    })}</div><button type="button" className="health-button health-add-exercise" disabled={draft.exercises.length >= 40} onClick={() => update({ exercises: [...draft.exercises, blankExercise()] })}><Plus size={18}/>Add exercise</button>
    <label className="health-field health-session-note-field">Session notes<LimitedTextarea rows={4} maxLength={6000} placeholder="Condition, recovery and feedback in your own words" value={draft.notes} onChange={event => update({ notes: event.target.value })}/></label>
    <details className="health-advanced"><summary>Duration and complete original source</summary><label className="health-field">Duration · minutes<input type="number" min="0" max="1440" step="1" value={draft.durationMinutes ?? ""} onChange={event => update({ durationMinutes: nullableNumber(event.target.value) })}/></label><label className="health-field">Complete original source<LimitedTextarea rows={8} maxLength={30000} placeholder="Paste the complete training record; no summary is required" value={draft.sourceText} onChange={event => update({ sourceText: event.target.value })}/></label><p className="health-help">Source: {sourceLabels[draft.source]}. Unspecified units, reps and load basis remain unknown.</p></details>
    {localError && <p className="health-local-error" role="alert">{localError}</p>}<EditorError {...status}/>
  </div><footer className="health-modal-footer"><span>{status.stale ? "Draft version changed; copy, close and reopen" : draft.status === "planned" ? "Save as plan, not completed" : "Save completed session"}</span><div><button type="button" className="health-button" onClick={status.onClose} disabled={status.saving}>Cancel</button><button type="submit" className="health-button primary" disabled={status.saving || status.conflict || status.loading || status.stale}>{status.saving ? <Loader2 size={17} className="spin"/> : <Check size={17}/>}Save{draft.status === "planned" ? "Planned" : "Training"}</button></div></footer></form></HealthModal>;
}
function SetEditor({ set, index, onChange, onRemove }: { set: TrainingSet; index: number; onChange: (patch: Partial<TrainingSet>) => void; onRemove: () => void }) {
  return <div className="health-set-editor"><div className="health-set-editor-main"><span className="health-set-index">{index + 1}</span><label className="health-field">Weight<input type="number" min="0" max="5000" step="any" inputMode="decimal" placeholder="Unknown" value={set.weight ?? ""} onChange={event => onChange({ weight: nullableNumber(event.target.value) })}/></label><label className="health-field">Unit<select value={set.unit ?? ""} onChange={event => onChange({ unit: event.target.value === "" ? null : event.target.value as "kg" | "lb" })}><option value="">Unspecified</option><option value="kg">kg</option><option value="lb">lb</option></select></label><label className="health-field">Reps<input type="number" min="0" max="2000" step="1" inputMode="numeric" placeholder="Unknown" value={set.reps ?? ""} onChange={event => onChange({ reps: nullableNumber(event.target.value) })}/></label><button type="button" className="health-icon-button" aria-label={"Remove set " + (index + 1) + " sets"} onClick={onRemove}><X size={18}/></button><label className="health-field health-feeling-input">Set feedback · original wording<LimitedTextarea rows={2} maxLength={2000} placeholder="For example: Difficult from rep 8; form slipped on the last two reps" value={set.notes} onChange={event => onChange({ notes: event.target.value })}/></label></div><details className="health-advanced health-set-advanced"><summary>More set details</summary><div className="health-form-grid"><label className="health-field">Set type<select value={set.kind} onChange={event => onChange({ kind: event.target.value as TrainingSet["kind"] })}>{Object.entries(setKinds).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label className="health-field">Load basis<select value={set.loadBasis} onChange={event => onChange({ loadBasis: event.target.value as TrainingSet["loadBasis"] })}>{Object.entries(loadBases).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label className="health-field">Difficulty began at rep · optional<input type="number" min="1" max="2000" step="1" value={set.effortFromRep ?? ""} onChange={event => onChange({ effortFromRep: nullableNumber(event.target.value) })}/></label><label className="health-field">Reps in reserve (RIR) · optional<input type="number" min="0" max="100" step="0.5" value={set.rir ?? ""} onChange={event => onChange({ rir: nullableNumber(event.target.value) })}/></label><label className="health-field">Perceived exertion (RPE) · optional<input type="number" min="0" max="10" step="0.5" value={set.rpe ?? ""} onChange={event => onChange({ rpe: nullableNumber(event.target.value) })}/></label><label className="health-field full">Original source for this set<LimitedTextarea rows={4} maxLength={6000} value={set.sourceText} onChange={event => onChange({ sourceText: event.target.value })} placeholder="Leave blank if not provided"/></label></div></details></div>;
}

export function LimitedTextarea({ maxLength = 6000, onChange, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const [warning, setWarning] = useState("");
  const count = String(props.value ?? "").length;
  return <div className="health-textarea-wrap"><textarea {...props} maxLength={maxLength} onPaste={event => {
    const input = event.currentTarget;
    const resultLength = input.value.length - (input.selectionEnd - input.selectionStart) + event.clipboardData.getData("text").length;
    if (resultLength > maxLength) { event.preventDefault(); setWarning("Maximum " + maxLength + " characters. This oversized text was not pasted or truncated; save it across other records."); } else setWarning("");
  }} onChange={event => { setWarning(""); onChange?.(event); }}/><small className="health-text-count">{count}/{maxLength} characters</small>{warning && <p className="health-local-error" role="alert">{warning}</p>}</div>;
}
