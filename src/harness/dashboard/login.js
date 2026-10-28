const form=document.querySelector('form');
form.addEventListener('submit',async event=>{
 event.preventDefault();const button=form.querySelector('button'),message=document.querySelector('[role="alert"]');button.disabled=true;message.textContent='';
 try{
  const response=await fetch('/login',{method:'POST',body:new URLSearchParams(new FormData(form)),redirect:'manual'});
  if(response.type!=='opaqueredirect'&&!response.ok)throw Error('Connection key was not accepted. Check the key and try again.');
  const session=await fetch('/api/session');if(!session.ok)throw Error('The session could not be created. Try connecting again.');location.assign('/');
 }catch(error){message.textContent=error.message;button.disabled=false;}
});
