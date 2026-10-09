import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire, stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import * as helpers from "./codex-observations.ts";
const require = createRequire(import.meta.url);
const source = await readFile(new URL("../usage-stats.ts",import.meta.url),"utf8");
const compiled=stripTypeScriptTypes(source)
 .replace(/import\s*\{([\s\S]*?)\}\s*from\s*"([^"]+)";/g, (_all,names,path)=>`const {${names}} = require("${path}");`)
 .replace(/export default function/,"exports.default = function")
 .replace(/export (?=(?:async )?function)/g,"")
 + "\nexports.getOpenAICodexQuota = getOpenAICodexQuota; exports.renderCodexQuotaLines = renderCodexQuotaLines; exports.addObservedLines = addObservedLines;";
const jwt=(id: string)=>`header.${Buffer.from(JSON.stringify({"https://api.openai.com/auth":{chatgpt_account_id:id}})).toString("base64url")}.signature`;
async function harness(fetch: any, timeoutScale = 1, observationHelpers: any = helpers) {
 const dir=await mkdtemp(join(tmpdir(),"quota-integration-"));
 const exports:any={};
 const sandbox:any={exports, process, Buffer, Date, AbortController, setTimeout: (fn: any, ms: number) => setTimeout(fn, ms * timeoutScale), clearTimeout, console, fetch,
 require:(name:string)=>name==="@earendil-works/pi-coding-agent"?{getAgentDir:()=>dir}:name==="@earendil-works/pi-tui"?{truncateToWidth:(s:string,w:number)=>s.slice(0,w)}:name.includes("codex-observations")?observationHelpers:require(name)};
 vm.runInNewContext(compiled,sandbox);
 return {exports,dir,close:()=>rm(dir,{recursive:true,force:true})};
}
const response=(used=10)=>({ok:true,json:async()=>({plan_type:"plus",rate_limit:{primary_window:{limit_window_seconds:604800,used_percent:used,reset_at:Date.now()/1000+86400}}})});
test("account-aware cache, original timestamps, fresh waits then refetches",async()=>{
 let requests=0; let release:any; let blocked=false;
 const h=await harness(async()=>{requests++; if(blocked){blocked=false;await new Promise(r=>release=r);} return response(requests);});
 try {
  let account="A", authCalls=0;
  const resolver={getProviderAuth:async()=>{authCalls++;return {auth:{apiKey:jwt(account)}};}};
  const first=await h.exports.getOpenAICodexQuota(resolver);
  assert.equal((await h.exports.getOpenAICodexQuota(resolver)).observation.at,first.observation.at);
  assert.equal(requests,1);assert.equal(authCalls,2);
  account="B";await h.exports.getOpenAICodexQuota(resolver);assert.equal(requests,2);
  account="C";blocked=true;
  const pre=h.exports.getOpenAICodexQuota(resolver);
  while(!release) await new Promise(r=>setTimeout(r,1));
  const final=h.exports.getOpenAICodexQuota(resolver,undefined,true);
  release();await Promise.all([pre,final]);assert.equal(requests,4);
 }finally{await h.close();}
});
test("pre-aborted signal skips auth; stalled auth bounded",async()=>{
 const h=await harness(()=>{throw Error("network must not run");});
 try {
  let calls=0;const resolver={getProviderAuth:()=>{calls++;return new Promise(()=>{});}};
  const c=new AbortController();c.abort();
  assert.equal(await h.exports.getOpenAICodexQuota(resolver,c.signal),undefined);assert.equal(calls,0);
  const started=Date.now();const result=await h.exports.getOpenAICodexQuota(resolver);
  assert.equal(result.unavailable,"auth unavailable");assert.ok(Date.now()-started<8500);
 }finally{await h.close();}
});
test("quota renderer keeps remaining compatibility and fits narrow/wide layouts",async()=>{
 const h=await harness(async()=>response());
 try {
  const theme={fg:(_color:string,text:string)=>text};
  const totals=helpers.observedTotals([],helpers.identityHash("A"),helpers.identityHash("plus"),new Date());
  const quota={planType:"plus",windows:[{label:"weekly",percent:20}],observedLines:helpers.observationLines(totals)};
  for(const width of [24,80,120]) {
   const lines=h.exports.renderCodexQuotaLines(quota,width,theme);
   assert.equal(lines.length,4);assert.ok(lines.every((line:string)=>line.length<=width-2));
   if(width===120) {assert.match(lines[0],/weekly 80% left/);console.log("Quota render at 120 columns:\n"+lines.join("\n"));}
  }
  assert.equal(h.exports.renderCodexQuotaLines({windows:[],unavailable:"HTTP 401"},80,theme).length,4);
 }finally{await h.close();}
});
test("lifecycle uses settled fresh sample even after model switch",async()=>{
 let requests=0;const h=await harness(async()=>{requests++;return response();});
 try{
  const handlers:any={};h.exports.default({on:(name:string,fn:any)=>(handlers[name]??=[]).push(fn),registerCommand:()=>{}});
  const ctx:any={model:{provider:"openai-codex"},modelRegistry:{getProviderAuth:async()=>({auth:{apiKey:jwt("A")}})}};
  assert.equal(handlers.before_provider_request[0]({payload:{}},ctx),undefined);
  while(requests<1) await new Promise(r=>setTimeout(r,1));
  assert.equal(handlers.agent_end,undefined);
  ctx.model={provider:"other"};ctx.signal=AbortSignal.abort();
  assert.equal(handlers.agent_settled[0]({},ctx),undefined);
  while(requests<2) await new Promise(r=>setTimeout(r,1));
  handlers.agent_settled[0]({},ctx);assert.equal(requests,2);
  await handlers.session_shutdown[0]();
 }finally{await h.close();}
});

