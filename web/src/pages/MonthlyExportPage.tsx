/**
 * MonthlyExportPage — ComboCurve 16-column monthly export.
 * Wraps the shared <ExportPanel /> with month-range inputs and
 * appends a <MonthlyProductionChart /> overview below the help
 * callout so the user has a quick visual sense of recent activity
 * before generating an export.
 */

import ExportPanel from '../components/ExportPanel';
import MonthlyProductionChart from '../components/MonthlyProductionChart';

export default function MonthlyExportPage() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <ExportPanel
        pageTitle="Monthly Export"
        pageSubtitle="Download a ComboCurve-formatted Excel with all monthly production rows in the selected range."
        inputType="month"
        apiPath="/api/export/monthly"
        startPlaceholder="YYYY-MM"
        endPlaceholder="YYYY-MM"
        helpText={
          'Monthly data comes from operator monthly production statements. One row per well per month. ' +
          'The output file matches the 16-column ComboCurve template exactly. Daily data is NEVER rolled up into monthly — ' +
          'if you want daily granularity, use the Daily Export page.'
        }
      />
      <MonthlyProductionChart monthsBack={24} />
    </div>
  );
}
