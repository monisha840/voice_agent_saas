import Link from "next/link";
import {
  ArrowRight,
  Boxes,
  Calculator,
  CheckCircle2,
  Database,
  Layers,
  Lock,
  Mic,
  Network,
  Phone,
  Server,
  Sparkles,
  Waves,
  type LucideIcon,
} from "lucide-react";
import { Header } from "@/components/Header";
import { ErrorState, ModuleDisabled } from "@/components/StateViews";
import { formatBudgetRange } from "@/lib/format";
import { api, ApiError } from "@/lib/api.server";
import { hasModule } from "@/lib/modules";

const FLOW_STEPS = [
  { n: "01", title: "Lead", desc: "A new lead enters the system with a requirement and budget." },
  { n: "02", title: "AI Call", desc: "The backend places a real outbound call via the telephony adapter." },
  { n: "03", title: "Speech Recognition", desc: "The customer's spoken answers are transcribed in real time." },
  { n: "04", title: "AI Reasoning", desc: "The conversational model decides what to say or what to check next." },
  { n: "05", title: "Tool / Project Data", desc: "The AI requests facts or actions through controlled backend tools." },
  { n: "06", title: "Voice Response", desc: "The AI's reply is synthesized to speech and played to the customer." },
  { n: "07", title: "Qualification", desc: "Requirement, budget, timeline and interest are captured as structured data." },
  { n: "08", title: "Site Visit", desc: "Available slots are checked and a visit is booked, if the lead agrees." },
  { n: "09", title: "CRM Update", desc: "Lead status, transcript, summary and visit are saved and shown on the dashboard." },
];

const TECH_STACK = [
  { category: "Telephony", value: "Exotel AgentStream" },
  { category: "Speech-to-Text", value: "Sarvam Saaras (saaras:v3)" },
  { category: "LLM", value: "Sarvam-105B" },
  { category: "Text-to-Speech", value: "Sarvam Bulbul (bulbul:v3)" },
  { category: "Backend", value: "Fastify + Node.js" },
  { category: "Database", value: "PostgreSQL + Drizzle" },
  { category: "Frontend", value: "Next.js" },
];

const CALL_ARCHITECTURE = [
  { icon: Phone, label: "Customer" },
  { icon: Network, label: "Exotel AgentStream" },
  { icon: Mic, label: "Saaras STT" },
  { icon: Sparkles, label: "Sarvam-105B" },
  { icon: Database, label: "AI Tools / Project Knowledge" },
  { icon: Waves, label: "Bulbul TTS" },
  { icon: Network, label: "Exotel" },
  { icon: Phone, label: "Customer" },
];

const ARCHITECTURE_EXPLAINERS = [
  { label: "Exotel AgentStream", text: "Carries the live call audio to and from the customer's phone over a bidirectional stream." },
  { label: "Saaras STT", text: "Converts the customer's spoken words into text the AI model can reason over." },
  { label: "Sarvam-105B", text: "Decides what to say next, or which tool to call, based on the conversation so far." },
  { label: "AI Tools / Project Knowledge", text: "The only path the AI has to project facts, lead data and visit booking — never direct database access." },
  { label: "Bulbul TTS", text: "Converts the AI's chosen reply back into natural speech for the call." },
];

const AI_TOOLS = [
  { name: "get_project_details", desc: "General project info, amenities, possession, FAQs." },
  { name: "get_project_price", desc: "Approved pricing for a given configuration." },
  { name: "get_project_configurations", desc: "Available unit types and sizes." },
  { name: "get_project_location", desc: "Location and nearby landmarks." },
  { name: "get_nearby_places", desc: "What is near the project: schools, hospitals, offices, transport, with distance." },
  { name: "check_visit_slots", desc: "Returns available site-visit slots." },
  { name: "book_site_visit", desc: "Books the chosen slot and updates lead status." },
  { name: "update_lead", desc: "Persists requirement/budget as understood from the call." },
  { name: "mark_not_interested", desc: "Marks the lead as not interested." },
  { name: "request_follow_up", desc: "Notes for the team that a person was asked for, a callback, or a detail to send." },
  { name: "end_call", desc: "Signals the call should end gracefully." },
];

