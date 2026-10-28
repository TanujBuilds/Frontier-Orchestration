import http from 'node:http';
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
const secret=()=>randomBytes(32).toString('hex');
const equal=(a,b)=>timingSafeEqual(createHash('sha256').update(String(a)).digest(),createHash('sha256').update(String(b)).digest());
const problem=(status,message)=>Object.assign(Error(message),{status});
async function body(request,max=1048576){let size=0,raw='',oversized=false;for await(const chunk of request){size+=chunk.length;if(size>max)oversized=true;else raw+=chunk;}if(oversized)throw problem(413,'Request body exceeds limit');return raw;}

export async function startApi({dispatcher,token,port=0,host='127.0.0.1'}={}){
 if(host!=='127.0.0.1'||typeof token!=='string'||token.length<32)throw Error('Authenticated loopback configuration required');
 const sessions=new Map();let url;
 const server=http.createServer(async(request,response)=>{
  const send=(status,value,type='application/json; charset=utf-8')=>{response.writeHead(status,{'content-type':type});response.end(type.startsWith('application/json')?JSON.stringify(value):value);};
  response.setHeader('cache-control','no-store');response.setHeader('x-content-type-options','nosniff');response.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");response.setHeader('referrer-policy','no-referrer');
  try{
   if(request.headers.host!==new URL(url).host)throw problem(403,'Invalid Host');if(request.headers.origin&&request.headers.origin!==url)throw problem(403,'Invalid Origin');
   const pathname=new URL(request.url,url).pathname;
   if(pathname==='/api/health'&&request.method==='GET')return send(200,{status:'ready',version:'0.1.0'});
   const publicAssets={'/login.js':['login.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8'],'/nunito.ttf':['nunito.ttf','font/ttf']};
   if(request.method==='GET'&&publicAssets[pathname]){const [file,type]=publicAssets[pathname],data=await readFile(new URL('dashboard/'+file,import.meta.url));return send(200,data,type);}
   if(pathname==='/login'&&request.method==='GET')return send(200,'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect to Frontier</title><link rel="stylesheet" href="/style.css"><script src="/login.js" defer></script><body><main class="login panel"><h1>Frontier Harness</h1><p class="muted">Connect to your local coordinator.</p><form method="post"><label>Connection key <input name="token" type="password" required autocomplete="off"></label><button class="primary">Connect</button></form><p role="alert"></p></main></body></html>','text/html; charset=utf-8');
   if(pathname==='/login'&&request.method==='POST'){
    if(request.headers.origin!==url)throw problem(403,'Login requires same-origin submission');
    const supplied=new URLSearchParams(await body(request,4096)).get('token');if(!equal(supplied??'',token))throw problem(401,'Invalid connection key');
    const id=secret();sessions.set(id,{csrf:secret(),expires:Date.now()+8*3600000});response.setHeader('set-cookie',`frontier_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);response.writeHead(303,{location:'/'});response.end();return;
   }
   const bearer=request.headers.authorization?.startsWith('Bearer ')&&equal(request.headers.authorization.slice(7),token),cookie=request.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('frontier_session='))?.slice(17),session=cookie?sessions.get(cookie):null;
   if(!bearer&&(!session||session.expires<Date.now())){if(pathname==='/'&&request.method==='GET'){response.writeHead(303,{location:'/login'});response.end();return;}throw problem(401,'Authentication required');}
   if(pathname==='/api/session'&&request.method==='GET')return send(200,{authenticated:true,csrf:session?.csrf??null});
   if(pathname.startsWith('/api/artifacts/')&&request.method==='GET'){const artifact=await dispatcher.artifacts.read(pathname.slice('/api/artifacts/'.length));return send(200,artifact.data,artifact.type);}
   if(pathname==='/api/invoke'&&request.method==='POST'){
    if(!bearer&&(request.headers.origin!==url||!equal(request.headers['x-csrf-token']??'',session.csrf)))throw problem(403,'CSRF check failed');
    if(!request.headers['content-type']?.startsWith('application/json'))throw problem(415,'JSON content type required');
    let packet;try{packet=JSON.parse(await body(request));}catch(error){throw error.status?error:problem(400,'Invalid JSON');}
    if(!packet||typeof packet!=='object'||Object.keys(packet).some(k=>!['name','input'].includes(k))||typeof packet.name!=='string')throw problem(400,'Malformed tool packet');
    return send(200,await dispatcher.invoke(packet.name,packet.input??{}));
   }
   const assets={'/':'index.html','/app.js':'app.js','/style.css':'style.css'};
   if(request.method==='GET'&&assets[pathname]){const data=await readFile(new URL('dashboard/'+assets[pathname],import.meta.url),'utf8');return send(200,data,pathname.endsWith('.js')?'text/javascript; charset=utf-8':pathname.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8');}
   throw problem(404,'Unknown route');
  }catch(error){if(!response.headersSent)send(error.status??400,{error:error.message});else response.end();}
 });
 server.requestTimeout=15000;server.headersTimeout=10000;server.maxHeadersCount=64;server.keepAliveTimeout=1000;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});url=`http://${host}:${server.address().port}`;
 return {url,server,close:()=>new Promise((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeIdleConnections();})};
}
