"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiPatch } from "@/lib/api/request";
import { apiGetList } from "@/lib/api/list";
import { bulkAction } from "@/lib/api/bulk";
import type {
  DataSubjectRequest,
  CreateDSRRequest,
} from "@/types/dpo";
import type { ListResponse, BulkJobResult } from "@/types/list";

interface UseDataSubjectRequestsParams {
  status?: string;
  type?: string;
  slaState?: string;
  q?: string;
  sort?: string;
  facets?: string;
  createdAtGte?: number;
  createdAtLte?: number;
  skip?: number;
  limit?: number;
}

interface UpdateDSRRequest {
  status?: string;
  notes?: string;
}

/**
 * Fetch the paginated DSR list per tables.txt §2.7. Returns the new
 * `{ items, meta }` envelope.
 */
export function useDataSubjectRequests(
  params?: UseDataSubjectRequestsParams
) {
  return useQuery<ListResponse<DataSubjectRequest>>({
    queryKey: ["dsr", params],
    queryFn: () =>
      apiGetList<DataSubjectRequest>(
        "/dsr",
        params as Record<string, unknown> | undefined,
      ),
  });
}

/**
 * Fetch a single data subject request by ID
 */
export function useDataSubjectRequest(dsrId: string) {
  return useQuery<DataSubjectRequest>({
    queryKey: ["dsr", dsrId],
    queryFn: () => apiGet<DataSubjectRequest>(`/dsr/${dsrId}`),
    enabled: !!dsrId,
  });
}

/**
 * Create a new data subject request
 */
export function useCreateDSR() {
  const queryClient = useQueryClient();

  return useMutation<DataSubjectRequest, Error, CreateDSRRequest>({
    mutationFn: (data) => apiPost<DataSubjectRequest>("/dsr", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["dsr"] });
    },
  });
}

/**
 * Update an existing data subject request
 */
export function useUpdateDSR(dsrId: string) {
  const queryClient = useQueryClient();

  return useMutation<DataSubjectRequest, Error, UpdateDSRRequest>({
    mutationFn: (data) =>
      apiPatch<DataSubjectRequest>(`/dsr/${dsrId}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["dsr", dsrId] });
      queryClient.invalidateQueries({ queryKey: ["dsr"] });
    },
  });
}

/**
 * Acknowledge / complete / reject a DSR per tables.txt §2.7.
 */
export function useAcknowledgeDSR() {
  const queryClient = useQueryClient();
  return useMutation<DataSubjectRequest, Error, string>({
    mutationFn: (dsrId) =>
      apiPost<DataSubjectRequest>(`/dsr/${dsrId}/acknowledge`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["dsr"] });
    },
  });
}

export function useCompleteDSR() {
  const queryClient = useQueryClient();
  return useMutation<
    DataSubjectRequest,
    Error,
    { dsrId: string; resolution?: string }
  >({
    mutationFn: ({ dsrId, resolution }) =>
      apiPost<DataSubjectRequest>(
        `/dsr/${dsrId}/complete`,
        resolution ? { resolution } : {},
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["dsr"] });
    },
  });
}

export function useRejectDSR() {
  const queryClient = useQueryClient();
  return useMutation<
    DataSubjectRequest,
    Error,
    { dsrId: string; reason?: string }
  >({
    mutationFn: ({ dsrId, reason }) =>
      apiPost<DataSubjectRequest>(
        `/dsr/${dsrId}/reject`,
        reason ? { reason } : {},
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["dsr"] });
    },
  });
}

/**
 * Bulk acknowledge / reject DSRs per tables.txt §2.7.
 */
export function useBulkDSRAction(action: "acknowledge" | "reject") {
  const queryClient = useQueryClient();
  return useMutation<
    BulkJobResult,
    Error,
    { ids: string[]; reason?: string; atomic?: boolean }
  >({
    mutationFn: ({ ids, reason, atomic }) =>
      bulkAction(`/dsr/bulk/${action}`, ids, {
        atomic,
        extras: action === "reject" && reason ? { reason } : undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["dsr"] });
    },
  });
}
