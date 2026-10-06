"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Lock, Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import type { Agent, AgentInput, Project, PromptTemplateKey, ToolInfo } from "@/lib/types";
import { Badge, Button, Card, Field, Notice, errorMessage, inputClass } from "@/components/ui";

const LANGUAGES: [string, string][] = [
  ["en-IN", "English (India)"],
  ["hi-IN", "Hindi"],
  ["ta-IN", "Tamil"],
  ["te-IN", "Telugu"],
  ["kn-IN", "Kannada"],
  ["ml-IN", "Malayalam"],
  ["mr-IN", "Marathi"],
  ["bn-IN", "Bengali"],
  ["gu-IN", "Gujarati"],
  ["pa-IN", "Punjabi"],
  ["od-IN", "Odia"],
];
const TONES = ["professional", "friendly", "warm", "formal", "energetic"];
const MAX_QUESTIONS = 3;
const ALWAYS_ON = "end_call";

type TabKey = "identity" | "prompt" | "voice" | "knowledge" | "tools" | "sales";

interface Form {
  name: string;
  personaName: string;
  companyName: string;
  description: string;
  promptTemplateKey: PromptTemplateKey;
  systemPrompt: string;
  extraInstructions: string;
  callObjective: string;
  greeting: string;
  disclosureText: string;
  language: string;
  tone: string;
  maxResponseSentences: number;
  endCallWhenDone: boolean;
  conversationQuestions: string[];
  enabledTools: string[];
  offerSlots: boolean;
  autoBook: boolean;
  projectIds: string[];
}

function toForm(a: Agent | null, tools: ToolInfo[] | null): Form {
  return {
    name: a?.name ?? "",
    personaName: a?.personaName ?? "",
    companyName: a?.companyName ?? "",
    description: a?.description ?? "",
    promptTemplateKey: a?.promptTemplateKey ?? "generic",
    systemPrompt: a?.systemPrompt ?? "",
    extraInstructions: a?.extraInstructions ?? "",
    callObjective: a?.callObjective ?? "",
    greeting: a?.greeting ?? "",
    disclosureText: a?.disclosureText ?? "",
    language: a?.language ?? "en-IN",
    tone: a?.tone ?? "professional",
    maxResponseSentences: a?.behaviour.maxResponseSentences ?? 3,
    endCallWhenDone: a?.behaviour.endCallWhenDone ?? true,
    conversationQuestions: a?.behaviour.conversationQuestions ?? [],
    enabledTools: a?.enabledTools ?? [
      ALWAYS_ON,
      ...(tools ?? []).filter((t) => t.module === "core" && t.available).map((t) => t.name),
    ],
    offerSlots: a?.moduleConfig?.sales?.offerSlots ?? true,
    autoBook: a?.moduleConfig?.sales?.autoBook ?? false,
    projectIds: (a?.knowledge ?? []).filter((k) => k.sourceType === "project").map((k) => k.sourceId),
  };
}

const orNull = (s: string) => (s.trim() === "" ? null : s.trim());

