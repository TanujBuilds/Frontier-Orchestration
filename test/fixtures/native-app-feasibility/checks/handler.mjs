import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const {handle}=await import(pathToFileURL(process.env.MOSAIC_APPROVED_INPUTS+'/src/handler.mjs'));
assert.deepEqual(handle({method:'GET',path:'/health'}),{status:200,body:{ok:true}});
assert.deepEqual(handle({method:'POST',path:'/invites',body:{email:'Member@Example.invalid'}}),{status:201,body:{email:'member@example.invalid',role:'member'}});
assert.deepEqual(handle({method:'POST',path:'/invites',body:{email:'invalid'}}),{status:422,body:{error:'invalid_email'}});
assert.deepEqual(handle({method:'GET',path:'/other'}),{status:404,body:{error:'not_found'}});
console.log(JSON.stringify({schema:1,kind:'handler',assertions:4,listener:false}));
