# Compliance checklist (for review before a client pilot)

**Status:** working draft for a legal/compliance reviewer. It is **not legal advice**. The regulatory points below come from
secondary sources (law-firm explainers and vendor blogs, linked at the end) and must be checked against the official TRAI
notifications and the Gazette text before anyone relies on them. Dates and details differ between sources and are marked.

## 1. What the product does today (verified in the code)

| Topic | Today |
|---|---|
| AI disclosure | The agent must say at the start that it is an AI assistant, and must answer honestly if asked. This is fixed text with no off switch; custom wording is allowed only if it still says it is an AI. |
| Audio | No call audio is stored. The `recording_url` column exists and is never written. |
| What is stored | The transcript (both sides, as text), an AI summary and qualification fields, call timings, and the lead's name and phone number. |
| Isolation | Every record belongs to one organization; every read and write is scoped to it. Tested. |
| Audit | Sensitive actions (for example call initiation, site-visit booking and changes to project knowledge) are written to an audit log. |
| Call limits | Per-organization concurrent-call, daily and monthly caps, maximum call length and silence timeout. |
| Opt-out | A caller who is "not interested" marks the lead `NOT_INTERESTED`. |

## 2. Gaps we know about (not built)

| Gap | Why it matters | Suggested handling |
|---|---|---|
| **No do-not-disturb (DND) / do-not-call check before an outbound call** | Outbound promotional calls to numbers on the national preference register are the core TRAI risk. A `DNC` lead status exists in the schema but nothing sets or enforces it. | Scrub numbers against the client's suppression list and the national register before dialling; a hard stop in the call-start path. |
| **No consent record per lead** | Consent rules (TRAI digital consent, DPDP) need proof of what the person agreed to, and when. | Store consent source, timestamp and wording on the lead; refuse to call without it for promotional calls. |
| **No retention or deletion job** | Transcripts and phone numbers are kept forever. | Per-client retention period with automatic deletion, and a delete-on-request path. |
| **No opt-out during the call that is honoured everywhere** | "Do not call me again" should suppress the number, not just change a status. | A suppression table checked on every call start. |
| **No support for declaring calling numbers** | Automated-call regulation (below) expects the calling number series to be declared. | Operational step with the telecom provider; record the declared series per organization. |
| **Calling-hours window not enforced** | Promotional calls have a permitted window; transactional calls are treated differently. | Enforce an allowed window per organization, in the organization's time zone. |

## 3. Regulatory points to confirm (from secondary sources)

### Automated and AI voice calls (TRAI)
- A 2026 amendment to the Telecom Commercial Communications Customer Preference Regulations is reported to require any business or
  platform placing **automated or pre-recorded voice calls** to declare its calling-line series to telecom providers and record
  them on the DLT platform. Undeclared automated traffic is reported to be treated as unsolicited, with termination charges.
  *Sources disagree on the notification date and the charge. Confirm against the Gazette.*
- Promotional calls use the **140 series**; service and transactional calls use the **1600 series**. Whether a given client
  call is promotional or transactional has to be defensible; transactional calls are exempt from the promotional time window.
- TRAI's digital consent management work (a 2025 pilot with the RBI) points to **explicit, recorded consent** for telemarketing.
- Enforcement is reported to escalate from warnings to disconnection of all telecom resources and blacklisting for repeated
  complaints. Treat complaint handling as an operational process, not an afterthought.

### Personal data (DPDP Act 2023 and Rules 2025)
- The Rules were notified in November 2025 and phase in: board and administrative rules first, **consent-manager rules around
  November 2026**, and the **substantive obligations around May 2027** (notice, consent, data-fiduciary duties, 72-hour
  breach reporting). *Sources differ by a day; confirm exact dates.*
- A recording or transcript of a call is personal data. No source found addresses call recording specifically; the general
  notice and consent obligations are expected to apply.
- Roles: the **client** is likely the data fiduciary and Sirah Digital a processor. **A lawyer should confirm this and the
  contract terms** (data-processing agreement, sub-processors such as Sarvam and the telephony provider, hosting location).

## 4. Questions for the reviewer
1. Which of our clients' calls are promotional and which transactional, and which number series does each need?
2. Is an AI voice call that qualifies a lead and books a visit a promotional call?
3. What is the minimum consent record we must hold per lead, and for how long?
4. Do we need to tell the caller that the call is processed by an AI vendor and that a transcript is kept?
5. Are Sarvam (speech and language models) and Exotel (telephony) sub-processors that need to be named, and does any
   data leave India? (Sarvam processes speech and text; confirm its data-handling terms.)
6. Do we need a grievance officer and a published privacy notice before the pilot?

## 5. Pre-pilot checklist

- [ ] Reviewer has read this document and answered section 4
- [ ] Calling numbers declared with the telecom provider (if outbound automated calls are used)
- [ ] DND / suppression check built and tested before any outbound call
- [ ] Consent captured and stored per lead
- [ ] Retention period agreed with the client and enforced
- [ ] Data-processing agreement signed with each client
- [ ] Privacy notice and grievance contact published
- [ ] Call script reviewed: AI disclosure first, no claims the data does not support

## Sources (secondary; verify against official text)
- [TRAI anti-spam rules and AI voice agents (CareerIndia)](https://www.careerindia.com/news/trai-anti-spam-rules-2026-compliance-guide-ai-voice-agents-startups-011-65835.html)
- [TRAI's crackdown on spam calls and AI-driven telemarketing (S.S. Rana)](https://ssrana.in/articles/trais-crackdown-on-spam-calls-and-ai-driven-telemarketing/)
- [TRAI anti-spam rules (IndiaLaw)](https://www.indialaw.in/blog/food/trai-anti-spam-rules/)
- [DPDP Rules 2025 overview (Conventus Law)](https://conventuslaw.com/featured-content/building-indias-digital-privacy-framework-an-overview-of-the-dpdp-rules-2025/)
- [DPDP Act brought into force (Hogan Lovells)](https://www.hoganlovells.com/en/publications/indias-digital-personal-data-protection-act-2023-brought-into-force-)
