# Backend API — Supplier Resolution Agent

Local, single trusted-user demo only. Do not deploy these routes publicly without
authentication, company scoping and RLS policies.

## Setup

```bash
cp .env.example .env.local   # fill NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
npm install
npm run check-setup          # verifies tables, private bucket, prints SR-001 caseId
npm run dev
npm run smoke                # end-to-end acceptance checks (needs dev server)
```

`AI_MODE=live` uses Gemini (`GEMINI_API_KEY`). An analyze call takes ~20–30 s.
`AI_MODE=mock` returns a fixed SR-001 fixture whose text fields start with
`[MOCK AI RESULT …]` — for offline endpoint testing only, not a live analysis.

## For Dev 1 (UI)

Base path: `/api`. All errors are JSON `{ "error": string, "code": string }`.
Use `caseId` (UUID) everywhere; `caseCode` (`SR-001`) is for display only.

| Route | Request | Success |
|---|---|---|
| `POST /api/analyze` | multipart: `po`, `invoice`, `grn` (PDF files), optional `caseId` (UUID; omitted → seeded SR-001) | `AnalyzeResponse` |
| `POST /api/revalidate` | multipart: `caseId` (UUID), `revisedInvoice` (PDF file) | `RevalidateResponse` |
| `GET /api/cases/{caseId}` | — | saved `AnalyzeResponse` fields + `resolvedDiscrepancies`, `documents`, `events` |

Seeded SR-001 caseId: `d7c7202a-537d-4b75-88cb-58d52753ac2e`.

Sample `AnalyzeResponse` (mock mode):

```json
{
  "caseId": "d7c7202a-537d-4b75-88cb-58d52753ac2e",
  "caseCode": "SR-001",
  "status": "DISCREPANCY_FOUND",
  "discrepancies": [{
    "issueType": "QUANTITY",
    "lineRef": "1",
    "orderedQty": 100, "invoicedQty": 100, "receivedQty": 80,
    "amountUnderReviewPaise": 1000000,
    "description": "…",
    "recommendedAction": "Request a revised invoice for 80 cartons.",
    "evidenceRefs": [
      { "docType": "PO", "documentNumber": "PO-1001", "field": "items[0].quantity" },
      { "docType": "INVOICE", "documentNumber": "INV-1001", "field": "items[0].quantity" },
      { "docType": "GRN", "documentNumber": "GRN-1001", "field": "items[0].quantity" }
    ]
  }],
  "investigationSummary": "…",
  "supplierMessageDraft": "…"
}
```

`RevalidateResponse.discrepancies` lists issues still **outstanding** after the
revision — an empty array with `READY_FOR_PAYMENT_APPROVAL` means resolved.

`GET /api/cases/{id}` puts the saved `AnalyzeResponse` fields at the top level (so
`AnalyzeResponse.parse` works on it; `discrepancies` = outstanding only), plus:
`resolvedDiscrepancies`, `poNumber`, `invoiceNumber`, `currency`, `createdAt`,
`updatedAt`, `documents[]` (`documentId, docType, version, documentNumber,
originalFilename, extractionStatus, extractionError, uploadedAt, extractedJson`) and
`events[]` (`eventId, eventType, actorType, note, payload, createdAt`). Storage
paths and file bytes are never returned.

### Error codes

| HTTP | code |
|---|---|
| 400 | `INVALID_CONTENT_TYPE`, `INVALID_FORM`, `MISSING_FILE`, `INVALID_FILE`, `EMPTY_FILE`, `INVALID_FILE_TYPE`, `INVALID_PDF`, `MISSING_CASE_ID`, `INVALID_CASE_ID` |
| 404 | `CASE_NOT_FOUND` |
| 409 | `CASE_NOT_READY` (revalidate before analyze), `VERSION_CONFLICT` |
| 413 | `FILE_TOO_LARGE` (>10 MB per file), `PAYLOAD_TOO_LARGE` |
| 422 | `AI_INVALID_OUTPUT` — case set to `NEEDS_REVIEW` |
| 502 | `AI_UPSTREAM_ERROR` — Gemini request failed — case set to `ERROR` |
| 504 | `AI_TIMEOUT` — case set to `NEEDS_REVIEW` |
| 500 | `STORAGE_ERROR`, `DB_ERROR`, `INTERNAL_ERROR` — case set to `ERROR` |

