/**
 * DailyExportPage — ComboCurve 16-column daily export.
 * Separate from monthly by design — daily data is informational and never
 * aggregated back into the monthly file.
 */

import ExportPanel from '../components/ExportPanel';

export default function DailyExportPage() {
  return (
    <ExportPanel
      pageTitle="Daily Export"
      pageSubtitle="Download a ComboCurve-formatted Excel with daily production rows for the selected date range."
      inputType="date"
      apiPath="/api/export/daily"
      startPlaceholder="YYYY-MM-DD"
      endPlaceholder="YYYY-MM-DD"
      helpText={
        'Daily data is reference-only. One row per well per day. This export is kept SEPARATE from ' +
        'the monthly export per project rules — monthly numbers always come from the operator-provided ' +
        'monthly statements, never summed from daily entries.'
      }
    />
  );
}
