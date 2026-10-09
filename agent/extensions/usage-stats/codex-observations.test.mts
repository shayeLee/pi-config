import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identityHash, weeklyObservation, observedTotals, ObservationLedger, observationLines } from "./codex-observations.ts";
const account = identityHash("account"), plan = identityHash("plus");
const now = new Date(2026, 5, 17, 12);
const at = +new Date(2026, 5, 17, 10);
const reset = at + 3 * 86400_000;
const s = (time: number, used: number, r = reset, p = plan) => ({ version: 1 as const, account, plan: p, at: time, used, reset: r });
const totals = (samples: ReturnType<typeof s>[]) => observedTotals(samples, account, plan, now);
test("explicit account-wide weekly provenance", () => {
 const w = { limit_window_seconds: 604800, used_percent: 40, reset_at: reset / 1000 };
 assert.ok(weeklyObservation({ plan_type: "plus", rate_limit: { primary_window: w } }, account, at));
 for (const json of [{plan_type:"plus", additional_rate_limits:[{rate_limit:{primary_window:w}}]}, {plan_type:"plus", rate_limit:{secondary_window:{...w,limit_window_seconds:undefined}}}, {rate_limit:{primary_window:w}}, {plan_type:"plus",rate_limit:{primary_window:w,secondary_window:w}}]) assert.equal(weeklyObservation(json,account,at),undefined);
});
test("baseline, duplicates, jitter highwater and reset drift", () => {
 assert.equal(totals([s(at,40)]).day.intervals,0);
 const t=totals([s(at,40),s(at,40),s(at+1000,39.9,reset+30000),s(at+2000,42,reset+60000)]);
 assert.equal(t.day.points,2);
 assert.equal(t.day.intervals,2);
});
test("cross-midnight unresolved day, enclosed week/month resolvable", () => {
 const midnight=+new Date(2026,5,17);
 const t=totals([s(midnight-1000,10),s(midnight+1000,15)]);
 assert.equal(t.day.points,0); assert.equal(t.yesterday.points,0);
 assert.equal(t.day.unresolved,1); assert.equal(t.yesterday.unresolved,1);
 assert.equal(t.week.points,5); assert.equal(t.month.points,5);
});
test("account, plan, reset, gap and contradictory timestamp safety", () => {
 assert.equal(totals([s(at,10),{...s(at+1000,90),account:identityHash("other")},s(at+2000,12)]).day.points,2);
 assert.equal(totals([s(at,10),s(at+1000,90,reset,identityHash("pro"))]).day.points,0);
 assert.equal(totals([s(at,90),s(at+1000,10,reset+604800_000)]).day.points,0);
 assert.equal(totals([s(at-2*86400_000,10),s(at,50)]).month.points,0);
 assert.equal(totals([s(at,10),s(at+1000,20),s(at+1000,40),s(at+2000,50)]).day.points,0);
 assert.equal(totals([s(at,40),s(at+1000,10),s(at+2000,41)]).day.unresolved,1);
});
test("multiple cycles exceed 100 pp without changing plan", () => {
 const base=+new Date(2026,5,2,10);
 const samples=[];
 for(let i=0;i<3;i++) { const t=base+i*7*86400_000; samples.push(s(t,0,t+86400_000),s(t+3600_000,60,t+86400_000)); }
 assert.equal(totals(samples).month.points,180);
});
test("private per-process ledger and render evidence", async () => {
 const dir=await mkdtemp(join(tmpdir(),"quota-test-"));
 try {
  const ledger=new ObservationLedger(join(dir,"observations"));
  assert.deepEqual(await ledger.read(now),[]);
  assert.equal(ledger.unavailable,false);
  await ledger.append(s(at,10)); await ledger.append(s(at+1000,12));
  assert.equal((await stat(join(dir,"observations"))).mode & 0o777,0o700);
  const {readdir}=await import("node:fs/promises");
  const names=await readdir(join(dir,"observations"));
  assert.equal(names.length,1); assert.equal((await stat(join(dir,"observations",names[0]))).mode & 0o777,0o600);
  const lines=observationLines(totals(await ledger.read(now)));
  assert.match(lines[0],/今日 2.00 pp/);
  assert.match(lines[2],/部分观测/);
  assert.match(observationLines()[0],/数据不足/);
  console.log("Render evidence:\n"+lines.join("\n"));
 } finally {await rm(dir,{recursive:true,force:true});}
});
