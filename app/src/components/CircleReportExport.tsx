"use client";

import { useState } from "react";
import type { CircleDetailData } from "@/lib/circleTypes";
import { exportCircleReport, downloadCircleReportHtml, downloadCircleReportText } from "@/lib/circleReport";
import { ACTIVE_NETWORK_LABEL } from "@/lib/config";
import { shortAddress } from "@/lib/config";
import { CopyControl } from "@/components/CopyControl";

export interface CircleReportExportProps {
  /** Circle detail data to export */
  data: CircleDetailData;
  /** Circle contract address */
  circleAddress: string;
}

/**
 * UI controls for exporting a circle report.
 *
 * Offers two formats:
 * - Print-friendly HTML (can be printed to PDF from browser)
 * - Plain text (for copy-paste or email)
 *
 * Reports include generation time, indexer freshness, and a data advisory.
 */
export function CircleReportExport({ data, circleAddress }: CircleReportExportProps) {
  const [exporting, setExporting] = useState(false);
  const [format, setFormat] = useState<"html" | "text">("html");

  async function handleExport(exportFormat: "html" | "text") {
    setExporting(true);
    try {
      const report = exportCircleReport(
        data,
        circleAddress,
        ACTIVE_NETWORK_LABEL,
        exportFormat,
      );

      if (exportFormat === "html") {
        downloadCircleReportHtml(report, circleAddress);
      } else {
        downloadCircleReportText(report, circleAddress);
      }
    } catch (err) {
      console.error("Export failed:", err);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <label className="text-sm font-medium text-slate-700 block mb-2">
          Report Format
        </label>
        <div className="flex gap-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              value="html"
              checked={format === "html"}
              onChange={(e) => setFormat(e.target.value as "html" | "text")}
              disabled={exporting}
              className="w-4 h-4"
            />
            <span className="text-sm text-slate-700">HTML (Print-friendly)</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              value="text"
              checked={format === "text"}
              onChange={(e) => setFormat(e.target.value as "html" | "text")}
              disabled={exporting}
              className="w-4 h-4"
            />
            <span className="text-sm text-slate-700">Plain Text</span>
          </label>
        </div>
      </div>

      <button
        type="button"
        onClick={() => handleExport(format)}
        disabled={exporting}
        className={`w-full px-4 py-2 rounded-lg font-medium text-sm transition-colors ${
          exporting
            ? "bg-slate-100 text-slate-400 cursor-not-allowed"
            : "bg-slate-800 text-white hover:bg-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-600 focus-visible:ring-offset-2"
        }`}
      >
        {exporting ? "Downloading…" : `Download ${format === "html" ? "HTML" : "Text"} Report`}
      </button>

      <CopyControl
        value={circleAddress}
        label="Copy circle address"
        copiedMessage="Circle address copied to clipboard"
        unavailableMessage="Clipboard unavailable — select the address below to copy manually"
        failedMessage="Copy failed — select the address below to copy manually"
      />

      <p className="text-xs text-slate-500">
        📄 Reports include members, contribution history, and circle status. 
        No wallet secrets or signing data is included.
      </p>
    </div>
  );
}
