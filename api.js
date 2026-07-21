// Copyright (c)2026 sibyx & Litao Fan — SibyX 非商用，须署名，详见 LICENSE
const express=require("express"),crypto=require("crypto"),fs=require("fs"),path=require("path"),router=express.Router();router.use(express.json({limit:"256kb"}));
router.get("/policy",(e,t)=>{t.set("Access-Control-Allow-Origin","*");t.set("Access-Control-Allow-Methods","GET, OPTIONS");t.set("Access-Control-Allow-Headers","Content-Type");if("OPTIONS"===e.method)return t.sendStatus(204);const P={demo:{label:"DEMO",maxInlineMB:2,externalStorage:false,voice:false,attach:false,alwaysOn:false,concurrency:1},free:{label:"FREE",maxInlineMB:2,externalStorage:false,voice:false,attach:false,alwaysOn:false,concurrency:2},pro:{label:"PRO",maxInlineMB:4,externalStorage:true,voice:true,attach:true,alwaysOn:true,concurrency:5},vip:{label:"VIP",maxInlineMB:8,externalStorage:true,voice:true,attach:true,alwaysOn:true,concurrency:1e9}};t.json({ok:true,policy:P,ts:Date.now()})});
const DATA=path.join(__dirname,"apidata");fs.mkdirSync(DATA,{recursive:true});const PUBKEYS=path.join(DATA,"pubkeys.json"),BACKUPS=path.join(DATA,"backups.json"),WAKES=path.join(DATA,"wakes.json");
const WAKESUBS=path.join(DATA,"wakesubs.json");
let webpush=null; try{ webpush=require("web-push"); }catch(e){ webpush=null; }
let VAPID=null;
try{ VAPID=JSON.parse(fs.readFileSync(path.join(__dirname,"vapid.json"),"utf8")); }catch(e){ try{ if(webpush){ VAPID=webpush.generateVAPIDKeys(); fs.writeFileSync(path.join(__dirname,"vapid.json"),JSON.stringify(VAPID)); } }catch(e2){ VAPID=null; } }
if(VAPID&&VAPID.publicKey&&VAPID.privateKey){ try{ webpush.setVapidDetails("mailto:sibyx@local",VAPID.publicKey,VAPID.privateKey); }catch(e){} }
function load(r){try{return JSON.parse(fs.readFileSync(r,"utf8"))}catch(r){return{}}}
function save(r,t){fs.writeFileSync(r,JSON.stringify(t))}
function deriveAddress(r){const t=Buffer.from(r,"base64");if(65!==t.length||4!==t[0])throw new Error("bad_pub_len");return"0x"+crypto.createHash("sha256").update(t).digest().slice(-20).toString("hex")}
async function verifySig(r,t,s){try{const e=Buffer.from(r,"base64"),o=e.slice(1,33).toString("base64url"),n=e.slice(33,65).toString("base64url"),i=crypto.createPublicKey({key:{kty:"EC",crv:"P-256",x:o,y:n},format:"jwk",dsaEncoding:"ieee-p1363"});return crypto.verify("sha256",Buffer.from(t,"utf8"),i,Buffer.from(s,"base64"))}catch(r){return false}}
// 统一签名校验：signB64=原始65B公钥(base64)、msg=待验明文、sigB64=签名、expectedAddr=期望地址、ts=客户端时间戳(ms)
// 防：缺字段 / 时间戳重放(>5min) / 公钥地址不匹配 / 签名无效。复用 deriveAddress+verifySig。
function authSigned(signB64,msg,sigB64,expectedAddr,ts){try{if(!signB64||!msg||!sigB64||!expectedAddr||!ts)return false;if(Math.abs(Date.now()-Number(ts))>300000)return false;if(deriveAddress(signB64)!==expectedAddr)return false;return verifySig(signB64,msg,sigB64)}catch(e){return false}}
const CHALLENGE=(r,t)=>"sibyx-pubkey-v1|"+r+"|"+t;
router.post("/pubkey",async(r,t)=>{const{addr:s,sign:e,dh:o,nick:n,ts:i,sig:a}=r.body||{};if(!(s&&e&&o&&a))return t.status(400).json({ok:false,err:"missing_fields"});let u;try{u=deriveAddress(e)}catch(r){return t.status(400).json({ok:false,err:"bad_sign_pub"})}if(u!==s)return t.status(403).json({ok:false,err:"addr_mismatch"});if(!await verifySig(e,CHALLENGE(s,i),a))return t.status(403).json({ok:false,err:"bad_sig"});const d=load(PUBKEYS);d[s]={addr:s,sign:e,dh:o,nick:(n||"").slice(0,40),ts:i||Date.now()},save(PUBKEYS,d),t.json({ok:true})});
router.get("/pubkey",(r,t)=>{const s=r.query.addr;if(!s)return t.status(400).json({ok:false,err:"missing_addr"});const e=load(PUBKEYS)[s];if(!e)return t.status(404).json({ok:false,err:"not_found"});t.json({ok:true,addr:e.addr,sign:e.sign,dh:e.dh,nick:e.nick,ts:e.ts})});
router.post("/backup",(r,t)=>{const{id:s,ct:e,sign:sg,ts:i,sig:a}=r.body||{};if(!s||!e||"string"!=typeof e||e.length>2e5)return t.status(400).json({ok:false,err:"bad"});if(!authSigned(sg,s+"|"+i+"|"+e,a,s,i))return t.status(403).json({ok:false,err:"bad_sig"});const o=load(BACKUPS);o[String(s)]={id:String(s),ct:e,ts:Date.now()},save(BACKUPS,o),t.json({ok:true})});
router.get("/backup",(r,t)=>{const s=r.query.id,sg=r.query.sign,i=r.query.ts,a=r.query.sig;if(!s)return t.status(400).json({ok:false,err:"missing_id"});if(!authSigned(sg,s+"|"+i,a,s,i))return t.status(403).json({ok:false,err:"bad_sig"});const e=load(BACKUPS)[String(s)];if(!e)return t.status(404).json({ok:false,err:"not_found"});t.json({ok:true,id:e.id,ct:e.ct,ts:e.ts})});
// ===== B-01 唤醒 + 真后台推送（a 轻量邮箱 + b VAPID）=====
// POST /wake：发 DM 时发送方携带 {addr:收件人, from:发件人, mid:消息id}（仅元数据，不破 E2EE）。
//   服务端：①存信号供 (a) 轮询取走；②若收件人已订阅则 web-push.sendNotification 触发 (b)。
router.post("/wake",(r,t)=>{
  const{addr:s,from:e,mid:m,sign:sg,ts:i,sig:a}=r.body||{};
  if(!s||!e)return t.status(400).json({ok:false,err:"missing_addr"});
  if(!authSigned(sg,e+"|"+s+"|"+i,a,e,i))return t.status(403).json({ok:false,err:"bad_sig"});
  const o={from:e||null,ts:Date.now(),mid:m||null};
  const w=load(WAKES); w[s]=o; save(WAKES,w);
  if(webpush&&VAPID&&WAKESUBS){
    const subs=load(WAKESUBS); const sub=subs[s];
    if(sub){ try{ webpush.sendNotification(sub, JSON.stringify({from:e||null,mid:m||null,ts:o.ts,title:"SibyX 新私聊"})).catch(()=>{}); }catch(err){ /* 推送失败静默（订阅过期/撤销）*/ } }
  }
  t.json({ok:true});
});
// GET /wake?addr=：收件人轮询取走信号（204=无，200=有），取走即删
router.get("/wake",(r,t)=>{
  const s=r.query.addr,sg=r.query.sign,i=r.query.ts,a=r.query.sig; if(!s)return t.status(400).json({ok:false,err:"missing_addr"});
  if(!authSigned(sg,s+"|"+i,a,s,i))return t.status(403).json({ok:false,err:"bad_sig"});
  const e=load(WAKES),o=e[s];
  if(!o)return t.status(204).end();
  delete e[s]; save(WAKES,e);
  t.json({ok:true,from:o.from,ts:o.ts,mid:o.mid});
});
// POST /wake/sub：{addr, subscription} 存/删订阅（b 用）；subscription=null 即取消
router.post("/wake/sub",(r,t)=>{
  const{addr:s,subscription:sub,sign:sg,ts:i,sig:a}=r.body||{};
  if(!s)return t.status(400).json({ok:false,err:"missing_addr"});
  if(!authSigned(sg,s+"|"+i,a,s,i))return t.status(403).json({ok:false,err:"bad_sig"});
  const subs=load(WAKESUBS);
  if(sub){ subs[s]=sub; } else { delete subs[s]; }
  save(WAKESUBS,subs);
  t.json({ok:true});
});
// GET /vapid：返回 VAPID 公钥（客户端订阅推送时要用）
router.get("/vapid",(r,t)=>{ if(VAPID&&VAPID.publicKey)return t.json({ok:true,publicKey:VAPID.publicKey}); t.json({ok:false}) });
module.exports=router;
