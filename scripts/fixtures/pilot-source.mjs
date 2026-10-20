// Scripted worker fixture, not model output. Used only by the offline integration exercise.
export function pilotSource(stage) {
  return `import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
type Task = { id: string; text: string; done: boolean };
const interactive = ${stage >= 2};
const persistent = ${stage >= 3};
function App() {
  const [tasks, setTasks] = useState<Task[]>(() => {
    if (!persistent) return [];
    try { const value = JSON.parse(localStorage.getItem('night-shift') || '[]');
      return Array.isArray(value) ? value.filter(t => typeof t?.id === 'string' && typeof t?.text === 'string' && typeof t?.done === 'boolean') : [];
    } catch { return []; }
  });
  const [text, setText] = useState('');
  const [filter, setFilter] = useState('All');
  useEffect(() => { if (persistent) localStorage.setItem('night-shift', JSON.stringify(tasks)); }, [tasks]);
  function add(event: React.FormEvent) { event.preventDefault(); if (!interactive || !text.trim()) return;
    setTasks([...tasks, { id: String(Date.now()), text: text.trim(), done: false }]); setText(''); }
  const visible = tasks.filter(task => filter === 'All' || (filter === 'Completed' ? task.done : !task.done));
  return <main>
    <header><p className="eyebrow">YOUR SPACE TO MAKE PROGRESS</p><h1>Night Shift</h1><p>A little focus. A clear next step.</p></header>
    <section aria-label="Task board">
      <form onSubmit={add}><label htmlFor="new-task">New task</label><div className="entry"><input id="new-task" value={text} onChange={e => setText(e.target.value)} placeholder="What will you work on?" /><button type="submit">Add task</button></div></form>
      <nav aria-label="Task filters">{['All', 'Active', 'Completed'].map(name => <button key={name} type="button" aria-pressed={filter === name} onClick={() => setFilter(name)}>{name}</button>)}</nav>
      <p className="count" aria-live="polite">{tasks.filter(t => !t.done).length} active · {tasks.filter(t => t.done).length} completed</p>
      <ul>{visible.map(task => <li key={task.id}><label><input type="checkbox" checked={task.done} onChange={() => setTasks(tasks.map(t => t.id === task.id ? { ...t, done: !t.done } : t))} /><span className={task.done ? 'done' : ''}>{task.text}</span></label></li>)}</ul>
      {!visible.length && <p className="empty">Room for your next good idea.</p>}
    </section><footer>One task at a time.</footer>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
`;
}
export const pilotCss = `:root { font-family: Inter, system-ui, sans-serif; background: #101827; color: #e8eef9; color-scheme: dark; }
* { box-sizing: border-box; } body { margin: 0; } main { max-width: 800px; padding: 64px 24px; margin: auto; }
.eyebrow { color: #88b9aa; font-size: 11px; letter-spacing: .18em; } h1 { font-size: clamp(36px, 7vw, 56px); margin: 14px 0; letter-spacing: -.04em; }
header > p:last-child, footer { color: #a5b4cc; } header { margin-bottom: 36px; } section { padding: 30px; background: #19243a; border: 1px solid #35435b; border-radius: 20px; }
form > label { display: block; font-size: 13px; margin-bottom: 10px; } .entry { display: flex; gap: 10px; } input[type=text], input:not([type]) { flex: 1; min-width: 0; border: 1px solid #52627e; background: #111b2e; border-radius: 10px; padding: 14px; color: #eef3fa; font: inherit; }
button { padding: 12px 18px; border: 1px solid #5e7e77; border-radius: 10px; font: inherit; font-size: 14px; cursor: pointer; background: #a8e0ca; color: #0e2b22; }
nav { display: flex; gap: 8px; margin-top: 28px; flex-wrap: wrap; } nav button { color: #c4d0e3; background: transparent; border: 1px solid transparent; } nav button[aria-pressed=true] { background: #2c3e58; border-color: #5f7394; color: white; }
.count { font-size: 12px; color: #a5b4cc; margin: 24px 0 14px; } ul { list-style: none; margin: 0; padding: 0; } li { padding: 18px 0; border-top: 1px solid #35435b; } li label { display: flex; gap: 14px; align-items: center; overflow-wrap: anywhere; } input[type=checkbox] { width: 20px; height: 20px; accent-color: #a8e0ca; flex-shrink: 0; } .done { text-decoration: line-through; color: #a5b4cc; }
.empty { padding: 40px 0; text-align: center; color: #9aaecb; } footer { font-size: 12px; text-align: center; margin-top: 26px; } :focus-visible { outline: 3px solid #e5c687; outline-offset: 4px; }
@media(max-width: 500px) { main { padding: 32px 16px; } section { padding: 20px; } .entry { flex-direction: column; } }
`;
