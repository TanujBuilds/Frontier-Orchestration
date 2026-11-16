import net from 'node:net';
const target=JSON.parse(process.argv[2]);
let done=false,payload='';
const socket=net.connect(target);
function finish(value){if(done)return;done=true;socket.destroy();console.log(JSON.stringify({schema:1,kind:'connection',target,...value}));}
socket.on('data',bytes=>{payload+=bytes.toString();if(payload.length>256)finish({connected:true,payload:'oversized'});});
socket.on('end',()=>finish({connected:true,payload}));
socket.on('error',error=>finish({connected:false,code:error.code??null,syscall:error.syscall??null}));
socket.setTimeout(2000,()=>finish({connected:false,code:'ETIMEDOUT'}));
