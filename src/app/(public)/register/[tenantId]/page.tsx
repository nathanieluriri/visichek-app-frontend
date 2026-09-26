"use client";

/**
 * Kiosk check-in flow (v2).
 *
 * Steps:
 *   1. Identity   — full_name (req), phone (req), email (opt)
 *   2. KYC option — "Verify with Dojah" or "Skip" (visible only when the
 *                   tenant's plan grants KYC, i.e. `idUploadEnabled` on
 *                   the public config)
 *   3. Details    — config-driven bio + tenant_specific fields, including
 *                   the `purpose_of_visit` enum picker, plus an optional
 *                   "additional notes" textarea
 *   4. Review     — final summary
 *   5. Post-submit — submit; switch on response.state:
 *        - pending_approval → wait-for-receptionist screen
 *        - pending_verification + intent="verify" → POST /v1/kyc/initiate, render
 *          the Dojah widget, and (on close) poll /kyc/status until the
 *          webhook resolves the verification
 *        - pending_verification + intent="skip" → POST /v1/kyc/skip, then wait
 *
 * The frontend never reads Dojah credentials from environment variables —
 * the widget config is provided whole by the backend on /kyc/initiate.
 */

import React, { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils/cn";
import {
  UserCheck,
  ShieldCheck,
  ClipboardList,
  CheckCircle2,
  AlertTriangle,
  Building2,
  Loader2,
  ArrowLeft,
  ArrowRight,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PhoneInput } from "@/components/ui/phone-input";
import { parsePhone } from "@/lib/constants/countries";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { LoadingButton } from "@/components/feedback/loading-button";
import { ErrorState } from "@/components/feedback/error-state";
import { StepIndicator, type StepDef } from "@/components/recipes/step-indicator";
import {
  useActiveCheckinConfigForTenant,
  useCheckinEnumsForTenant,
  useSubmitCheckin,
  useKycInitiate,
  useKycSkip,
  useKycStatus,
  RequiredFieldsForm,
  KycWidget,
  KycStatusScreen,
  describeCheckinError,
  checkinKeys,
} from "@/features/checkins";
import type { KycStatusScreenState } from "@/features/checkins";
import { ApiError } from "@/types/api";
import { usePublicTenantBranding } from "@/hooks/use-public-tenant-branding";
import { usePublicPrivacyNotice } from "@/features/public-registration/hooks";
import { PrivacyNoticeDisplay } from "@/features/public-registration/components";
import type { PublicPrivacyNotice } from "@/types/public";
import { requestUserLocation } from "@/lib/geolocation/user-location";
import type {
  CheckinOut,
  PurposeInfo,
  RequiredField,
} from "@/types/checkin";
import type { KycWidgetConfig } from "@/types/kyc";

// ── Constants ────────────────────────────────────────────────────────

/**
 * Field keys collected on the fixed Identity step. We render these as a
 * dedicated UI in step 1 and exclude them from the config-driven Details
 * form even if the tenant lists them in `requiredFields`.
 */
const IDENTITY_KEYS = new Set(["full_name", "phone", "email"]);

/** Field key reserved for the purpose-of-visit picker. */
const PURPOSE_KEY = "purpose";

const STEPS: StepDef[] = [
  { id: 1, label: "Identity", icon: UserCheck },
  { id: 2, label: "Verify", icon: ShieldCheck },
  { id: 3, label: "Details", icon: ClipboardList },
  { id: 4, label: "Review", icon: CheckCircle2 },
];

/** Step indicator without the Verify step (when KYC isn't available). */
const STEPS_NO_KYC: StepDef[] = [
  { id: 1, label: "Identity", icon: UserCheck },
  { id: 3, label: "Details", icon: ClipboardList },
  { id: 4, label: "Review", icon: CheckCircle2 },
];

// ── Validation helpers ──────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

function isValidInternationalPhone(value: string): boolean {
  const parsed = parsePhone(value);
  if (!parsed) return false;
  const digits = parsed.national.replace(/[^\d]/g, "");
  return digits.length >= 6 && digits.length <= 15;
}

// ── Types ────────────────────────────────────────────────────────────

type KycIntent = "verify" | "skip";

interface KioskState {
  fullName: string;
  phone: string;
  email: string;
  /** Set on step 2; null if KYC isn't available on this tenant. */
  kycIntent: KycIntent | null;
  /** Config-driven field values keyed by field.key. */
  fieldValues: Record<string, unknown>;
  /** Free-text notes attached to the structured `purpose` payload. */
  purposeDetails: string;
}

const INITIAL_STATE: KioskState = {
  fullName: "",
  phone: "",
  email: "",
  kycIntent: null,
  fieldValues: {},
  purposeDetails: "",
};

/**
 * Post-submit state machine. `idle` while collecting; transitions move
 * forward only — restart by reloading the kiosk.
 */
type KycPhase =
  | { kind: "idle" }
  | { kind: "submitting" }
  | {
      kind: "awaiting_approval";
      checkin: CheckinOut;
      /**
       * True when the visitor explicitly chose "Verify with Dojah" on
       * step 2 but the backend returned `state: "pending_approval"`
       * directly (the v2 doc's "silent degrade" path — plan doesn't
       * grant /v1/kyc/*). Drives an extra info note on the wait screen
       * so the visitor isn't left wondering why no widget opened.
       */
      kycSilentlySkipped?: boolean;
    }
  | { kind: "kyc_initiating"; checkin: CheckinOut }
  | { kind: "kyc_running"; checkin: CheckinOut; widgetConfig: KycWidgetConfig }
  | { kind: "kyc_polling"; checkin: CheckinOut }
  | { kind: "kyc_verifying"; checkin: CheckinOut }
  | { kind: "kyc_failed"; checkin: CheckinOut; reason?: string }
  | { kind: "kyc_skipping"; checkin: CheckinOut };

// ── Page ─────────────────────────────────────────────────────────────

export default function KioskCheckinPage() {
  const params = useParams();
  const tenantId = params.tenantId as string;

  const configQ = useActiveCheckinConfigForTenant(tenantId);
  const enumsQ = useCheckinEnumsForTenant(tenantId);

  const submitMutation = useSubmitCheckin({ configId: undefined, tenantId });
  const kycInitiateMutation = useKycInitiate();
  const kycSkipMutation = useKycSkip();
  const queryClient = useQueryClient();

  const [step, setStep] = useState(1);
  const [completed, setCompleted] = useState<number[]>([]);
  const [state, setState] = useState<KioskState>(INITIAL_STATE);
  const [stepError, setStepError] = useState<string | null>(null);
  const [phase, setPhase] = useState<KycPhase>({ kind: "idle" });
  const noticeQ = usePublicPrivacyNotice(tenantId);
  const notice = noticeQ.data ?? null;
  const consentRequired = notice?.displayMode === "active_consent";
  const [consented, setConsented] = useState(false);

  usePublicTenantBranding(tenantId);

  // ── Derived ──────────────────────────────────────────────────────

  const config = configQ.data;
  const enums = enumsQ.data;
  const kycAvailable = !!config?.idUploadEnabled;

  const detailsFields = useMemo<RequiredField[]>(() => {
    if (!config) return [];
    return config.requiredFields.filter((f) => !IDENTITY_KEYS.has(f.key));
  }, [config]);

  const visibleSteps = kycAvailable ? STEPS : STEPS_NO_KYC;

  // ── Step navigation ──────────────────────────────────────────────

  function nextStep(current: number): number {
    if (current === 1 && !kycAvailable) return 3;
    if (current === 2) return 3;
    if (current === 3) return 4;
    return current + 1;
  }
  function prevStep(current: number): number {
    if (current === 3 && !kycAvailable) return 1;
    if (current === 3) return 2;
    if (current === 4) return 3;
    return Math.max(1, current - 1);
  }

  function advance() {
    setCompleted((prev) => (prev.includes(step) ? prev : [...prev, step]));
    setStep(nextStep(step));
    setStepError(null);
  }
  function retreat() {
    setStep(prevStep(step));
    setStepError(null);
  }

  // ── Step 1: Identity ─────────────────────────────────────────────

  function handleIdentityNext() {
    setStepError(null);
    const fullName = state.fullName.trim();
    const phone = state.phone.trim();
    const email = state.email.trim();

    if (!fullName) {
      setStepError("Full name is required.");
      return;
    }
    if (!phone) {
      setStepError("Phone number is required.");
      return;
    }
    if (!isValidInternationalPhone(phone)) {
      setStepError("Please enter a valid phone number with a country code.");
      return;
    }
    if (email && !isValidEmail(email)) {
      setStepError("That email address doesn't look right.");
      return;
    }
    advance();
  }

  // ── Step 2: KYC option ───────────────────────────────────────────

  /**
   * Record the visitor's choice without advancing — the choice surfaces a
   * confirmation message and unlocks the explicit Continue button. We do
   * not auto-advance because both options would otherwise look identical
   * (instant jump to step 3) and the visitor can't tell their click landed.
   */
  function chooseIntent(intent: KycIntent) {
    setState((s) => ({ ...s, kycIntent: intent }));
    setStepError(null);
  }

  // ── Step 3: Details ──────────────────────────────────────────────

  function setFieldValue(key: string, value: unknown) {
    setState((s) => ({
      ...s,
      fieldValues: { ...s.fieldValues, [key]: value },
    }));
  }

  function handleDetailsNext() {
    setStepError(null);
    const missing: string[] = [];
    for (const field of detailsFields) {
      if (!field.required) continue;
      const v = state.fieldValues[field.key];
      if (v == null || (typeof v === "string" && v.trim() === "")) {
        missing.push(field.label);
      }
    }
    if (missing.length > 0) {
      setStepError(`Please fill in: ${missing.join(", ")}`);
      return;
    }
    advance();
  }

  // ── Step 4 + 5: Review and submit ────────────────────────────────

  /**
   * Build the multipart payload from state. The kiosk collects identity
   * fields on step 1 and merges them into `bio_data`; the structured
   * `purpose` field carries both the picker value and the notes.
   */
  function buildSubmitPayload(location: { lat: number; lng: number; accuracyM: number | null } | null) {
    const purposeValue =
      typeof state.fieldValues[PURPOSE_KEY] === "string"
        ? (state.fieldValues[PURPOSE_KEY] as string)
        : "";
    const purpose: PurposeInfo = {
      purpose: purposeValue.trim(),
      purposeDetails: state.purposeDetails.trim() || undefined,
    };

    const bioData: Record<string, unknown> = {
      full_name: state.fullName.trim(),
    };
    const tenantData: Record<string, unknown> = {};

    if (state.email.trim()) {
      bioData.email = state.email.trim();
    }

    for (const field of config?.requiredFields ?? []) {
      const v = state.fieldValues[field.key];
      if (v == null || v === "") continue;
      if (field.category === "bio") {
        if (IDENTITY_KEYS.has(field.key)) continue;
        bioData[field.key] = v;
      } else if (field.category === "tenant_specific") {
        tenantData[field.key] = v;
      }
    }

    return {
      email: state.email.trim() || undefined,
      phone: state.phone.trim(),
      purpose,
      bioData,
      tenantSpecificData: Object.keys(tenantData).length ? tenantData : undefined,
      visitorLat: location?.lat,
      visitorLng: location?.lng,
      visitorLocationAccuracyM: location?.accuracyM ?? undefined,
      ...(notice && {
        privacyNoticeId: notice.id,
        privacyNoticeVersionId: notice.versionId,
      }),
      ...(consentRequired &&
        consented && {
          consentGranted: true,
          consentMethod: "kiosk_checkbox",
          consentAcceptedAt: Math.floor(Date.now() / 1000),
        }),
    };
  }

  async function handleSubmit() {
    setStepError(null);
    if (consentRequired && !consented) {
      setStepError("Please accept the privacy notice to check in.");
      return;
    }
    setPhase({ kind: "submitting" });
    try {
      const location = await requestUserLocation();
      const payload = buildSubmitPayload(location);
      const checkin = await submitMutation.mutateAsync(payload);
      await routePostSubmit(checkin);
    } catch (err) {
      const info = describeCheckinError(err);
      setStepError(`${info.title}: ${info.message}`);
      setPhase({ kind: "idle" });
    }
  }

  /**
   * Branch on the submit response. `pending_approval` jumps straight to
   * the wait screen; `pending_verification` runs the KYC widget or the skip path
   * depending on what the visitor chose on step 2.
   */
  async function routePostSubmit(checkin: CheckinOut) {
    if (checkin.state !== "pending_verification") {
      // Silent-degrade detection: visitor opted in to verification but the
      // backend returned `pending_approval` anyway — typically because the
      // tenant's plan doesn't grant `/v1/kyc/*`. Surface this on the wait
      // screen so the visitor knows why no widget appeared.
      const kycSilentlySkipped = state.kycIntent === "verify";
      setPhase({ kind: "awaiting_approval", checkin, kycSilentlySkipped });
      return;
    }

    // KYC required by backend, but tenant didn't expose the option on the
    // public config. Default to verify so the visitor isn't stuck.
    const intent: KycIntent = state.kycIntent ?? "verify";

    if (intent === "skip") {
      await runKycSkip(checkin);
      return;
    }
    await runKycInitiate(checkin);
  }

  async function runKycInitiate(checkin: CheckinOut) {
    // Drop any cached `/kyc/status` payload from a prior attempt on the
    // same checkin — otherwise the polling useEffect could resolve the
    // new attempt against stale terminal data the moment we re-enable it.
    queryClient.removeQueries({ queryKey: checkinKeys.kycStatus(checkin.id) });
    setPhase({ kind: "kyc_initiating", checkin });
    try {
      const result = await kycInitiateMutation.mutateAsync(checkin.id);
      setPhase({
        kind: "kyc_running",
        checkin,
        widgetConfig: result.widgetConfig,
      });
    } catch (err) {
      // 402 FEATURE_DISABLED → KYC isn't on this plan; treat as skip-like
      // success so the kiosk can proceed to the wait screen.
      if (err instanceof ApiError && err.code === "FEATURE_DISABLED") {
        setPhase({
          kind: "awaiting_approval",
          checkin,
          kycSilentlySkipped: true,
        });
        return;
      }
      const info = describeCheckinError(err);
      setPhase({
        kind: "kyc_failed",
        checkin,
        reason: `${info.title}: ${info.message}`,
      });
    }
  }

  async function runKycSkip(checkin: CheckinOut) {
    setPhase({ kind: "kyc_skipping", checkin });
    try {
      await kycSkipMutation.mutateAsync({
        checkinId: checkin.id,
        reason: "visitor declined",
      });
      setPhase({ kind: "awaiting_approval", checkin });
    } catch (err) {
      // 403 FEATURE_DISABLED here means the tenant has kyc_required: true
      // and the visitor cannot skip — fall back to launching the widget.
      if (err instanceof ApiError && err.code === "FEATURE_DISABLED") {
        setState((s) => ({ ...s, kycIntent: "verify" }));
        await runKycInitiate(checkin);
        return;
      }
      const info = describeCheckinError(err);
      setPhase({
        kind: "kyc_failed",
        checkin,
        reason: `${info.title}: ${info.message}`,
      });
    }
  }

  // ── KYC widget event handling ────────────────────────────────────

  function onKycEvent(type: string) {
    if (phase.kind !== "kyc_running") return;
    if (type === "success") {
      setPhase({ kind: "kyc_verifying", checkin: phase.checkin });
    } else if (type === "error") {
      setPhase({
        kind: "kyc_failed",
        checkin: phase.checkin,
        reason: "The widget reported an error before finishing.",
      });
    } else if (type === "close") {
      setPhase({ kind: "kyc_polling", checkin: phase.checkin });
    }
    // 'loading' / 'begin' are visual-only.
  }

  // ── Status polling ───────────────────────────────────────────────

  const pollingCheckinId =
    phase.kind === "kyc_polling" || phase.kind === "kyc_verifying"
      ? phase.checkin.id
      : undefined;
  const statusQ = useKycStatus(pollingCheckinId, { enabled: !!pollingCheckinId });

  useEffect(() => {
    if (!statusQ.data) return;
    if (phase.kind !== "kyc_polling" && phase.kind !== "kyc_verifying") return;

    const status = statusQ.data.status;
    if (status === "ongoing") return;
    if (status === "success" || status === "skipped") {
      setPhase({ kind: "awaiting_approval", checkin: phase.checkin });
    } else if (status === "failed" || status === "expired") {
      setPhase({
        kind: "kyc_failed",
        checkin: phase.checkin,
        reason: statusQ.data.failureReason ?? undefined,
      });
    }
  }, [statusQ.data, phase]);

  function retryKyc() {
    if (phase.kind !== "kyc_failed") return;
    void runKycInitiate(phase.checkin);
  }

  // ── Gates ─────────────────────────────────────────────────────────

  if (configQ.isLoading) return <LoadingShell />;

  if (configQ.isError || !config) {
    const info = describeCheckinError(configQ.error);
    return (
      <div className="mx-auto max-w-xl p-4 mt-8">
        <ErrorState
          title={info.title}
          message={info.message}
          onRetry={() => configQ.refetch()}
        />
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────

  // Post-submit phases own the screen.
  if (phase.kind !== "idle" && phase.kind !== "submitting") {
    return (
      <KioskShell config={config}>
        <PostSubmitScreen
          phase={phase}
          tenantName={config.tenantName}
          onKycEvent={onKycEvent}
          onRetry={retryKyc}
          retrying={kycInitiateMutation.isPending}
          fullName={state.fullName}
          email={state.email}
        />
      </KioskShell>
    );
  }

  return (
    <KioskShell config={config}>
      <StepIndicator
        steps={visibleSteps}
        currentStep={step}
        completedSteps={completed}
      />

      <Card>
        <CardHeader>
          <CardTitle>{titleForStep(step, kycAvailable)}</CardTitle>
          <CardDescription>{descriptionForStep(step, kycAvailable)}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {step === 1 && (
            <IdentityStep
              state={state}
              setState={setState}
              onNext={handleIdentityNext}
              error={stepError}
            />
          )}

          {step === 2 && kycAvailable && (
            <KycOptionStep
              intent={state.kycIntent}
              onChoose={chooseIntent}
              onBack={retreat}
              onNext={advance}
            />
          )}

          {step === 3 && (
            <DetailsStep
              fields={detailsFields}
              enums={enumsQ.data}
              fieldValues={state.fieldValues}
              setFieldValue={setFieldValue}
              purposeDetails={state.purposeDetails}
              onPurposeDetailsChange={(v) =>
                setState((s) => ({ ...s, purposeDetails: v }))
              }
              onBack={retreat}
              onNext={handleDetailsNext}
              error={stepError}
            />
          )}

          {step === 4 && (
            <ReviewStep
              state={state}
              fields={detailsFields}
              enums={enums}
              kycAvailable={kycAvailable}
              onBack={retreat}
              onSubmit={handleSubmit}
              submitting={phase.kind === "submitting"}
              error={stepError}
              notice={notice}
              consentRequired={consentRequired}
              consented={consented}
              onConsentChange={setConsented}
            />
          )}
        </CardContent>
      </Card>
    </KioskShell>
  );
}

// ── Layout ───────────────────────────────────────────────────────────

function KioskShell({
  config,
  children,
}: {
  config: { tenantName: string; logoUrl?: string };
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-2xl p-4 md:p-6 space-y-6">
      <header className="flex items-center gap-3">
        {config.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={config.logoUrl}
            alt={`${config.tenantName} logo`}
            className="h-10 w-10 rounded object-contain"
          />
        ) : (
          <div className="h-10 w-10 rounded bg-muted flex items-center justify-center">
            <Building2
              className="h-5 w-5 text-muted-foreground"
              aria-hidden="true"
            />
          </div>
        )}
        <div className="min-w-0">
          <p className="font-display text-lg leading-tight truncate">
            {config.tenantName}
          </p>
          <p className="text-xs text-muted-foreground">Visitor check-in</p>
        </div>
      </header>
      {children}
    </div>
  );
}

function LoadingShell() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" />
        <p className="text-sm">Loading kiosk…</p>
      </div>
    </div>
  );
}

