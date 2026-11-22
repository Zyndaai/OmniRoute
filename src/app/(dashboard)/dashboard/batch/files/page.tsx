import { useState, useCallback } from "react";
import { useTranslations } from "use-intl";
import { useLoaderData, useRevalidator } from "react-router";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import Button from "@/shared/components/Button";
import FilesListTab from "../FilesListTab";
import FilesConceptCard from "../components/FilesConceptCard";
import UploadFileModal from "../components/UploadFileModal";
import { mapFileApiToRecord, mapBatchApiToRecord } from "../batch-utils";
import type { FileRecord } from "@/lib/db/files";
import type { BatchRecord } from "@/lib/db/batches";

/** Both reads are optional, as before: a failing one leaves its list empty. */
export async function loader() {
  const [filesBody, batchesBody] = await Promise.all([
    apiJsonOrNull<{ data?: unknown[]; total_count?: number }>("/api/v1/files", {
      query: { limit: 20 },
    }),
    apiJsonOrNull<{ data?: unknown[] }>("/api/v1/batches", { query: { limit: 20 } }),
  ]);
  return {
    files: (filesBody?.data || []).map(mapFileApiToRecord) as FileRecord[],
    filesTotal: filesBody?.total_count || 0,
    batches: (batchesBody?.data || []).map(mapBatchApiToRecord) as BatchRecord[],
  };
}

export default function BatchFilesPage() {
  const t = useTranslations("common");
  const revalidator = useRevalidator();
  const { files, filesTotal, batches } = useLoaderData<typeof loader>();
  const loading = revalidator.state !== "idle";
  const [showUpload, setShowUpload] = useState(false);

  const fetchAll = useCallback(async () => {
    await revalidator.revalidate();
  }, [revalidator]);

  return (
    <div className="flex flex-col gap-6">
      <FilesConceptCard />
      <div className="flex justify-end">
        <Button icon="upload" onClick={() => setShowUpload(true)}>
          {t("filesListUploadButton")}
        </Button>
      </div>
      <FilesListTab
        files={files}
        filesTotal={filesTotal}
        loading={loading}
        onRefresh={fetchAll}
        batches={batches}
      />
      {showUpload && (
        <UploadFileModal
          onClose={() => setShowUpload(false)}
          onUploaded={() => {
            setShowUpload(false);
            void fetchAll();
          }}
        />
      )}
    </div>
  );
}
