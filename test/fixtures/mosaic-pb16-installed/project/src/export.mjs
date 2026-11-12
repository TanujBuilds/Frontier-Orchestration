import { encodeCsv } from './csv.mjs';

document.querySelector('button').addEventListener('click', () => {
  const selected = [...document.querySelectorAll('tbody input:checked')];
  const rows = selected.map(input =>
    [...input.closest('tr').cells].slice(1).map(cell => cell.textContent),
  );
  const url = URL.createObjectURL(new Blob([encodeCsv([['name', 'total'], ...rows])], { type: 'text/csv' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'sales.csv';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
