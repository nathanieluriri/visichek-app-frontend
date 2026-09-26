"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { ArrowLeft, Loader2 } from "lucide-react";
import { PageHeader } from "@/components/recipes/page-header";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { LoadingButton } from "@/components/feedback/loading-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { useNavigationLoading } from "@/lib/routing/navigation-context";
import {
  useCreateDSR,
  useUpdateDSR,
} from "@/features/dsr/hooks/use-dsr";
import type { DataSubjectRequest } from "@/types/dpo";
import { VisitorProfilePicker, type PickedVisitor } from "./visitor-profile-picker";
import type { DSRStatus, DSRType } from "@/types/enums";

const DSR_TYPES = [
  "access",
  "correction",
  "deletion",
  "consent_withdrawal",
] as const;

const DSR_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "rejected",
] as const;

const dsrSchema = z.object({
  visitorProfileId: z.string(),
  requesterName: z.string().trim().min(1, "Requester name is required"),
  requesterEmail: z
    .string()
    .trim()
    .email("Enter a valid email")
    .optional()
    .or(z.literal("")),
  type: z.enum(DSR_TYPES),
  description: z.string().optional(),
  status: z.enum(DSR_STATUSES),
});

// A field rule, not an object refine, so the message shows alongside the others.
const createSchema = dsrSchema.extend({
  visitorProfileId: z.string().min(1, "Choose the visitor this request is about"),
});

type DSRFormData = z.infer<typeof dsrSchema>;

const TYPE_LABELS: Record<(typeof DSR_TYPES)[number], string> = {
  access: "Right of Access",
  correction: "Right to Correction",
  deletion: "Right to Deletion",
  consent_withdrawal: "Consent Withdrawal",
};

const STATUS_LABELS: Record<(typeof DSR_STATUSES)[number], string> = {
  pending: "Pending",
  in_progress: "In Progress",
  completed: "Completed",
  rejected: "Rejected",
};

interface DSRFormProps {
  /** When set, the form is in edit mode. */
  dsr?: DataSubjectRequest;
}

