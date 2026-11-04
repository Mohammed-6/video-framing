"use client";

import { useRef, useState } from "react";
import { api, errorMessage, uploadToSignedUrl } from "@/lib/api";
import { formatBytes } from "@/lib/format";

type Accepted = "video/mp4" | "video/quicktime";

function contentTypeFor(file: File): Accepted | null {
  if (file.type === "video/mp4" || file.type === "video/quicktime") return file.type;
  const ext = file.name.toLowerCase().split(".").pop();
  if (ext === "mp4" || ext === "m4v") return "video/mp4";
  if (ext === "mov") return "video/quicktime";
  return null;
}

/** Secondary source: upload a local file; it then goes through the same automatic pipeline. */
export function UploadPanel({ onQueued }: { onQueued: () => void }) {
  const [state, setState] = useState<{ file?: File; progress?: number; error?: string; busy?: boolean }>({});
  const inputRef = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    const contentType = contentTypeFor(file);
    if (!contentType) return setState({ error: "Choose an MP4 or MOV file" });
    setState({ file, progress: 0, busy: true });
    try {
      const session = await api.createUpload({ fileName: file.name, contentType, fileSizeBytes: file.size });
      await uploadToSignedUrl(session.uploadUrl, session.uploadHeaders, file, (progress) => setState({ file, progress, busy: true }));
      await api.completeUpload(session.sourceVideoId, session.blobKey);
      await api.analyze(session.sourceVideoId);
      setState({});
      onQueued();
    } catch (e) {
      setState({ file, error: errorMessage(e) });
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <input
        ref={inputRef}
        type="file"
        accept="video/mp4,video/quicktime,.mp4,.mov,.m4v"
        className="hidden"
        onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
      />
      <button className="btn-secondary" disabled={state.busy} onClick={() => inputRef.current?.click()}>
        {state.busy ? "Uploading…" : "Upload a file"}
      </button>
      {state.busy && state.file && (
        <span className="text-sm text-zinc-400">
          {state.file.name} · {formatBytes(state.file.size)} · {Math.round((state.progress ?? 0) * 100)}%
        </span>
      )}
      {state.error && <span className="text-sm text-red-400">{state.error}</span>}
    </div>
  );
}