export function AgentEditor({
  agent: initial,
  tools,
  projects,
  sales,
  canManage,
}: {
  agent: Agent | null;
  tools: ToolInfo[] | null;
  projects: Project[];
  sales: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const [agent, setAgent] = useState<Agent | null>(initial);
  const [form, setForm] = useState<Form>(() => toForm(initial, tools));
  const [tab, setTab] = useState<TabKey>("identity");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const editable = canManage && agent?.status !== "archived";
  const showSalesTab = sales && form.promptTemplateKey === "sales_real_estate";

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  const tabs: [TabKey, string][] = [
    ["identity", "Identity"],
    ["prompt", "Prompt"],
    ["voice", "Voice"],
    ["knowledge", "Knowledge"],
    ["tools", "Tools"],
    ...(showSalesTab ? ([["sales", "Sales settings"]] as [TabKey, string][]) : []),
  ];
  const activeTab = tabs.some(([k]) => k === tab) ? tab : "identity";

  function payload(): AgentInput {
    const input: AgentInput = {
      name: form.name.trim(),
      personaName: form.personaName.trim(),
      companyName: orNull(form.companyName),
      description: orNull(form.description),
      promptTemplateKey: form.promptTemplateKey,
      systemPrompt: orNull(form.systemPrompt),
      extraInstructions: orNull(form.extraInstructions),
      callObjective: orNull(form.callObjective),
      greeting: orNull(form.greeting),
      disclosureText: orNull(form.disclosureText),
      language: form.language,
      tone: form.tone,
      behaviour: {
        maxResponseSentences: form.maxResponseSentences,
        endCallWhenDone: form.endCallWhenDone,
        conversationQuestions: form.conversationQuestions.map((q) => q.trim()).filter(Boolean),
      },
      enabledTools: Array.from(new Set([ALWAYS_ON, ...form.enabledTools])),
    };
    if (showSalesTab) input.moduleConfig = { sales: { offerSlots: form.offerSlots, autoBook: form.autoBook } };
    return input;
  }

  async function save() {
    if (!form.name.trim() || !form.personaName.trim()) {
      setError("Name and persona name are required.");
      setTab("identity");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      let saved: Agent = agent ? await api.updateAgent(agent.id, payload()) : await api.createAgent(payload());
      if (sales) {
        const before = (saved.knowledge ?? [])
          .filter((k) => k.sourceType === "project")
          .map((k) => k.sourceId)
          .sort();
        const after = [...form.projectIds].sort();
        if (before.join() !== after.join()) saved = await api.setAgentKnowledge(saved.id, form.projectIds);
      }
      if (!agent) {
        router.push(`/agents/${saved.id}`);
        router.refresh();
        return;
      }
      setAgent(saved);
      setForm(toForm(saved, tools));
      setNotice("Agent saved.");
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function action(fn: (id: string) => Promise<Agent>, done: string) {
    if (!agent) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await fn(agent.id);
      setAgent(updated);
      setNotice(done);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function toggleTool(name: string) {
    set(
      "enabledTools",
      form.enabledTools.includes(name) ? form.enabledTools.filter((n) => n !== name) : [...form.enabledTools, name],
    );
  }

  function toggleProject(id: string) {
    set("projectIds", form.projectIds.includes(id) ? form.projectIds.filter((p) => p !== id) : [...form.projectIds, id]);
  }

  const coreTools = (tools ?? []).filter((t) => t.module === "core" && t.name !== ALWAYS_ON);
  const salesTools = (tools ?? []).filter((t) => t.module === "sales");
  const salesToolsAvailable = salesTools.some((t) => t.available);

  return (
    <div className="space-y-6">
      {agent && (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-stone-900">{agent.name}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {agent.isDefault && <Badge tone="success">Default</Badge>}
              {agent.status === "archived" && <Badge tone="warn">Archived</Badge>}
              <span className="text-sm text-stone-500">as {agent.personaName}</span>
            </div>
          </div>
          {canManage && (
            <div className="flex flex-wrap gap-2">
              {agent.status === "active" && !agent.isDefault && (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void action((id) => api.setDefaultAgent(id), "Default agent updated.")}
                >
                  Make default
                </Button>
              )}
              {agent.status === "active" ? (
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm("Archive this agent? It will no longer be selectable for new calls.")) {
                      void action((id) => api.archiveAgent(id), "Agent archived.");
                    }
                  }}
                >
                  Archive
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void action((id) => api.unarchiveAgent(id), "Agent restored.")}
                >
                  Unarchive
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      {!canManage && <Notice tone="info">You have read-only access. Only admins and owners can change agents.</Notice>}
      {canManage && agent?.status === "archived" && (
        <Notice tone="info">This agent is archived and read-only. Unarchive it to make changes.</Notice>
      )}

      <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-stone-200">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={activeTab === key}
            onClick={() => setTab(key)}
            className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${
              activeTab === key
                ? "border-emerald-700 text-emerald-800"
                : "border-transparent text-stone-500 hover:text-stone-800"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab === "identity" && (
        <Card title="Identity">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Agent name" hint="Internal name shown in lists.">
              <input disabled={!editable} value={form.name} onChange={(e) => set("name", e.target.value)} className={inputClass} />
            </Field>
            <Field label="Persona name" hint="The name the agent uses when speaking.">
              <input disabled={!editable} value={form.personaName} onChange={(e) => set("personaName", e.target.value)} className={inputClass} />
            </Field>
            <Field label="Company name (optional)">
              <input disabled={!editable} value={form.companyName} onChange={(e) => set("companyName", e.target.value)} className={inputClass} />
            </Field>
            <Field label="Prompt template">
              <select
                disabled={!editable}
                value={form.promptTemplateKey}
                onChange={(e) => set("promptTemplateKey", e.target.value as PromptTemplateKey)}
                className={inputClass}
              >
                <option value="generic">Generic</option>
                {(sales || form.promptTemplateKey === "sales_real_estate") && (
                  <option value="sales_real_estate">Real estate sales</option>
                )}
              </select>
            </Field>
            <Field label="Description" className="sm:col-span-2">
              <textarea rows={2} disabled={!editable} value={form.description} onChange={(e) => set("description", e.target.value)} className={inputClass} />
            </Field>
          </div>
        </Card>
      )}

      {activeTab === "prompt" && (
        <div className="space-y-6">
          <Card title="Language and greeting">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Language">
                <select disabled={!editable} value={form.language} onChange={(e) => set("language", e.target.value)} className={inputClass}>
                  {LANGUAGES.map(([code, label]) => (
                    <option key={code} value={code}>
                      {label}
                    </option>
                  ))}
                  {!LANGUAGES.some(([c]) => c === form.language) && <option value={form.language}>{form.language}</option>}
                </select>
              </Field>
              <Field label="Tone">
                <select disabled={!editable} value={form.tone} onChange={(e) => set("tone", e.target.value)} className={`${inputClass} capitalize`}>
                  {TONES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                  {!TONES.includes(form.tone) && <option value={form.tone}>{form.tone}</option>}
                </select>
              </Field>
              <Field label="Greeting" className="sm:col-span-2" hint="The first thing the agent says when the call is answered.">
                <textarea rows={2} disabled={!editable} value={form.greeting} onChange={(e) => set("greeting", e.target.value)} className={inputClass} />
              </Field>
            </div>
          </Card>

          <Card title="AI disclosure">
            <div className="mb-4 flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900">
              <Lock size={15} className="mt-0.5 shrink-0" />
              <span>
                <strong>The agent always tells the caller it is an AI assistant.</strong> This cannot be turned off. You
                can only change the wording.
              </span>
            </div>
            <Field label="Disclosure wording">
              <textarea rows={2} disabled={!editable} value={form.disclosureText} onChange={(e) => set("disclosureText", e.target.value)} className={inputClass} />
            </Field>
          </Card>

          <Card title="Instructions and goals">
            <div className="space-y-4">
              <Field label="System prompt" hint="Leave empty to use the selected template's built-in prompt.">
                <textarea rows={6} disabled={!editable} value={form.systemPrompt} onChange={(e) => set("systemPrompt", e.target.value)} className={`${inputClass} font-mono`} />
              </Field>
              <Field label="Extra instructions" hint="Additional guidance for the agent. It can never override the AI disclosure.">
                <textarea rows={3} disabled={!editable} value={form.extraInstructions} onChange={(e) => set("extraInstructions", e.target.value)} className={inputClass} />
              </Field>
              <Field label="Call objective">
                <textarea rows={2} disabled={!editable} value={form.callObjective} onChange={(e) => set("callObjective", e.target.value)} className={inputClass} />
              </Field>
              <Field label={`Conversation questions (up to ${MAX_QUESTIONS})`}>
                <div className="space-y-2">
                  {form.conversationQuestions.map((q, i) => (
                    <div key={i} className="flex gap-2">
                      <input
                        disabled={!editable}
                        value={q}
                        onChange={(e) =>
                          set("conversationQuestions", form.conversationQuestions.map((x, j) => (j === i ? e.target.value : x)))
                        }
                        className={inputClass}
                      />
                      {editable && (
                        <Button
                          variant="ghost"
                          aria-label="Remove question"
                          onClick={() => set("conversationQuestions", form.conversationQuestions.filter((_, j) => j !== i))}
                        >
                          <Trash2 size={14} />
                        </Button>
                      )}
                    </div>
                  ))}
                  {editable && form.conversationQuestions.length < MAX_QUESTIONS && (
                    <Button variant="secondary" onClick={() => set("conversationQuestions", [...form.conversationQuestions, ""])}>
                      <Plus size={14} />
                      Add question
                    </Button>
                  )}
                </div>
              </Field>
            </div>
          </Card>

          <Card title="Behaviour">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label={`Max sentences per reply: ${form.maxResponseSentences}`}>
                <input
                  type="range"
                  min={1}
                  max={10}
                  disabled={!editable}
                  value={form.maxResponseSentences}
                  onChange={(e) => set("maxResponseSentences", Number(e.target.value))}
                  className="w-full accent-emerald-700"
                />
              </Field>
              <label className="flex items-center gap-2 self-end text-sm text-stone-700">
                <input
                  type="checkbox"
                  disabled={!editable}
                  checked={form.endCallWhenDone}
                  onChange={(e) => set("endCallWhenDone", e.target.checked)}
                  className="h-4 w-4 accent-emerald-700"
                />
                End the call when the goal is done
              </label>
            </div>
          </Card>
        </div>
      )}

      {activeTab === "voice" && (
        <Card title="Voice">
          <Field label="Voice">
            <input disabled readOnly value={agent?.voice ?? ""} placeholder="Provider default" className={inputClass} />
          </Field>
          <p className="mt-2 text-xs text-stone-500">Provider default — voice selection is not enabled yet.</p>
        </Card>
      )}

      {activeTab === "knowledge" && (
        <Card title="Knowledge sources">
          {!sales ? (
            <Notice tone="info">
              Knowledge sources come from modules. Enable a module that provides them to attach knowledge to this agent.
            </Notice>
          ) : projects.length === 0 ? (
            <Notice tone="info">No projects yet. Create a project in the Sales module to bind its knowledge to this agent.</Notice>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-stone-500">Select the projects this agent can answer questions about.</p>
              <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {projects.map((p) => (
                  <li key={p.id}>
                    <label className="flex items-start gap-3 rounded-md border border-stone-200 px-3 py-2 text-sm">
                      <input
                        type="checkbox"
                        disabled={!editable}
                        checked={form.projectIds.includes(p.id)}
                        onChange={() => toggleProject(p.id)}
                        className="mt-0.5 h-4 w-4 accent-emerald-700"
                      />
                      <span>
                        <span className="block font-medium text-stone-900">{p.name}</span>
                        <span className="block text-xs text-stone-500">{p.location}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      )}

      {activeTab === "tools" && (
        <div className="space-y-6">
          {tools === null && (
            <Notice tone="info">The tool catalogue could not be loaded. The end_call tool is always on.</Notice>
          )}
          <Card title="Core tools">
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {coreTools.map((t) => (
                <ToolRow
                  key={t.name}
                  tool={t}
                  checked={form.enabledTools.includes(t.name)}
                  disabled={!editable || !t.available}
                  onChange={() => toggleTool(t.name)}
                />
              ))}
              <li>
                <label className="flex items-start gap-3 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-sm">
                  <input type="checkbox" checked disabled readOnly className="mt-0.5 h-4 w-4 accent-emerald-700" />
                  <span>
                    <span className="block font-medium text-stone-900">End the call</span>
                    <span className="block font-mono text-xs text-stone-400">{ALWAYS_ON} · always on</span>
                  </span>
                </label>
              </li>
            </ul>
          </Card>
          {salesTools.length > 0 && (
            <Card title="Sales tools">
              {!salesToolsAvailable && (
                <div className="mb-3">
                  <Notice tone="info">
                    Sales tools are unavailable because the Sales module is not enabled for this organization.
                  </Notice>
                </div>
              )}
              <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {salesTools.map((t) => (
                  <ToolRow
                    key={t.name}
                    tool={t}
                    checked={form.enabledTools.includes(t.name)}
                    disabled={!editable || !t.available}
                    onChange={() => toggleTool(t.name)}
                  />
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}

      {activeTab === "sales" && showSalesTab && (
        <Card title="Sales settings">
          <div className="space-y-2 text-sm text-stone-700">
            <label className="flex items-center gap-2">
              <input type="checkbox" disabled={!editable} checked={form.offerSlots} onChange={(e) => set("offerSlots", e.target.checked)} className="h-4 w-4 accent-emerald-700" />
              Offer site-visit slots
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" disabled={!editable} checked={form.autoBook} onChange={(e) => set("autoBook", e.target.checked)} className="h-4 w-4 accent-emerald-700" />
              Book the visit automatically when the lead agrees
            </label>
          </div>
        </Card>
      )}

      {error && <Notice tone="error">{error}</Notice>}
      {notice && !error && <Notice tone="success">{notice}</Notice>}

      {editable && (
        <div className="flex flex-wrap gap-2">
          <Button busy={busy} onClick={() => void save()}>
            {agent ? "Save changes" : "Create agent"}
          </Button>
        </div>
      )}
    </div>
  );
}

function ToolRow({
  tool,
  checked,
  disabled,
  onChange,
}: {
  tool: ToolInfo;
  checked: boolean;
  disabled: boolean;
  onChange: () => void;
}) {
  return (
    <li>
      <label
        className={`flex items-start gap-3 rounded-md border border-stone-200 px-3 py-2 text-sm ${
          tool.available ? "" : "bg-stone-50 opacity-70"
        }`}
      >
        <input type="checkbox" disabled={disabled} checked={checked} onChange={onChange} className="mt-0.5 h-4 w-4 accent-emerald-700" />
        <span>
          <span className="block font-medium text-stone-900">{tool.description}</span>
          <span className="block font-mono text-xs text-stone-400">{tool.name}</span>
        </span>
      </label>
    </li>
  );
}