function titleForStep(step: number, kycAvailable: boolean): string {
  if (step === 1) return "Identity";
  if (step === 2 && kycAvailable) return "Verify your ID";
  if (step === 3) return "Details";
  if (step === 4) return "Review";
  return "";
}

function descriptionForStep(step: number, kycAvailable: boolean): string {
  if (step === 1)
    return "Tell us your name and how to reach you so we can find or create your visitor record.";
  if (step === 2 && kycAvailable)
    return "Verify your identity instantly with Dojah, or skip and a receptionist will verify you manually.";
  if (step === 3) return "A few more details about your visit.";
  if (step === 4) return "Please review and submit.";
  return "";
}

// ── Step 1: Identity ────────────────────────────────────────────────

function IdentityStep({
  state,
  setState,
  onNext,
  error,
}: {
  state: KioskState;
  setState: React.Dispatch<React.SetStateAction<KioskState>>;
  onNext: () => void;
  error: string | null;
}) {
  const [emailTouched, setEmailTouched] = useState(false);
  const emailTrimmed = state.email.trim();
  const showEmailFormatError =
    emailTouched && emailTrimmed.length > 0 && !isValidEmail(emailTrimmed);

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="kiosk-name" className="text-sm">
          Full name
          <span className="text-destructive ml-0.5" aria-hidden="true">*</span>
        </Label>
        <Input
          id="kiosk-name"
          type="text"
          autoComplete="name"
          value={state.fullName}
          onChange={(e) => setState((s) => ({ ...s, fullName: e.target.value }))}
          className="text-base md:text-sm min-h-[44px]"
          placeholder="Jane Doe"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="kiosk-phone" className="text-sm">
          Phone
          <span className="text-destructive ml-0.5" aria-hidden="true">*</span>
        </Label>
        <PhoneInput
          id="kiosk-phone"
          value={state.phone}
          onChange={(v) => setState((s) => ({ ...s, phone: v }))}
          placeholder="Phone number"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="kiosk-email" className="text-sm">
          Email <span className="text-muted-foreground">(optional)</span>
        </Label>
        <Input
          id="kiosk-email"
          type="email"
          inputMode="email"
          autoComplete="email"
          value={state.email}
          onChange={(e) => setState((s) => ({ ...s, email: e.target.value }))}
          onBlur={() => setEmailTouched(true)}
          aria-invalid={showEmailFormatError || undefined}
          aria-describedby={
            showEmailFormatError ? "kiosk-email-error" : undefined
          }
          className={cn(
            "text-base md:text-sm min-h-[44px]",
            showEmailFormatError &&
              "border-destructive focus-visible:ring-destructive",
          )}
          placeholder="you@example.com"
        />
        {showEmailFormatError && (
          <p
            id="kiosk-email-error"
            role="alert"
            className="text-xs text-destructive"
          >
            That doesn&apos;t look like a valid email address.
          </p>
        )}
      </div>

      {error && (
        <p
          role="alert"
          className="flex items-start gap-2 text-sm text-destructive"
        >
          <AlertTriangle
            className="h-4 w-4 mt-0.5 flex-shrink-0"
            aria-hidden="true"
          />
          <span>{error}</span>
        </p>
      )}

      <div className="flex justify-end">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button onClick={onNext}>
              Continue
              <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            Continue to the next step
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

// ── Step 2: KYC option ──────────────────────────────────────────────

function KycOptionStep({
  intent,
  onChoose,
  onBack,
  onNext,
}: {
  intent: KycIntent | null;
  onChoose: (intent: KycIntent) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm">
        Verifying your ID with Dojah lets the receptionist approve you faster.
        You can also skip and have your identity confirmed manually. Either
        way, you continue to the next step now — the verification widget
        opens after you submit on the Review step.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={intent === "verify" ? "default" : "outline"}
              onClick={() => onChoose("verify")}
              className={cn(
                "min-h-[88px] flex-col gap-2",
                intent === "verify" && "ring-2 ring-primary",
              )}
              aria-pressed={intent === "verify"}
            >
              <ShieldCheck className="h-6 w-6" aria-hidden="true" />
              Verify with Dojah
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Open the Dojah widget after submitting to verify your ID
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={intent === "skip" ? "default" : "outline"}
              onClick={() => onChoose("skip")}
              className={cn(
                "min-h-[88px] flex-col gap-2",
                intent === "skip" && "ring-2 ring-primary",
              )}
              aria-pressed={intent === "skip"}
            >
              <ClipboardList className="h-6 w-6" aria-hidden="true" />
              Skip for now
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Send your check-in without verifying — a receptionist will verify
            you manually
          </TooltipContent>
        </Tooltip>
      </div>

      {intent && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-lg border bg-muted/40 p-3 text-sm flex items-start gap-2"
        >
          {intent === "verify" ? (
            <>
              <ShieldCheck
                className="h-4 w-4 mt-0.5 flex-shrink-0 text-primary"
                aria-hidden="true"
              />
              <span>
                Got it. We&apos;ll open the Dojah verification widget right
                after you submit on the Review step.
              </span>
            </>
          ) : (
            <>
              <ClipboardList
                className="h-4 w-4 mt-0.5 flex-shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span>
                Got it. A receptionist will verify your identity manually
                after you submit.
              </span>
            </>
          )}
        </div>
      )}

      <div className="flex justify-between pt-2 border-t">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" onClick={onBack}>
              <ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />
              Back
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Edit your identity details</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button onClick={onNext} disabled={!intent}>
                Continue
                <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">
            {intent
              ? "Continue to add your visit details"
              : "Pick verify or skip first"}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

// ── Step 3: Details ─────────────────────────────────────────────────

function DetailsStep({
  fields,
  enums,
  fieldValues,
  setFieldValue,
  purposeDetails,
  onPurposeDetailsChange,
  onBack,
  onNext,
  error,
}: {
  fields: RequiredField[];
  enums: ReturnType<typeof useCheckinEnumsForTenant>["data"];
  fieldValues: Record<string, unknown>;
  setFieldValue: (key: string, value: unknown) => void;
  purposeDetails: string;
  onPurposeDetailsChange: (value: string) => void;
  onBack: () => void;
  onNext: () => void;
  error: string | null;
}) {
  return (
    <div className="space-y-6">
      {fields.length > 0 && (
        <RequiredFieldsForm
          fields={fields}
          values={fieldValues}
          onChange={setFieldValue}
          enums={enums}
        />
      )}

      <section className="space-y-3">
        <h3 className="text-sm font-medium">Anything else?</h3>
        <div className="space-y-1.5">
          <Label htmlFor="kiosk-purpose-details" className="text-sm">
            Notes for the receptionist (optional)
          </Label>
          <Textarea
            id="kiosk-purpose-details"
            value={purposeDetails}
            onChange={(e) => onPurposeDetailsChange(e.target.value)}
            className="text-base md:text-sm min-h-[80px]"
            placeholder="Anything the receptionist should know"
          />
        </div>
      </section>

      {error && (
        <p
          role="alert"
          className="flex items-start gap-2 text-sm text-destructive"
        >
          <AlertTriangle
            className="h-4 w-4 mt-0.5 flex-shrink-0"
            aria-hidden="true"
          />
          <span>{error}</span>
        </p>
      )}

      <div className="flex justify-between pt-2 border-t">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" onClick={onBack}>
              <ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />
              Back
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Return to the previous step</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button onClick={onNext}>
              Review
              <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            Review your answers before submitting
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

// ── Step 4: Review ──────────────────────────────────────────────────

function ReviewStep({
  state,
  fields,
  enums,
  kycAvailable,
  onBack,
  onSubmit,
  submitting,
  error,
  notice,
  consentRequired,
  consented,
  onConsentChange,
}: {
  state: KioskState;
  fields: RequiredField[];
  enums: ReturnType<typeof useCheckinEnumsForTenant>["data"];
  kycAvailable: boolean;
  onBack: () => void;
  onSubmit: () => void;
  submitting: boolean;
  error: string | null;
  notice: PublicPrivacyNotice | null;
  consentRequired: boolean;
  consented: boolean;
  onConsentChange: (value: boolean) => void;
}) {
  return (
    <div className="space-y-4">
      <dl className="space-y-2 text-sm">
        <ReviewItem label="Name" value={state.fullName} />
        <ReviewItem label="Phone" value={state.phone} />
        {state.email && <ReviewItem label="Email" value={state.email} />}
        {kycAvailable && (
          <ReviewItem
            label="Verification"
            value={
              state.kycIntent === "verify"
                ? "Will verify with Dojah after submit"
                : state.kycIntent === "skip"
                  ? "Skipping — a receptionist will verify manually"
                  : "Not chosen"
            }
          />
        )}
        {fields.map((f) => {
          const v = state.fieldValues[f.key];
          if (v == null || v === "") return null;
          return (
            <ReviewItem
              key={f.key}
              label={f.label}
              value={renderReviewValue(f, v, enums)}
            />
          );
        })}
        {state.purposeDetails && (
          <ReviewItem label="Notes" value={state.purposeDetails} />
        )}
      </dl>

      <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
        Your check-in will be sent for receptionist approval. If you chose
        to verify, the verification widget opens right after you submit.
      </div>

      {notice && <PrivacyNoticeDisplay notice={notice} />}
      {consentRequired && (
        <div className="flex items-start gap-3">
          <Checkbox
            id="kiosk-consent"
            checked={consented}
            onCheckedChange={(v) => onConsentChange(v === true)}
            className="mt-0.5"
          />
          <Label htmlFor="kiosk-consent" className="text-sm font-normal leading-snug">
            I have read the privacy notice and agree to my details being
            processed for this visit.
          </Label>
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="flex items-start gap-2 text-sm text-destructive"
        >
          <AlertTriangle
            className="h-4 w-4 mt-0.5 flex-shrink-0"
            aria-hidden="true"
          />
          <span>{error}</span>
        </p>
      )}

      <div className="flex justify-between pt-2 border-t">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" onClick={onBack} disabled={submitting}>
              <ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />
              Back
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Make edits before submitting</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <LoadingButton
                onClick={onSubmit}
                isLoading={submitting}
                loadingText="Submitting…"
                disabled={consentRequired && !consented}
              >
                Submit check-in
              </LoadingButton>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">
            Send your check-in to the receptionist for approval
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

function ReviewItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 border-b border-border last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  );
}

/**
 * Resolve enum picker values back to their human label for the review
 * panel — `"meeting"` → `"Meeting"`. Falls back to the raw value when the
 * field isn't enum-driven or the option isn't found (custom values).
 */
function renderReviewValue(
  field: RequiredField,
  value: unknown,
  enums: ReturnType<typeof useCheckinEnumsForTenant>["data"],
): string {
  const raw = String(value ?? "");
  if (!field.enumKind) {
    return field.options?.find((o) => o.value === raw)?.label ?? raw;
  }
  if (!enums) return raw;
  const bundle = enums.enums[field.enumKind];
  const match = bundle?.options.find((o) => o.value === raw);
  return match?.label ?? raw;
}

// ── Step 5: Post-submit ─────────────────────────────────────────────

function PostSubmitScreen({
  phase,
  tenantName,
  onKycEvent,
  onRetry,
  retrying,
  fullName,
  email,
}: {
  phase: KycPhase;
  tenantName: string;
  onKycEvent: (type: string) => void;
  onRetry: () => void;
  retrying: boolean;
  fullName: string;
  email: string;
}) {
  const [first, ...rest] = fullName.trim().split(/\s+/);
  const userData = useMemo(
    () => ({
      first_name: first || undefined,
      last_name: rest.join(" ") || undefined,
      email: email.trim() || undefined,
    }),
    [first, rest, email],
  );

  if (phase.kind === "kyc_running") {
    return (
      <Card>
        <CardContent className="p-0 overflow-hidden">
          <KycWidget
            widgetConfig={phase.widgetConfig}
            userData={userData}
            onEvent={onKycEvent}
          />
        </CardContent>
      </Card>
    );
  }

  const screenState = mapPhaseToScreenState(phase);
  const note =
    phase.kind === "awaiting_approval" && phase.kycSilentlySkipped
      ? "Verification wasn't available right now, so we skipped it. The receptionist will verify your identity manually when they approve your check-in."
      : undefined;

  return (
    <Card>
      <CardContent className="pt-6">
        <KycStatusScreen
          state={screenState}
          tenantName={tenantName}
          message={
            phase.kind === "kyc_failed" ? phase.reason : undefined
          }
          note={note}
          onRetry={phase.kind === "kyc_failed" ? onRetry : undefined}
          retrying={retrying}
        />
      </CardContent>
    </Card>
  );
}

function mapPhaseToScreenState(phase: KycPhase): KycStatusScreenState {
  switch (phase.kind) {
    case "awaiting_approval":
      return "awaiting_approval";
    case "kyc_failed":
      return "failed";
    case "kyc_initiating":
    case "kyc_polling":
    case "kyc_verifying":
    case "kyc_skipping":
    default:
      return "verifying";
  }
}