test("deadline reports timeout, cancellation is not cached, late response cannot append",async()=>{
 let release:any;let requests=0;
 const h=await harness(async()=>{requests++;if(requests===1) await new Promise(r=>release=r);return response();},0.01);
 try{
  const resolver={getProviderAuth:async()=>({auth:{apiKey:jwt("deadline")}})};
  const result=await h.exports.getOpenAICodexQuota(resolver);
  assert.equal(result.unavailable,"timeout after 8s");
  assert.equal((await h.exports.getOpenAICodexQuota(resolver)).unavailable,"timeout after 8s");
  release();await new Promise(r=>setTimeout(r,10));
  const {readdir}=await import("node:fs/promises");
  await assert.rejects(readdir(join(h.dir,"codex-quota-observations")),{code:"ENOENT"});
  const c=new AbortController();
  let unblock:any;
  const h2=await harness(async()=>{await new Promise(r=>unblock=r);return response();},0.01);
  try{
   const canceled=h2.exports.getOpenAICodexQuota(resolver,c.signal);
   while(!unblock) await new Promise(r=>setTimeout(r,1));
   c.abort();assert.equal(await canceled,undefined);unblock();
   // A subsequent request must run rather than reuse canceled undefined.
   const next=h2.exports.getOpenAICodexQuota(resolver);
   await new Promise(r=>setTimeout(r,5));unblock();
   assert.ok((await next)?.windows.length);
  }finally{await h2.close();}
 }finally{await h.close();}
});
test("fresh waiters each get full budget and retain the newer in-flight slot",async()=>{
 let requests=0;const releases:Array<()=>void>=[];
 const h=await harness(async()=>{requests++;await new Promise<void>(r=>releases.push(r));return response(requests);},0.02);
 try{
  const resolver={getProviderAuth:async()=>({auth:{apiKey:jwt("fresh")}})};
  const initial=h.exports.getOpenAICodexQuota(resolver);
  while(requests<1) await new Promise(r=>setTimeout(r,1));
  const one=h.exports.getOpenAICodexQuota(resolver,undefined,true);
  const two=h.exports.getOpenAICodexQuota(resolver,undefined,true);
  await new Promise(r=>setTimeout(r,110));releases[0]();await initial;
  while(requests<2) await new Promise(r=>setTimeout(r,1));
  await new Promise(r=>setTimeout(r,90));
  assert.equal(requests,2);releases[1]();assert.ok((await one).observation);
  while(requests<3) await new Promise(r=>setTimeout(r,1));
  const shared=h.exports.getOpenAICodexQuota(resolver);
  await new Promise(r=>setTimeout(r,5));assert.equal(requests,3);
  releases[2]();assert.ok((await two).observation);assert.ok((await shared).observation);
 }finally{await h.close();}
});
test("failure rows keep persistence warnings; known identity keeps real timestamps only",async()=>{
 let fail=false;
 const h=await harness(async()=>fail?{ok:false,status:503}:response());
 try{
  let account="recorded";
  const resolver={getProviderAuth:async()=>({auth:{apiKey:jwt(account)}})};
  const first=await h.exports.getOpenAICodexQuota(resolver);
  const earlier={...first.observation,at:first.observation.at-1000,used:8};
  await writeFile(join(h.dir,"codex-quota-observations","122-abc.jsonl"),JSON.stringify(earlier)+"\n");
  const positive=await h.exports.addObservedLines(first);
  assert.match(positive.observedLines.join("\n"),/2.00 pp/);
  assert.ok(positive.observedLines.join("\n").includes(new Date(earlier.at).toISOString()));
  assert.match(positive.observedLines.join("\n"),new RegExp(new Date(first.observation.at).toISOString().replace(/\./g,"\\.")));
  const directory=join(h.dir,"codex-quota-observations");
  await writeFile(join(directory,"123-abc.jsonl"),"corrupt\n");
  fail=true;
  const failed=await h.exports.addObservedLines(await h.exports.getOpenAICodexQuota(resolver,undefined,true));
  assert.match(failed.observedLines.join("\n"),/记录 首次/);
  const lines=h.exports.renderCodexQuotaLines(failed,200,{fg:(_:string,s:string)=>s});
  assert.match(lines.join("\n"),/persistence unavailable/);
  account="different";
  const other=await h.exports.addObservedLines(await h.exports.getOpenAICodexQuota(resolver,undefined,true));
  assert.doesNotMatch(other.observedLines.join("\n"),/记录 首次/);
 }finally{await h.close();}
 const broken=await harness(async()=>({ok:false,status:500}));
 try{
  await writeFile(join(broken.dir,"codex-quota-observations"),"not a directory");
  const quota=await broken.exports.addObservedLines({windows:[],unavailable:"HTTP 500"});
  assert.match(broken.exports.renderCodexQuotaLines(quota,200,{fg:(_:string,s:string)=>s}).join("\n"),/persistence unavailable/);
 }finally{await broken.close();}
});
test("shutdown aborts obsolete background response without delaying provider or settled",async()=>{
 let release:any;let requests=0;
 const h=await harness(async()=>{requests++;await new Promise(r=>release=r);return response();});
 try{
  const handlers:any={};h.exports.default({on:(n:string,f:any)=>(handlers[n]??=[]).push(f),registerCommand:()=>{}});
  const ctx:any={model:{provider:"openai-codex"},modelRegistry:{getProviderAuth:async()=>({auth:{apiKey:jwt("old")}})}};
  for(const name of ["session_start","before_agent_start","before_provider_request"]) assert.equal(handlers[name][0]({},ctx),undefined);
  while(!release) await new Promise(r=>setTimeout(r,1));
  assert.equal(requests,1);assert.equal(handlers.agent_settled[0]({},ctx),undefined);
  await handlers.session_shutdown[0]();release();await new Promise(r=>setTimeout(r,10));
  const {readdir}=await import("node:fs/promises");
  await assert.rejects(readdir(join(h.dir,"codex-quota-observations")),{code:"ENOENT"});
  assert.equal(requests,1);
  // The same factory can receive session_start after session replacement.
  ctx.modelRegistry={getProviderAuth:async()=>({auth:{apiKey:jwt("new")}})};
  assert.equal(handlers.session_start[0]({},ctx),undefined);
  while(requests<2) await new Promise(r=>setTimeout(r,1));
  release();await new Promise(r=>setTimeout(r,10));
  const names=await readdir(join(h.dir,"codex-quota-observations"));
  assert.equal(names.length,1);
  const records=(await readFile(join(h.dir,"codex-quota-observations",names[0]),"utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(records.every((s:any)=>s.account===helpers.identityHash("https://chatgpt.com/backend-api\0new")));
  await handlers.session_shutdown[0]();
 }finally{await h.close();}
});

test("stalled ledger read is bounded and degrades to a persistence warning",async()=>{
 class StalledLedger {
  unavailable=false;
  read(){return new Promise(()=>{});}
 }
 const h=await harness(async()=>response(),0.01,{...helpers,ObservationLedger:StalledLedger});
 try{
  const started=Date.now();
  const quota=await h.exports.addObservedLines({windows:[],unavailable:"HTTP 503"});
  assert.ok(Date.now()-started<200);
  assert.match(quota.observedLines.join("\n"),/persistence unavailable/);
 }finally{await h.close();}
});
