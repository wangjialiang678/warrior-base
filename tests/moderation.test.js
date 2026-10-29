import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {publicIPv4,validatePageUrl,inspectExternalPage,visiblePageText} from '../server/safe-page.js';
import {createModerationAdapter} from '../server/moderation.js';
import {createQwenModerator} from '../server/qwen-moderation.js';

function qwenReply(content,usage={prompt_tokens:100,completion_tokens:12}){
 return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(content)}}],usage})};
}

function submittedPayload(options){
 const request=JSON.parse(options.body);
 const userContent=request.messages[1].content;
 const text=Array.isArray(userContent)?userContent[0].text:userContent;
 return {request,payload:JSON.parse(text)};
}

test('link validation still pins public DNS and rejects private addresses/redirects',async()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','100.64.0.1','192.168.0.1','::1'])assert.equal(publicIPv4(ip),false);
 assert.equal(publicIPv4('8.8.8.8'),true);
 for(const url of ['http://workbuddy.link/p/a','https://workbuddy.link.evil.com/a','https://u:p@workbuddy.link/a','https://127.0.0.1/a'])assert.throws(()=>validatePageUrl(url));
 await assert.rejects(inspectExternalPage('https://workbuddy.link/p/a',{resolve:async()=>['127.0.0.1'],request:async()=>assert.fail('must not request')}));
 await assert.rejects(inspectExternalPage('https://workbuddy.link/p/a',{resolve:async()=>['1.2.3.4'],request:async()=>({redirect:'https://example.org/'})}));
 assert.equal(visiblePageText('<script>secret()</script><p>我的作品</p>'),'我的作品');
});

test('Qwen reviews only submitted text and images, never the WorkBuddy page',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'warrior-ai-local-content-'));
 let calls=0;
 let inspections=0;
 const moderator=createQwenModerator({
  apiKey:'test-only',dataDir:dir,
  inspect:async()=>{inspections++;throw new Error('external page must not be requested');},
  fetchImpl:async(url,options)=>{
   assert.match(url,/\/chat\/completions$/);
   const {request,payload}=submittedPayload(options);
   assert.equal(request.enable_thinking,false);
   assert.equal(Object.hasOwn(payload,'externalHomepage'),false);
   assert.equal(Object.hasOwn(payload.requiredCoverage,'externalLink'),false);
   assert.equal(payload.submitted.url,'https://workbuddy.link/p/example');
   if(calls===0){
    assert.equal(request.model,'qwen-flash');
    assert.deepEqual(payload.requiredCoverage,{text:true,images:false});
    assert.equal(Array.isArray(request.messages[1].content),false);
   }else{
    assert.equal(request.model,'qwen3-vl-flash');
    assert.deepEqual(payload.requiredCoverage,{text:true,images:true});
    assert.equal(request.messages[1].content[1].type,'image_url');
   }
   calls++;
   return qwenReply({decision:'allow',coverage:{text:true,images:calls===2}});
  }
 });
 const content={nickname:'小宇',title:'示例作品',description:'记录收支',url:'https://workbuddy.link/p/example'};
 try{
  assert.equal((await moderator.moderate({content})).decision,'allow');
  assert.equal((await moderator.moderate({content,image:{mime:'image/webp',data:'dGVzdA=='}})).decision,'allow');
  assert.equal(inspections,0);
  assert.equal(calls,2);
 }finally{moderator.close();rmSync(dir,{recursive:true,force:true});}
});

test('Qwen requires coverage for submitted text and for an uploaded image only',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'warrior-ai-coverage-'));
 const responses=[
  {decision:'allow',coverage:{text:false,images:false}},
  {decision:'allow',coverage:{text:true,images:false}},
  {decision:'allow',coverage:{text:true,images:false}}
 ];
 const moderator=createQwenModerator({apiKey:'test-only',dataDir:dir,fetchImpl:async()=>qwenReply(responses.shift())});
 try{
  assert.equal((await moderator.moderate({content:{nickname:'小宇'}})).decision,'review');
  assert.equal((await moderator.moderate({content:{nickname:'小宇'}})).decision,'allow');
  assert.equal((await moderator.moderate({content:{nickname:'小宇'},image:{mime:'image/webp',data:'dGVzdA=='}})).decision,'review');
 }finally{moderator.close();rmSync(dir,{recursive:true,force:true});}
});

test('Qwen preserves an AI rejection and turns provider failures into review',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'warrior-ai-decisions-'));
 const fetches=[
  async()=>qwenReply({decision:'reject',coverage:{text:true,images:false}}),
  async()=>({ok:false,status:503}),
  async()=>{throw new Error('provider unavailable');}
 ];
 const moderator=createQwenModerator({apiKey:'test-only',dataDir:dir,fetchImpl:async(...args)=>fetches.shift()(...args)});
 try{
  assert.equal((await moderator.moderate({content:{nickname:'小宇'}})).decision,'reject');
  assert.equal((await moderator.moderate({content:{nickname:'小宇'}})).decision,'review');
  assert.equal((await moderator.moderate({content:{nickname:'小宇'}})).decision,'review');
 }finally{moderator.close();rmSync(dir,{recursive:true,force:true});}
});

test('nickname registrations cannot consume the reserved work-review budget',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'warrior-ai-reserve-'));
 let calls=0;
 const moderator=createQwenModerator({apiKey:'test-only',dataDir:dir,dailyLimit:3,profileLimit:1,fetchImpl:async()=>{
  calls++;
  return qwenReply({decision:'allow',coverage:{text:true,images:false}});
 }});
 try{
  assert.equal((await moderator.moderate({content:{nickname:'测试昵称'}})).decision,'allow');
  assert.equal((await moderator.moderate({content:{nickname:'另一个昵称'}})).decision,'review');
  assert.equal((await moderator.moderate({content:{url:'https://workbuddy.link/p/a'}})).decision,'allow');
  assert.equal((await moderator.moderate({content:{url:'https://workbuddy.link/p/b'}})).decision,'allow');
  assert.equal((await moderator.moderate({content:{url:'https://workbuddy.link/p/c'}})).decision,'review');
  assert.equal(calls,3);
 }finally{moderator.close();rmSync(dir,{recursive:true,force:true});}
});

test('generic moderation adapter ignores external-link coverage and requires actual image coverage',async()=>{
 const replies=[
  {decision:'allow',coverage:{text:true,images:false}},
  {decision:'allow',coverage:{text:true,images:false}},
  {decision:'allow',coverage:{text:false,images:true}},
  {decision:'reject',reason:'blocked',coverage:{text:true,images:true}}
 ];
 const adapter=createModerationAdapter({url:'https://moderation.example/check',token:'test-only',fetchImpl:async()=>({ok:true,json:async()=>replies.shift()})});
 assert.equal((await adapter.moderate({content:{url:'https://workbuddy.link/p/a'},policy:{externalHomepage:true}})).decision,'allow');
 assert.equal((await adapter.moderate({content:{title:'工具'},image:{mime:'image/webp',data:'dGVzdA=='}})).decision,'review');
 assert.equal((await adapter.moderate({content:{title:'工具'}})).decision,'review');
 assert.equal((await adapter.moderate({content:{title:'工具'},image:{mime:'image/webp',data:'dGVzdA=='}})).decision,'reject');
});
