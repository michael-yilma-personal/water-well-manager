import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';
import { Borehole, DrillingEvent, PipeRecord, ShiftLog } from '../types';
import { MIME_PDF, MIME_XLSX, saveReportFile } from './fileExport';

/**
 * jsPDF's own `doc.save()` uses a browser-only download path that does nothing
 * inside the Android WebView, so we pull the bytes out and route them through
 * `saveReportFile` instead. See `fileExport.ts` for the details.
 */
function pdfToBase64(doc: jsPDF): string {
  const dataUri = doc.output('datauristring');
  return dataUri.substring(dataUri.indexOf('base64,') + 'base64,'.length);
}

/**
 * Generate a professional Borehole Completion & Pipe Log PDF Report
 */
export async function generateBoreholePDF(
  borehole: Borehole,
  pipeRecords: PipeRecord[],
  events: DrillingEvent[],
  shiftLogs: ShiftLog[] = []
): Promise<void> {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  // Color theme: Deep Navy and Slate Gray
  const primaryColor: [number, number, number] = [15, 32, 67];
  const secondaryColor: [number, number, number] = [70, 80, 95];

  // Header banner
  doc.setFillColor(...primaryColor);
  doc.rect(0, 0, 210, 28, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text('WATER WELL DRILLING COMPLETION REPORT', 14, 13);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(`Project: ${borehole.project} | Borehole: ${borehole.name}`, 14, 21);

  // Metadata block
  doc.setTextColor(30, 41, 59);
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text('1. Borehole & Rig Specifications', 14, 38);

  const totalPipes = pipeRecords.length;
  const totalDepth = borehole.currentDepth;
  const totalSeconds = pipeRecords.reduce((acc, r) => acc + r.durationSeconds, 0);
  const avgPenRate =
    totalSeconds > 0 ? (totalDepth / (totalSeconds / 3600)).toFixed(2) : '0.00';
  const waterStrikeRecords = pipeRecords.filter((r) => r.waterStrike);
  const waterStrikeDepth =
    waterStrikeRecords.length > 0 ? `${waterStrikeRecords[0].endDepth} m` : 'None Recorded';

  autoTable(doc, {
    startY: 42,
    head: [['Parameter', 'Specification', 'Parameter', 'Specification']],
    body: [
      ['Borehole ID / Name', borehole.name, 'Client / Sponsor', borehole.client],
      ['Drilling Rig Name', borehole.rigName, 'Target Depth (m)', `${borehole.targetDepth} m`],
      ['Current Depth (m)', `${borehole.currentDepth} m`, 'Casing Depth (m)', `${borehole.casingInstalledDepth || 0} m`],
      ['Total Pipes Drilled', `${totalPipes}`, 'Avg Penetration Rate', `${avgPenRate} m/hr`],
      ['Water Strike Depth', waterStrikeDepth, 'Primary Bit Type', borehole.bitType],
      [
        'GPS Coordinates',
        `${borehole.gpsCoordinates.lat.toFixed(5)}, ${borehole.gpsCoordinates.lng.toFixed(5)}`,
        'Elevation (m)',
        `${borehole.gpsCoordinates.elevation || 0} m ASL`,
      ],
    ],
    theme: 'grid',
    headStyles: { fillColor: primaryColor, textColor: 255, fontStyle: 'bold', fontSize: 9 },
    bodyStyles: { fontSize: 8.5, textColor: [30, 41, 59] },
    styles: { cellPadding: 2.5 },
  });

  // Section 2: Lithology & Water Strike Summary
  const yAfterMeta = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 8;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('2. Geological Strata & Lithology Summary', 14, yAfterMeta);

  // Group strata
  const strataMap = new Map<string, { start: number; end: number; pipes: number; totalSpeed: number }>();
  pipeRecords.forEach((r) => {
    const existing = strataMap.get(r.formation);
    if (!existing) {
      strataMap.set(r.formation, {
        start: r.startDepth,
        end: r.endDepth,
        pipes: 1,
        totalSpeed: r.penetrationRate,
      });
    } else {
      existing.end = Math.max(existing.end, r.endDepth);
      existing.start = Math.min(existing.start, r.startDepth);
      existing.pipes++;
      existing.totalSpeed += r.penetrationRate;
    }
  });

  const strataRows = Array.from(strataMap.entries()).map(([formation, val]) => [
    `${val.start.toFixed(1)} m - ${val.end.toFixed(1)} m`,
    formation,
    `${(val.end - val.start).toFixed(1)} m`,
    val.pipes,
    `${(val.totalSpeed / val.pipes).toFixed(2)} m/hr`,
  ]);

  autoTable(doc, {
    startY: yAfterMeta + 4,
    head: [['Depth Interval', 'Geological Formation', 'Thickness', 'Pipes', 'Avg Speed (m/hr)']],
    body: strataRows.length > 0 ? strataRows : [['No lithology logged yet', '-', '-', '-', '-']],
    theme: 'striped',
    headStyles: { fillColor: secondaryColor, textColor: 255, fontStyle: 'bold', fontSize: 9 },
    bodyStyles: { fontSize: 8.5 },
    styles: { cellPadding: 2.5 },
  });

  // Section 3: Complete Pipe Log Table
  const yAfterLith = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 8;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('3. Complete Pipe-by-Pipe Drilling Log', 14, yAfterLith);

  const pipeRows = pipeRecords.map((r) => [
    `#${r.pipeNumber}`,
    `${r.startDepth.toFixed(1)} - ${r.endDepth.toFixed(1)}m`,
    `${r.pipeLength.toFixed(2)}m`,
    `${Math.round(r.durationSeconds / 60)} min`,
    `${r.penetrationRate.toFixed(1)}`,
    r.formation,
    r.waterStrike ? 'YES (Strike)' : 'No',
    r.operator,
  ]);

  autoTable(doc, {
    startY: yAfterLith + 4,
    head: [['Pipe #', 'Depth Range', 'Length', 'Duration', 'Rate (m/hr)', 'Formation', 'Water Strike', 'Driller']],
    body: pipeRows.length > 0 ? pipeRows : [['-', 'No pipes logged yet', '-', '-', '-', '-', '-', '-']],
    theme: 'grid',
    headStyles: { fillColor: primaryColor, textColor: 255, fontStyle: 'bold', fontSize: 8.5 },
    bodyStyles: { fontSize: 8 },
    styles: { cellPadding: 2 },
  });

  // Section 4: NPT & Field Operations Events
  const yAfterPipes = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 8;

  // Add new page if close to bottom
  if (yAfterPipes > 240) {
    doc.addPage();
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text('4. Field Events & Non-Productive Time (NPT)', 14, 20);
  } else {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text('4. Field Events & Non-Productive Time (NPT)', 14, yAfterPipes);
  }

  const eventRows = events.map((ev) => [
    new Date(ev.timestamp).toLocaleDateString() + ' ' + new Date(ev.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    ev.type,
    `${ev.depthAtEvent.toFixed(1)} m`,
    ev.durationMinutes ? `${ev.durationMinutes} min` : '-',
    ev.isNPT ? 'NPT' : 'Operation',
    ev.title,
    ev.operator,
  ]);

  const eventStartY = yAfterPipes > 240 ? 24 : yAfterPipes + 4;
  autoTable(doc, {
    startY: eventStartY,
    head: [['Time', 'Event Type', 'Depth', 'Duration', 'Category', 'Description / Title', 'Operator']],
    body: eventRows.length > 0 ? eventRows : [['-', 'No events logged', '-', '-', '-', '-', '-']],
    theme: 'striped',
    headStyles: { fillColor: secondaryColor, textColor: 255, fontStyle: 'bold', fontSize: 8.5 },
    bodyStyles: { fontSize: 8 },
    styles: { cellPadding: 2 },
  });

  // Footer on all pages
  const totalPages = doc.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(120, 140, 160);
    doc.text(
      `Water Well Drilling Management - ${borehole.name} | Page ${i} of ${totalPages} | Generated: ${new Date().toLocaleString()}`,
      14,
      288
    );
  }

  // Save PDF
  const filename = `${borehole.name.replace(/[^a-zA-Z0-9-_]/g, '_')}_Completion_Report.pdf`;
  await saveReportFile(pdfToBase64(doc), filename, MIME_PDF);
}

/**
 * Generate a concise Shift PDF Report
 */
export async function generateShiftPDF(
  shiftLog: ShiftLog,
  borehole: Borehole,
  pipesInShift: PipeRecord[],
  eventsInShift: DrillingEvent[]
): Promise<void> {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const primaryColor: [number, number, number] = [15, 32, 67];

  doc.setFillColor(...primaryColor);
  doc.rect(0, 0, 210, 25, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text('WATER WELL DRILLING SHIFT REPORT', 14, 12);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(`Shift Date: ${shiftLog.date} | ${shiftLog.shiftName}`, 14, 19);

  doc.setTextColor(30, 41, 59);
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text('1. Shift Performance Summary', 14, 36);

  autoTable(doc, {
    startY: 40,
    head: [['Metric', 'Value', 'Metric', 'Value']],
    body: [
      ['Borehole', borehole.name, 'Rig Name', borehole.rigName],
      ['Driller on Duty', shiftLog.drillerName, 'Supervisor', shiftLog.supervisorName],
      ['Start Depth', `${shiftLog.startDepth} m`, 'End Depth', `${shiftLog.endDepth} m`],
      ['Meters Drilled Today', `${shiftLog.metersDrilledToday} m`, 'Fuel Used', `${shiftLog.fuelUsedLiters} Liters`],
      ['Productive Hours', `${shiftLog.productiveHours} hrs`, 'NPT Hours', `${shiftLog.nonProductiveHours} hrs`],
      ['Shift Notes', shiftLog.notes || 'Normal drilling operations.', '', ''],
    ],
    theme: 'grid',
    headStyles: { fillColor: primaryColor, textColor: 255 },
    bodyStyles: { fontSize: 9 },
  });

  const yAfterMeta = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 10;
  doc.setFont('helvetica', 'bold');
  doc.text('2. Pipes Drilled During This Shift', 14, yAfterMeta);

  const pipeRows = pipesInShift.map((r) => [
    `#${r.pipeNumber}`,
    `${r.startDepth.toFixed(1)} - ${r.endDepth.toFixed(1)}m`,
    `${r.pipeLength}m`,
    `${Math.round(r.durationSeconds / 60)} min`,
    `${r.penetrationRate.toFixed(1)} m/hr`,
    r.formation,
    r.waterStrike ? 'YES' : 'No',
  ]);

  autoTable(doc, {
    startY: yAfterMeta + 4,
    head: [['Pipe #', 'Depth Range', 'Length', 'Duration', 'Rate (m/hr)', 'Formation', 'Water Strike']],
    body: pipeRows.length > 0 ? pipeRows : [['-', 'No pipes logged in this shift', '-', '-', '-', '-', '-']],
    theme: 'striped',
    headStyles: { fillColor: primaryColor, textColor: 255, fontSize: 9 },
    bodyStyles: { fontSize: 8.5 },
  });

  await saveReportFile(
    pdfToBase64(doc),
    `Shift_Report_${shiftLog.date}_${borehole.name.replace(/[^a-zA-Z0-9-_]/g, '_')}.pdf`,
    MIME_PDF
  );
}

/**
 * Generate a multi-sheet Excel Workbook (.xlsx) with all borehole data, pipes, lithology, and events
 */
export async function generateExcelReport(
  borehole: Borehole,
  pipeRecords: PipeRecord[],
  events: DrillingEvent[],
  shiftLogs: ShiftLog[] = []
): Promise<void> {
  const wb = XLSX.utils.book_new();

  // Sheet 1: Borehole Summary
  const summaryData = [
    ['WATER WELL DRILLING MANAGEMENT - BOREHOLE SUMMARY'],
    ['Generated At', new Date().toLocaleString()],
    [],
    ['Borehole Name', borehole.name],
    ['Project', borehole.project],
    ['Client', borehole.client],
    ['Rig Name', borehole.rigName],
    ['Target Depth (m)', borehole.targetDepth],
    ['Current Depth (m)', borehole.currentDepth],
    ['Default Pipe Length (m)', borehole.defaultPipeLength],
    ['Primary Bit Type', borehole.bitType],
    ['Bit Diameter (in)', borehole.bitDiameter],
    ['GPS Coordinates', `${borehole.gpsCoordinates.lat}, ${borehole.gpsCoordinates.lng}`],
    ['Elevation ASL (m)', borehole.gpsCoordinates.elevation || 0],
    ['Status', borehole.status.toUpperCase()],
    ['Total Pipes Drilled', pipeRecords.length],
    [
      'Avg Penetration Rate (m/hr)',
      pipeRecords.length > 0
        ? (
            borehole.currentDepth /
            (pipeRecords.reduce((s, p) => s + p.durationSeconds, 0) / 3600 || 1)
          ).toFixed(2)
        : '0.00',
    ],
  ];
  const wsSummary = XLSX.utils.aoa_to_sheet(summaryData);
  XLSX.utils.book_append_sheet(wb, wsSummary, 'Borehole Summary');

  // Sheet 2: Pipe Log
  const pipeTable = pipeRecords.map((r) => ({
    'Pipe #': r.pipeNumber,
    'Start Depth (m)': r.startDepth,
    'End Depth (m)': r.endDepth,
    'Pipe Length (m)': r.pipeLength,
    'Start Time': new Date(r.startTime).toLocaleString(),
    'End Time': new Date(r.endTime).toLocaleString(),
    'Duration (min)': Math.round(r.durationSeconds / 60),
    'Penetration Rate (m/hr)': r.penetrationRate,
    'Geological Formation': r.formation,
    'Water Strike?': r.waterStrike ? 'YES' : 'No',
    'Water Strike Flow (L/min)': r.waterStrikeDetails?.flowRateLpm || '',
    'Static Water Level (m)': r.waterStrikeDetails?.staticWaterLevel || '',
    'Air Pressure (PSI)': r.airPressure,
    'Compressor Pressure (PSI)': r.compressorPressure,
    'Bit Type': r.bitType,
    'Bit Diameter': r.bitDiameter,
    Operator: r.operator,
    Remarks: r.remarks,
  }));
  const wsPipes = XLSX.utils.json_to_sheet(pipeTable);
  XLSX.utils.book_append_sheet(wb, wsPipes, 'Pipe Log');

  // Sheet 3: Events & NPT
  const eventTable = events.map((ev) => ({
    Timestamp: new Date(ev.timestamp).toLocaleString(),
    'Event Type': ev.type,
    Title: ev.title,
    'Depth at Event (m)': ev.depthAtEvent,
    'Duration (min)': ev.durationMinutes || 0,
    'NPT / Productive': ev.isNPT ? 'Non-Productive Time' : 'Operational',
    Operator: ev.operator,
    'Fuel Liters': ev.details.fuelLiters || '',
    'Water Strike L/min': ev.details.waterStrikeLpm || '',
    Notes: ev.details.notes || '',
  }));
  const wsEvents = XLSX.utils.json_to_sheet(eventTable);
  XLSX.utils.book_append_sheet(wb, wsEvents, 'Events & NPT');

  // Sheet 4: Shift Logs
  const shiftTable = shiftLogs.map((sh) => ({
    Date: sh.date,
    Shift: sh.shiftName,
    Driller: sh.drillerName,
    Supervisor: sh.supervisorName,
    'Start Depth (m)': sh.startDepth,
    'End Depth (m)': sh.endDepth,
    'Meters Drilled': sh.metersDrilledToday,
    'Productive Hours': sh.productiveHours,
    'NPT Hours': sh.nonProductiveHours,
    'Fuel Used (L)': sh.fuelUsedLiters,
    Notes: sh.notes,
  }));
  const wsShifts = XLSX.utils.json_to_sheet(shiftTable);
  XLSX.utils.book_append_sheet(wb, wsShifts, 'Shift Logs');

  // Save Workbook
  const filename = `${borehole.name.replace(/[^a-zA-Z0-9-_]/g, '_')}_Drilling_Data.xlsx`;
  const base64 = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
  await saveReportFile(base64, filename, MIME_XLSX);
}

/**
 * Convenience wrapper for generating shift report PDF directly from current records
 */
export function generateShiftReportPDF(
  borehole: Borehole,
  pipeRecords: PipeRecord[],
  events: DrillingEvent[]
): Promise<void> {
  return generateBoreholePDF(borehole, pipeRecords, events);
}

/**
 * Convenience wrapper for generating Excel report
 */
export function generateBoreholeExcelReport(
  borehole: Borehole,
  pipeRecords: PipeRecord[],
  events: DrillingEvent[]
): Promise<void> {
  return generateExcelReport(borehole, pipeRecords, events);
}
