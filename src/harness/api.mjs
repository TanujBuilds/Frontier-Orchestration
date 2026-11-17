import http from 'node:http';
import {readRequestBody as body} from './http-body.mjs';
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {OBSERVER_TOOLS} from './observer.mjs';
const secret=()=>randomBytes(32).toString('hex');
const equal=(a,b)=>timingSafeEqual(createHash('sha256').update(String(a)).digest(),createHash('sha256').update(String(b)).digest());
const problem=(status,message)=>Object.assign(Error(message),{status});

export async function startApi({dispatcher,token,viewerToken, trustedOrigins=[],port=0,host='127.0.0.1',headless=false}={}){
 if(host!=='127.0.0.1'||typeof token!=='string'||token.length<32)throw Error('Authenticated loopback configuration required');
 if(viewerToken!==undefined&&(typeof viewerToken!=='string'||viewerToken.length<32||equal(viewerToken,token)))throw Error('Viewer key must be distinct from the operator key and at least32 characters');
 if(!Array.isArray(trustedOrigins)||trustedOrigins.length>10)throw Error('Explicit private HTTPS origins required');
 const privateHosts=new Map();
 for(const value of trustedOrigins){const u=new URL(value);if(u.protocol!=='https:'||!u.hostname.endsWith('.ts.net')||u.username||u.password||u.origin!==value||privateHosts.has(u.host))throw Error('Explicit private HTTPS Tailscale origin required');privateHosts.set(u.host,u.origin);}
 const sessions=new Map();let url;
 const requestOrigin=request=>{
  const host=request.headers.host,forwarded=request.headers['x-forwarded-host'],proto=request.headers['x-forwarded-proto'];
  const count=name=>request.rawHeaders.filter((_,i)=>i%2===0&&request.rawHeaders[i].toLowerCase()===name).length;
  if(count('host')!==1||count('x-forwarded-host')>1||count('x-forwarded-proto')>1||request.headers.forwarded||forwarded?.includes(',')||proto?.includes(','))throw problem(403,'Invalid proxy headers');
  let expected;
  if(forwarded){if(host!==new URL(url).host&&host!==forwarded||proto!=='https'||!privateHosts.has(forwarded)||!['127.0.0.1','::ffff:127.0.0.1'].includes(request.socket.remoteAddress))throw problem(403,'Untrusted private proxy');expected=privateHosts.get(forwarded);}
  else if(host===new URL(url).host){if(proto)throw problem(403,'Unexpected proxy protocol');expected=url;}
  else {expected=privateHosts.get(host);if(!expected||proto&&proto!=='https')throw problem(403,'Invalid Host');}
  if(request.headers.origin&&request.headers.origin!==expected)throw problem(403,'Invalid Origin');return expected;
 };

 const server=http.createServer(async(request,response)=>{
  const send=(status,value,type='application/json; charset=utf-8')=>{response.writeHead(status,{'content-type':type});response.end(type.startsWith('application/json')?JSON.stringify(value):value);};
  response.setHeader('cache-control','no-store');response.setHeader('x-content-type-options','nosniff');response.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");response.setHeader('referrer-policy','no-referrer');
  try{
   const expectedOrigin=requestOrigin(request);
   const pathname=new URL(request.url,url).pathname;
   if(pathname==='/api/health'&&request.method==='GET')return send(200,{status:'ready',version:'0.1.0'});
   if(headless&&pathname!=='/api/invoke'&&pathname!=='/api/session')throw problem(404,'Unknown route');
   const publicAssets={'/login.js':['login.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8'],'/nunito.ttf':['nunito.ttf','font/ttf']};
   if(request.method==='GET'&&publicAssets[pathname]){const [file,type]=publicAssets[pathname],data=await readFile(new URL('dashboard/'+file,import.meta.url));return send(200,data,type);}
   if(pathname==='/login'&&request.method==='GET')return send(200,'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect to Mosaic</title><link rel="stylesheet" href="/style.css"><script src="/login.js" defer></script><body><main class="login panel"><h1>Mosaic</h1><p class="muted">Connect to your local coordinator.</p><form method="post"><label>Connection key <input name="token" type="password" required autocomplete="off"></label><button class="primary">Connect</button></form><p role="alert"></p></main></body></html>','text/html; charset=utf-8');
   if(pathname==='/login'&&request.method==='POST'){
    if(request.headers.origin!==expectedOrigin)throw problem(403,'Login requires same-origin submission');
    const supplied=new URLSearchParams(await body(request,4096)).get('token'),role=equal(supplied??'',token)?'operator':viewerToken&&equal(supplied??'',viewerToken)?'viewer':null;if(!role)throw problem(401,'Invalid connection key');
    const id=secret();sessions.set(id,{role,csrf:secret(),expires:Date.now()+8*3600000});response.setHeader('set-cookie',`frontier_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${expectedOrigin.startsWith('https:')?'; Secure':''}`);response.writeHead(303,{location:'/'});response.end();return;
   }
   const suppliedBearer=request.headers.authorization?.startsWith('Bearer ')?request.headers.authorization.slice(7):null,bearerRole=suppliedBearer&&equal(suppliedBearer,token)?'operator':suppliedBearer&&viewerToken&&equal(suppliedBearer,viewerToken)?'viewer':null,bearer=!!bearerRole,cookie=request.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('frontier_session='))?.slice(17),session=cookie?sessions.get(cookie):null;
   if(headless&&!bearer)throw problem(401,'Authentication required');
   if(!bearer&&(!session||session.expires<Date.now())){if(pathname==='/'&&request.method==='GET'){response.writeHead(303,{location:'/login'});response.end();return;}throw problem(401,'Authentication required');}
   const role=bearerRole??session.role;
   if(pathname==='/'&&request.method==='GET'){response.writeHead(303,{location:'/observer'});response.end();return;}
   if(pathname==='/legacy-console'&&role!=='operator')throw problem(403,'Legacy console requires operator authority');
   if(pathname==='/api/session'&&request.method==='GET')return send(200,{authenticated:true,role,csrf:session?.csrf??null});
   if(pathname.startsWith('/api/artifacts/')&&request.method==='GET'){const artifact=await dispatcher.artifacts.read(pathname.slice('/api/artifacts/'.length));return send(200,artifact.data,artifact.type);}
   if(pathname==='/api/invoke'&&request.method==='POST'){
    if(!bearer&&(request.headers.origin!==expectedOrigin||!equal(request.headers['x-csrf-token']??'',session.csrf)))throw problem(403,'CSRF check failed');
    if(!request.headers['content-type']?.startsWith('application/json'))throw problem(415,'JSON content type required');
    let packet;try{packet=JSON.parse(await body(request));}catch(error){throw error.status?error:problem(400,'Invalid JSON');}
    if(!packet||typeof packet!=='object'||Object.keys(packet).some(k=>!['name','input'].includes(k))||typeof packet.name!=='string')throw problem(400,'Malformed tool packet');
    if(role==='viewer'&&!OBSERVER_TOOLS.has(packet.name))throw problem(403,'Viewer access cannot change or inspect operator state');
    if(role==='viewer'&&packet.name==='tools_list')return send(200,dispatcher.tools().filter(t=>OBSERVER_TOOLS.has(t.name)));
    return send(200,await dispatcher.invoke(packet.name,packet.input??{}));
   }
   const assets={'/observer':'observer.html','/observer.js':'observer.js','/observer.css':'observer.css','/legacy-console':'index.html','/app.js':'app.js','/style.css':'style.css'};
   if(request.method==='GET'&&assets[pathname]){const data=await readFile(new URL('dashboard/'+assets[pathname],import.meta.url),'utf8');return send(200,data,pathname.endsWith('.js')?'text/javascript; charset=utf-8':pathname.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8');}
   throw problem(404,'Unknown route');
  }catch(error){if(!response.headersSent)send(error.status??400,{error:error.message});else response.end();}
 });
 server.requestTimeout=15000;server.headersTimeout=10000;server.maxHeadersCount=64;server.keepAliveTimeout=1000;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});url=`http://${host}:${server.address().port}`;
 return {url,server,close:()=>new Promise((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeIdleConnections();})};
}
