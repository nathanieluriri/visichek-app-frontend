"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Plus,
  Edit2,
  Trash2,
  MoreHorizontal,
  Loader2,
} from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "@/components/recipes/page-header";
import { DataTable } from "@/components/recipes/data-table";
import { ConfirmDialog } from "@/components/recipes/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { toast } from "sonner";
import { formatDateTime } from "@/lib/utils/format-date";
import { useDataSubjectRequests } from "@/features/dsr/hooks/use-dsr";
import { GeofencingComplianceCard } from "@/features/dpo/components/geofencing-compliance-card";
import { useCapabilities } from "@/hooks/use-capabilities";
import { useNavigationLoading } from "@/lib/routing/navigation-context";
import { CAPABILITIES } from "@/lib/permissions/capabilities";
import type { DataSubjectRequest } from "@/types/dpo";
import type { DSRStatus } from "@/types/enums";

function statusVariant(status: DSRStatus) {
  switch (status) {
    case "pending":
      return "warning" as const;
    case "in_progress":
      return "info" as const;
    case "completed":
      return "success" as const;
    case "rejected":
      return "destructive" as const;
  }
}

const humanize = (value?: string | null) => (value ?? "").replace(/_/g, " ");
const requesterOf = (dsr: DataSubjectRequest) =>
  dsr.requesterName || dsr.visitorProfileSummary?.fullName || "Unknown requester";

export default function DPOPage() {
  const { hasCapability } = useCapabilities();
  const canCreate = hasCapability(CAPABILITIES.DSR_CREATE);
  const { loadingHref, handleNavClick } = useNavigationLoading();

  const { data, isLoading } = useDataSubjectRequests({ limit: 100, sort: "-dateCreated" });
  const requests = data?.items ?? [];

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [dsrToDelete, setDSRToDelete] = useState<DataSubjectRequest | undefined>();

  const handleDeleteClick = (dsr: DataSubjectRequest) => {
    setDSRToDelete(dsr);
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!dsrToDelete) return;
    try {
      // TODO: Implement delete mutation when API is available
      toast.success("Data subject request deleted successfully");
      setDeleteDialogOpen(false);
      setDSRToDelete(undefined);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to delete request"
      );
    }
  };

  const columns: ColumnDef<DataSubjectRequest>[] = [
    {
      accessorKey: "requesterName",
      header: "Requester",
      cell: ({ row }) => <span className="font-medium text-sm">{requesterOf(row.original)}</span>,
    },
    {
      accessorKey: "type",
      header: "Type",
      cell: ({ row }) => (
        <span className="text-sm capitalize">{humanize(row.original.requestType)}</span>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: ({ row }) => (
        <Badge variant={statusVariant(row.original.status)}>
          {humanize(row.original.status)}
        </Badge>
      ),
    },
    {
      id: "receivedAt",
      header: "Submitted",
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {formatDateTime(row.original.receivedAt ?? row.original.dateCreated ?? 0)}
        </span>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      cell: ({ row }) => (
        <RowActions
          dsr={row.original}
          onDelete={handleDeleteClick}
          loadingHref={loadingHref}
          handleNavClick={handleNavClick}
        />
      ),
      enableHiding: false,
    },
  ];

  const mobileCard = (dsr: DataSubjectRequest) => (
    <div className="rounded-lg border p-4 space-y-2">
      <div className="flex items-center justify-between">
        <span className="font-medium text-sm">{requesterOf(dsr)}</span>
        <Badge variant={statusVariant(dsr.status)}>
          {humanize(dsr.status)}
        </Badge>
      </div>
      <div className="text-sm text-muted-foreground capitalize">
        {humanize(dsr.requestType)}
      </div>
      <RowActions
        dsr={dsr}
        onDelete={handleDeleteClick}
        loadingHref={loadingHref}
        handleNavClick={handleNavClick}
      />
    </div>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Data Protection"
        description="Data subject requests, retention policies, and compliance"
        actions={
          canCreate ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button asChild className="w-full md:w-auto min-h-[44px]">
                  <Link
                    href="/app/dpo/requests/new"
                    onClick={() => handleNavClick("/app/dpo/requests/new")}
                  >
                    {loadingHref === "/app/dpo/requests/new" ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
                    )}
                    New Request
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                Open the new data subject request form
              </TooltipContent>
            </Tooltip>
          ) : undefined
        }
      />

      {/* Quick links */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card className="cursor-pointer hover:bg-accent/50 transition-colors">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">
              Retention Policies
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Manage data retention rules
            </p>
          </CardContent>
        </Card>
        <Card className="cursor-pointer hover:bg-accent/50 transition-colors">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">
              Sub-Processors
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Track third-party processors
            </p>
          </CardContent>
        </Card>
        <Card className="cursor-pointer hover:bg-accent/50 transition-colors">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">
              Privacy Notices
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Manage consent notices
            </p>
          </CardContent>
        </Card>
      </div>

      <GeofencingComplianceCard />

      <DataTable
        columns={columns}
        data={requests}
        isLoading={isLoading}
        pagination={true}
        pageSize={10}
        emptyTitle="No data subject requests"
        emptyDescription="Requests from data subjects will appear here."
        mobileCard={mobileCard}
      />

      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title="Delete Data Subject Request"
        description={`Are you sure you want to delete the request from "${dsrToDelete ? requesterOf(dsrToDelete) : ""}"? This action cannot be undone.`}
        confirmLabel="Delete"
        variant="destructive"
        isLoading={false}
        onConfirm={handleDeleteConfirm}
      />
    </div>
  );
}

function RowActions({
  dsr,
  onDelete,
  loadingHref,
  handleNavClick,
}: {
  dsr: DataSubjectRequest;
  onDelete: (d: DataSubjectRequest) => void;
  loadingHref: string | null;
  handleNavClick: (href: string) => void;
}) {
  const editHref = `/app/dpo/requests/${dsr.id}/edit`;
  const isLoadingEdit = loadingHref === editHref;
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
              <MoreHorizontal className="h-4 w-4" />
              <span className="sr-only">Actions</span>
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="left">
          Open actions for this data subject request
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <Link
            href={editHref}
            onClick={() => handleNavClick(editHref)}
            className="flex items-center"
          >
            {isLoadingEdit ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Edit2 className="mr-2 h-4 w-4" />
            )}
            Edit
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => onDelete(dsr)}
          className="text-destructive"
        >
          <Trash2 className="mr-2 h-4 w-4" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
