export function encodeCsv(rows) {
  return rows.map(row => row.map(field =>
    /[",\r\n]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field,
  ).join(',')).join('\r\n') + '\r\n';
}
