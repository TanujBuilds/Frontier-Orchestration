document.querySelector('button').addEventListener('click',()=>{
  const checked=[...document.querySelectorAll('input:checked')].map(input=>input.value);
  document.querySelector('[role="status"]').textContent=checked.join(', ')||'None selected';
});
