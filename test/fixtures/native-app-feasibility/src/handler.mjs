export function handle(request){
  if(request.method==='GET'&&request.path==='/health')return {status:200,body:{ok:true}};
  if(request.method==='POST'&&request.path==='/invites'){
    if(typeof request.body?.email!=='string'||!request.body.email.includes('@'))return {status:422,body:{error:'invalid_email'}};
    return {status:201,body:{email:request.body.email.toLowerCase(),role:'member'}};
  }
  return {status:404,body:{error:'not_found'}};
}
