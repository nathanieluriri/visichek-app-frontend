import type { DSRType, DSRStatus, DeletionAction, NoticeDisplayMode } from "./enums";

// ── Data Subject Requests ─────────────────────────────────────────────
/** A DSR as `GET /v1/dsr` returns it (camelCase of the backend's `DSROut`). */
export interface DataSubjectRequest {
  id: string;
  tenantId: string;
  visitorProfileId: string;
  requestType: DSRType;
  status: DSRStatus;
  requesterName?: string | null;
  requesterEmail?: string | null;
  notes?: string | null;
  slaDeadline?: number | null;
  receivedAt?: number | null;
  dateCreated?: number | null;
  resolvedAt?: number | null;
  visitorProfileSummary?: {
    id: string;
    fullName?: string | null;
    phone?: string | null;
    emailAddress?: string | null;
  } | null;
}

export interface CreateDSRRequest {
  visitorProfileId?: string;
  requesterName: string;
  requesterEmail?: string;
  requestType: DSRType;
  notes?: string;
}

// ── Retention Policies ────────────────────────────────────────────────
export interface RetentionPolicy {
  id: string;
  tenantId: string;
  dataType: string;
  retentionDays: number;
  action: DeletionAction;
  autoExecute: boolean;
  createdAt: number;
  updatedAt: number;
}

// ── Sub-Processors ────────────────────────────────────────────────────
export interface SubProcessor {
  id: string;
  tenantId: string;
  name: string;
  purpose?: string;
  dataCategories?: string;
  country?: string;
  createdAt: number;
  updatedAt: number;
}

// ── Privacy Notices ───────────────────────────────────────────────────
export interface PrivacyNotice {
  id: string;
  tenantId: string;
  title: string;
  summary?: string;
  fullText?: string;
  displayMode: NoticeDisplayMode;
  isActive: boolean;
  effectiveDate?: number;
  createdAt: number;
  updatedAt: number;
}

// ── Compliance Register ───────────────────────────────────────────────
export interface ComplianceRegisterEntry {
  id: string;
  tenantId: string;
  processingActivity: string;
  purpose: string;
  lawfulBasis: string;
  dataCategories?: string;
  createdAt: number;
}