export function DSRForm({ dsr }: DSRFormProps) {
  const router = useRouter();
  const { loadingHref, handleNavClick } = useNavigationLoading();
  const createMutation = useCreateDSR();
  const updateMutation = useUpdateDSR(dsr?.id ?? "");
  const isEditing = !!dsr;
  const [visitor, setVisitor] = useState<PickedVisitor | null>(null);

  const {
    register,
    handleSubmit,
    control,
    setValue,
    clearErrors,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<DSRFormData>({
    resolver: zodResolver(isEditing ? dsrSchema : createSchema),
    defaultValues: {
      visitorProfileId: dsr?.visitorProfileId ?? "",
      requesterName: dsr?.requesterName ?? dsr?.visitorProfileSummary?.fullName ?? "",
      requesterEmail: dsr?.requesterEmail ?? "",
      type: (dsr?.requestType as DSRType) ?? "access",
      description: dsr?.notes ?? "",
      status: (dsr?.status as DSRStatus) ?? "pending",
    },
  });

  // The backend files every DSR against a visitor profile, so a new request
  // needs one picked; the requester fields default to that visitor's details.
  const pickVisitor = (v: PickedVisitor | null) => {
    setVisitor(v);
    setValue("visitorProfileId", v?.id ?? "");
    if (!v) return;
    clearErrors("visitorProfileId");
    if (!getValues("requesterName")) setValue("requesterName", v.fullName, { shouldValidate: true });
    if (!getValues("requesterEmail") && v.email) setValue("requesterEmail", v.email, { shouldValidate: true });
  };

  const onSubmit = handleSubmit(async (data) => {
    try {
      if (isEditing && dsr) {
        await updateMutation.mutateAsync({
          status: data.status as DSRStatus,
          notes: data.description,
        });
        toast.success("Request updated");
      } else {
        await createMutation.mutateAsync({
          visitorProfileId: data.visitorProfileId,
          requesterName: data.requesterName,
          requesterEmail: data.requesterEmail || undefined,
          requestType: data.type as DSRType,
          notes: data.description,
        });
        toast.success("Request created");
      }
      router.push("/app/dpo");
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : `Failed to ${isEditing ? "update" : "create"} request`,
      );
    }
  });

  const submitting =
    isSubmitting || createMutation.isPending || updateMutation.isPending;

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div className="flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" asChild className="min-h-[44px]">
              <Link
                href="/app/dpo"
                onClick={() => handleNavClick("/app/dpo")}
              >
                {loadingHref === "/app/dpo" ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />
                )}
                Back to data protection
              </Link>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Return to the data protection workspace without saving
          </TooltipContent>
        </Tooltip>
      </div>

      <PageHeader
        title={isEditing ? "Edit data subject request" : "New data subject request"}
        description={
          isEditing
            ? "Update this request's status and notes."
            : "Register a new data subject request for triage."
        }
      />

      <form onSubmit={onSubmit} className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="visitorProfile">Visitor{isEditing ? "" : " *"}</Label>
          {isEditing ? (
            <p className="min-h-[44px] rounded-md border bg-muted/30 px-3 py-2.5 text-sm">
              {dsr?.visitorProfileSummary?.fullName || dsr?.requesterName || "Unknown visitor"}
            </p>
          ) : (
            <VisitorProfilePicker
              id="visitorProfile"
              value={visitor}
              onChange={pickVisitor}
              invalid={!!errors.visitorProfileId}
              describedBy={errors.visitorProfileId ? "error-visitorProfile" : undefined}
            />
          )}
          {errors.visitorProfileId && (
            <p id="error-visitorProfile" className="text-sm text-destructive" role="alert">
              {errors.visitorProfileId.message}
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="requesterName">Requester name *</Label>
          <Input
            id="requesterName"
            placeholder="Full name of data subject"
            {...register("requesterName")}
            aria-invalid={!!errors.requesterName}
            aria-describedby={
              errors.requesterName ? "error-requesterName" : undefined
            }
            className="min-h-[44px]"
            disabled={isEditing}
          />
          {errors.requesterName && (
            <p
              id="error-requesterName"
              className="text-sm text-destructive"
              role="alert"
            >
              {errors.requesterName.message}
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="requesterEmail">Requester email</Label>
          <Input
            id="requesterEmail"
            type="email"
            inputMode="email"
            placeholder="Email address (optional)"
            {...register("requesterEmail")}
            aria-invalid={!!errors.requesterEmail}
            aria-describedby={
              errors.requesterEmail ? "error-requesterEmail" : undefined
            }
            className="min-h-[44px]"
            disabled={isEditing}
          />
          {errors.requesterEmail && (
            <p
              id="error-requesterEmail"
              className="text-sm text-destructive"
              role="alert"
            >
              {errors.requesterEmail.message}
            </p>
          )}
        </div>

        {!isEditing && (
          <div className="space-y-2">
            <Label htmlFor="type">Request type *</Label>
            <Controller
              name="type"
              control={control}
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="type" className="min-h-[44px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DSR_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {TYPE_LABELS[t]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="description">Notes</Label>
          <textarea
            id="description"
            placeholder="Additional notes or details (optional)"
            className="flex min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-base md:text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            {...register("description")}
          />
        </div>

        {isEditing && (
          <div className="space-y-2">
            <Label htmlFor="status">Status</Label>
            <Controller
              name="status"
              control={control}
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="status" className="min-h-[44px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DSR_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {STATUS_LABELS[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>
        )}

        <div className="flex flex-col gap-2 pt-2 md:flex-row md:justify-end">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                asChild
                disabled={submitting}
                className="w-full min-h-[44px] md:w-auto"
              >
                <Link
                  href="/app/dpo"
                  onClick={() => handleNavClick("/app/dpo")}
                >
                  Cancel
                </Link>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              Discard this draft and return to the data protection workspace
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <LoadingButton
                  type="submit"
                  isLoading={submitting}
                  loadingText={isEditing ? "Saving…" : "Creating…"}
                  className="w-full md:w-auto"
                >
                  {isEditing ? "Save changes" : "Create request"}
                </LoadingButton>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">
              {isEditing
                ? "Save changes and return to the data protection workspace"
                : "Create this request and return to the data protection workspace"}
            </TooltipContent>
          </Tooltip>
        </div>
      </form>
    </div>
  );
}