const COST_ROWS = [
  { label: "Sarvam Saaras STT", value: "≈ ₹1.50" },
  { label: "Sarvam-105B", value: "≈ ₹0.22" },
  { label: "Sarvam Bulbul TTS", value: "≈ ₹5.40" },
  { label: "Exotel telephony", value: "≈ ₹2.40–₹3.00 (planning estimate)" },
];

const SCALE_ROWS = [
  { customers: "1 customer", sessions: "1 independent call session" },
  { customers: "10 customers", sessions: "10 independent call sessions" },
  { customers: "100 customers", sessions: "100 independent call sessions" },
  { customers: "1,000 customers", sessions: "1,000 independent call sessions" },
];

const TRADITIONAL_FLOW = [
  "Lead arrives",
  "Salesperson notices lead",
  "Salesperson calls",
  "Lead may not answer",
  "Manual follow-up",
  "Manual qualification",
  "Manual site-visit booking",
  "CRM update",
];

const AI_FLOW = [
  "Lead arrives",
  "AI calls immediately",
  "AI qualifies",
  "AI answers questions",
  "AI books visit",
  "AI updates CRM",
  "Sales team follows up with qualified leads",
];

const DEMO_SCRIPT = [
  "Open Demo.",
  "Explain the architecture in 30 seconds.",
  'Click "Start Live Demo".',
  "Open Rajesh Kumar.",
  "Click Call Lead.",
  "Let the MD hear the AI conversation.",
  "Show project questions being answered.",
  "Ask for a site visit.",
  "Select a slot.",
  "End the call.",
  "Show the updated dashboard.",
  "Show call summary, qualification, transcript and site visit.",
];