Every failure after the case is resolved writes an `ERROR` case event.

## AI module (`src/lib/ai`, Gemini)

| File | Role |
|---|---|
| `extract.ts` | Gemini reads one PDF into `ExtractedDocument` (structured JSON output). Prices are returned as printed text and converted to paise in code; GRN quantity = accepted qty. |
| `match.ts` | Deterministic three-way match — no model. Billable = min(ordered, accepted); QUANTITY = excess × min(invoice, PO price); PRICE = (invoice − PO price) × invoiced. Also flags PO-number / supplier mismatches and items not on the PO. |
| `draft.ts` | Gemini writes the summary and supplier email from the computed findings only (figures passed pre-formatted). |
| `index.ts` | Exports `analyzeDocuments` and `revalidateInvoice`. |

Checked against all five seed cases: SR-001 (20 ctn, ₹10,000), SR-002 (none),
SR-003 (price, ₹5,000) and the SR-001/SR-003 revisions (→ ready) match the expected
amounts. SR-004 / SR-005 get the correct ₹10,000 but are labelled `QUANTITY`; the
staged-delivery / conflicting-evidence nuance needs supplier-response documents the
MVP does not ingest.

Wiring lives in `src/lib/server/ai.ts`. Outputs are re-validated with Zod; anything
that fails becomes `422 AI_INVALID_OUTPUT` and the case goes to `NEEDS_REVIEW`.

All types are from `src/lib/contracts.ts` (`ExtractedDocument`, `Discrepancy`,
`CaseStatus`); amounts are integer paise.

```ts
analyzeDocuments({ poPdf, invoicePdf, grnPdf }: { [k]: Buffer })
  -> {
    extractedDocuments: { PO: ExtractedDocument, INVOICE: ExtractedDocument, GRN: ExtractedDocument },
    discrepancies: Discrepancy[],
    investigationSummary: string,
    supplierMessageDraft: string | null,
  }

revalidateInvoice({ originalDocuments: { PO, INVOICE, GRN }: ExtractedDocument, revisedInvoicePdf: Buffer })
  -> {
    extractedRevisedInvoice: ExtractedDocument,
    discrepancies: Discrepancy[],   // still OUTSTANDING; [] when the revision resolves the case
    explanation: string,
    status: CaseStatus,
  }
```

- Each `extractedDocuments[X].docType` must equal `X` (catches swapped uploads).
- Every `evidenceRefs[]` entry must cite `docType` + `documentNumber` of a document
  on the case (`PO`, `INVOICE`, `GRN`, plus `REVISED_INVOICE` on revalidate) using the
  number you extracted. Otherwise → `AI_INVALID_OUTPUT`.
- `originalDocuments` is the `ExtractedDocument` you returned at analysis time.
- Status guard: `READY_FOR_PAYMENT_APPROVAL` is only accepted with an empty
  `discrepancies` array; allowed revalidation statuses are `READY_FOR_PAYMENT_APPROVAL`,
  `DISCREPANCY_FOUND`, `AWAITING_SUPPLIER`, `NEEDS_REVIEW` — anything else becomes
  `NEEDS_REVIEW`. It is a case status, not a payment approval or payout.

## Persistence behaviour

- PDFs go to private bucket `supplier-docs` at `caseId/docType/vN-<uuid>.pdf`;
  the version is the next integer per (case, docType). Originals are never overwritten.
- The revised invoice is stored as `REVISED_INVOICE`; the original `INVOICE` row stays.
- Re-running analyze replaces the case's discrepancy rows; history stays in `case_events`.
- On a successful revalidation, open discrepancy rows become `RESOLVED`; otherwise
  unresolved rows are replaced by the latest outstanding findings.
- Discrepancy rows keep an internal `status` and per-ref `documentId` in the DB;
  these are stripped from API responses to match the contract.

## curl

```bash
F=fixtures/sr-001
curl -s -F po=@$F/PO-1001.pdf\;type=application/pdf \
        -F invoice=@$F/INV-1001.pdf\;type=application/pdf \
        -F grn=@$F/GRN-1001.pdf\;type=application/pdf \
        localhost:3000/api/analyze | jq

curl -s -F caseId=<uuid> -F revisedInvoice=@$F/INV-1001-R1.pdf\;type=application/pdf \
        localhost:3000/api/revalidate | jq

curl -s localhost:3000/api/cases/<uuid> | jq
```