export default async function DemoPage() {
  let demoLeadId: string | null = null;
  let demoLeadBudget = "";
  let demoLeadConfig = "";
  let loadError: string | null = null;

  try {
    const me = await api.me();
    if (!hasModule(me.organization, "sales")) {
      return (
        <main className="min-h-screen bg-stone-50">
          <Header />
          <div className="mx-auto max-w-6xl px-6 py-16">
            <ModuleDisabled />
          </div>
        </main>
      );
    }
    const leads = await api.listLeads();
    const rajesh = leads.find((l) => l.name === "Rajesh Kumar");
    if (rajesh) {
      demoLeadId = rajesh.id;
      demoLeadConfig = rajesh.requirementConfig ?? "Requirement not captured";
      demoLeadBudget = formatBudgetRange(rajesh.budgetMin, rajesh.budgetMax);
    }
  } catch (err) {
    loadError =
      err instanceof ApiError && err.status === 403 && /module/i.test(err.message)
        ? "The Sales module is not enabled for this organization. An owner can turn it on in Settings."
        : "Could not reach the API. The Live Demo section needs the backend running.";
  }

  return (
    <main className="min-h-screen bg-stone-50">
      <Header />

      <div className="mx-auto max-w-5xl px-6 py-12">
        {/* Section 1 — Product overview */}
        <section className="text-center">
          <div className="mx-auto inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">
            <Sparkles size={12} />
            Sales module demo
          </div>
          <h1 className="mt-4 text-3xl font-semibold tracking-tight text-stone-900">
            Real Estate Voice AI
          </h1>
          <p className="mt-2 text-lg text-stone-500">
            From new lead to qualified site visit — automatically.
          </p>
          <p className="mx-auto mt-4 max-w-2xl text-sm leading-relaxed text-stone-600">
            The AI voice agent automatically calls real-estate leads, understands their
            requirements, answers project questions, qualifies them, and can book a site visit —
            without waiting for a salesperson to pick up the phone.
          </p>
        </section>

        {/* Section 2 — Complete flow */}
        <SectionHeading icon={Layers} title="Complete Flow" />
        <div className="rounded-xl border border-stone-200 bg-white p-6">
          <ol className="grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-3">
            {FLOW_STEPS.map((step) => (
              <li key={step.n} className="flex gap-3">
                <span className="shrink-0 font-mono text-xs font-semibold text-emerald-700">{step.n}</span>
                <div>
                  <div className="text-sm font-semibold text-stone-900">{step.title}</div>
                  <div className="mt-0.5 text-sm text-stone-500">{step.desc}</div>
                </div>
              </li>
            ))}
          </ol>
        </div>

        {/* Section 3 — Live demo */}
        <SectionHeading icon={Phone} title="Live Demo" />
        <div className="rounded-xl border border-emerald-200 bg-emerald-950 p-7 text-white">
          <div className="flex flex-wrap items-center justify-between gap-6">
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-emerald-300">
                Demo Lead
              </div>
              <div className="mt-1 text-xl font-semibold">Rajesh Kumar</div>
              <div className="mt-1 text-sm text-emerald-200/80">
                {demoLeadConfig || "2 BHK"} · {demoLeadBudget || "₹60L–₹80L"}
              </div>
              <div className="mt-3 text-xs text-emerald-300/70">Project: Green Valley Residency</div>
            </div>

            {demoLeadId ? (
              <Link
                href={`/leads/${demoLeadId}`}
                className="inline-flex items-center gap-2 rounded-lg bg-white px-5 py-3 text-sm font-semibold text-emerald-900 shadow-sm transition hover:bg-emerald-50"
              >
                Start Live Demo
                <ArrowRight size={16} />
              </Link>
            ) : (
              <span className="rounded-lg bg-white/10 px-5 py-3 text-sm text-emerald-200">
                {loadError ?? "Demo lead unavailable"}
              </span>
            )}
          </div>
        </div>

        {/* Section 4 — Technology stack */}
        <SectionHeading icon={Boxes} title="Technology Stack" />
        <div className="grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-stone-200 bg-stone-200 sm:grid-cols-2">
          {TECH_STACK.map((t) => (
            <div key={t.category} className="bg-white px-5 py-4">
              <div className="text-xs font-medium uppercase tracking-wide text-stone-400">
                {t.category}
              </div>
              <div className="mt-0.5 text-sm font-medium text-stone-900">{t.value}</div>
            </div>
          ))}
        </div>

        {/* Section 5 — How one call works */}
        <SectionHeading icon={Network} title="How One Call Works" />
        <div className="rounded-xl border border-stone-200 bg-white p-6">
          <div className="flex flex-wrap items-center justify-center gap-2">
            {CALL_ARCHITECTURE.map((step, i) => (
              <div key={`${step.label}-${i}`} className="flex items-center gap-2">
                <div className="flex flex-col items-center gap-1.5 rounded-lg border border-stone-200 px-3 py-2.5 text-center">
                  <step.icon size={16} className="text-emerald-700" />
                  <span className="max-w-[6.5rem] text-[11px] font-medium leading-tight text-stone-700">
                    {step.label}
                  </span>
                </div>
                {i < CALL_ARCHITECTURE.length - 1 && (
                  <ArrowRight size={14} className="shrink-0 text-stone-300" />
                )}
              </div>
            ))}
          </div>

          <dl className="mt-6 grid grid-cols-1 gap-4 border-t border-stone-100 pt-5 sm:grid-cols-2">
            {ARCHITECTURE_EXPLAINERS.map((e) => (
              <div key={e.label}>
                <dt className="text-sm font-semibold text-stone-900">{e.label}</dt>
                <dd className="mt-0.5 text-sm text-stone-500">{e.text}</dd>
              </div>
            ))}
          </dl>
        </div>

        {/* Section 6 — AI tools */}
        <SectionHeading icon={Lock} title="AI Tools" />
        <div className="rounded-xl border border-stone-200 bg-white p-6">
          <div className="mb-5 flex items-start gap-3 rounded-lg bg-stone-50 p-4">
            <Lock size={16} className="mt-0.5 shrink-0 text-emerald-700" />
            <p className="text-sm text-stone-700">
              The AI does not directly access the database. It requests approved actions through
              controlled tools.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {AI_TOOLS.map((tool) => (
              <div key={tool.name} className="rounded-lg border border-stone-200 p-3">
                <code className="text-xs font-semibold text-emerald-700">{tool.name}</code>
                <p className="mt-1 text-xs text-stone-500">{tool.desc}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Section 7 — Call economics */}
        <SectionHeading icon={Calculator} title="Estimated Cost Per 3-Minute Call" />
        <div className="rounded-xl border border-stone-200 bg-white p-6">
          <dl className="divide-y divide-stone-100">
            {COST_ROWS.map((row) => (
              <div key={row.label} className="flex items-center justify-between py-2.5 text-sm">
                <dt className="text-stone-600">{row.label}</dt>
                <dd className="font-medium text-stone-900">{row.value}</dd>
              </div>
            ))}
            <div className="flex items-center justify-between py-3 text-sm font-semibold text-stone-900">
              <dt>Estimated total</dt>
              <dd>≈ ₹9.52–₹10.12</dd>
            </div>
          </dl>
          <p className="mt-4 text-xs leading-relaxed text-stone-400">
            Illustrative planning estimate based on current published API rates and a 3-minute
            call. Exotel AgentStream/streaming charges are separate and must be confirmed
            commercially. Taxes, retries, infrastructure and other platform fees are excluded.
            Commercial pricing to be confirmed with provider.
          </p>
        </div>

        {/* Section 8 — Scale */}
        <SectionHeading icon={Server} title="Scale" />
        <div className="rounded-xl border border-stone-200 bg-white p-6">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {SCALE_ROWS.map((row) => (
              <div key={row.customers} className="rounded-lg border border-stone-200 p-4 text-center">
                <div className="text-sm font-semibold text-stone-900">{row.customers}</div>
                <ArrowRight size={14} className="mx-auto my-2 rotate-90 text-stone-300" />
                <div className="text-xs text-stone-500">{row.sessions}</div>
              </div>
            ))}
          </div>
          <p className="mt-5 text-sm text-stone-600">
            Each call has its own WebSocket session, conversation state, audio stream and AI
            context. The backend can scale horizontally, while AI inference is handled by cloud
            APIs. Exact concurrency limits depend on telephony and AI provider plans and are not
            fixed by this application.
          </p>
        </div>

        {/* Section 9 — Business value */}
        <SectionHeading icon={CheckCircle2} title="Business Value" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-stone-200 bg-white p-6">
            <div className="text-xs font-semibold uppercase tracking-wide text-stone-400">
              Traditional
            </div>
            <ol className="mt-3 space-y-2">
              {TRADITIONAL_FLOW.map((step, i) => (
                <li key={step} className="flex items-center gap-2 text-sm text-stone-600">
                  <span className="font-mono text-xs text-stone-300">{i + 1}</span>
                  {step}
                </li>
              ))}
            </ol>
          </div>
          <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-6">
            <div className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
              AI-Assisted
            </div>
            <ol className="mt-3 space-y-2">
              {AI_FLOW.map((step, i) => (
                <li key={step} className="flex items-center gap-2 text-sm text-stone-700">
                  <span className="font-mono text-xs text-emerald-400">{i + 1}</span>
                  {step}
                </li>
              ))}
            </ol>
          </div>
        </div>
        <p className="mt-4 text-center text-sm font-medium text-stone-700">
          Salespeople spend more time closing. AI handles the repetitive first conversation.
        </p>

        {/* Section 10 — Demo script */}
        <SectionHeading icon={Layers} title="How to Present This" />
        <div className="rounded-xl border border-stone-200 bg-white p-6">
          <ol className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
            {DEMO_SCRIPT.map((step, i) => (
              <li key={step} className="flex items-start gap-2.5 text-sm text-stone-700">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-stone-100 text-[11px] font-semibold text-stone-500">
                  {i + 1}
                </span>
                {step}
              </li>
            ))}
          </ol>
        </div>

        {loadError && (
          <div className="mt-6">
            <ErrorState title="Live Demo section limited" message={loadError} />
          </div>
        )}
      </div>
    </main>
  );
}

function SectionHeading({ icon: Icon, title }: { icon: LucideIcon; title: string }) {
  return (
    <div className="mb-4 mt-12 flex items-center gap-2">
      <Icon size={15} className="text-emerald-700" />
      <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">{title}</h2>
    </div>
  );
}
