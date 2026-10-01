'use strict';
/* Pure date / money / parsing logic — no DOM, no app state. Loaded before the
   main script in index.html, and required by the tests in test/ under Node. */

/* ═══════ dates ═══════ */
const iso=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const parseISO=s=>{const[y,m,d]=s.split('-').map(Number);return new Date(y,m-1,d);};
const dim=(y,m)=>new Date(y,m,0).getDate();
const prevMonth=k=>{const[y,m]=k.split('-').map(Number);return iso(new Date(y,m-2,1)).slice(0,7);};
const nextMonth=k=>{const[y,m]=k.split('-').map(Number);return iso(new Date(y,m,1)).slice(0,7);};
const addDays=(d,n)=>new Date(d.getFullYear(),d.getMonth(),d.getDate()+n);

/* days of month `mk` that have happened by `now` — the divisor for daily averages */
function daysElapsed(mk,now){
  const cur=iso(now).slice(0,7), [y,m]=mk.split('-').map(Number);
  if(mk<cur) return dim(y,m);
  if(mk>cur) return 0;
  return now.getDate();
}

/* ═══════ money ═══════ */
/* signed effect of one transaction on account `id` */
function txDelta(t,id){
  if(t.kind==='trf') return (t.toAcct===id?t.amount:0)-(t.acct===id?t.amount:0);
  if(t.acct!==id) return 0;
  return (t.kind==='inc'||t.kind==='ref') ? t.amount : -t.amount;
}

/* does tx `t` fall after reconciliation `L`? Same-day tx logged after the count
   belong to the next period (older recons lack `at`). */
const afterRecon=(t,L)=>t.date>L.date || (!!L.at && t.date===L.date && t.at>L.at);

/* ═══════ budgets ═══════ */
/* did spending go from `before` to `after` across 80% or 100% of `budget`? */
function budgetCross(before,after,budget){
  if(!(budget>0)||!(after>before)) return '';
  if(before<=budget && after>budget) return 'over';
  if(before<budget*.8 && after>=budget*.8 && after<=budget) return 'near';
  return '';
}

/* ═══════ recurring ═══════ */
/* the postings a fixed item owes as of `now`, never more than 12 months back.
   freq 'month' (default): r.day, tracked by r.lastMonth — a new item posts this month once its day arrives.
   freq 'week': r.dow (0=Sunday), 'year': r.mon + r.day — tracked by r.lastDate,
   and a new one only posts dates on or after r.since. */
function recurringDue(r,now){
  const t=iso(now), mk=t.slice(0,7);
  let floor=mk; for(let i=0;i<11;i++) floor=prevMonth(floor);
  const out=[], f=r.freq||'month';
  if(f==='week'){
    const dow=Math.min(6,Math.max(0,r.dow|0));
    let d=r.lastDate?addDays(parseISO(r.lastDate),1):parseISO(r.since||t);
    if(iso(d)<floor+'-01') d=parseISO(floor+'-01');
    while(d.getDay()!==dow) d=addDays(d,1);
    for(;iso(d)<=t;d=addDays(d,7)) out.push({month:iso(d).slice(0,7),date:iso(d)});
  }else if(f==='year'){
    const mon=Math.min(12,Math.max(1,r.mon|0||1));
    for(let y=r.lastDate?+r.lastDate.slice(0,4)+1:+(r.since||t).slice(0,4);;y++){
      const date=iso(new Date(y,mon-1,Math.min(r.day,dim(y,mon))));
      if(date>t) break;
      if(!r.lastDate && date<(r.since||t)) continue;
      if(date<floor+'-01') continue;
      out.push({month:date.slice(0,7),date});
    }
  }else{
    let k=r.lastMonth?nextMonth(r.lastMonth):mk;
    if(k<floor) k=floor;
    while(k<=mk){
      const [y,m]=k.split('-').map(Number);
      const day=Math.min(r.day,dim(y,m));
      if(k===mk && now.getDate()<day) break;
      out.push({month:k,date:iso(new Date(y,m-1,day))});
      k=nextMonth(k);
    }
  }
  return out;
}

/* ═══════ rent ═══════ */
/* the 12 months ending at `now`, not before the lease start */
function months12(start,now){
  const out=[]; let k=iso(now).slice(0,7);
  for(let i=0;i<12;i++){ if(!start||k>=start.slice(0,7)) out.unshift(k); k=prevMonth(k); }
  return out;
}
/* month `m` is late once it's in the past, or it's this month and the due day has passed */
function rentOverdue(m,dueDay,now){
  const tm=iso(now).slice(0,7);
  if(m<tm) return true;
  if(m>tm) return false;
  return now.getDate()>Math.min(dueDay||1,dim(+tm.slice(0,4),+tm.slice(5,7)));
}

/* rent paid for month `m`: fully (in r.paid) or partly (r.part[m]) */
const rentPaid=(r,m)=>(r.paid||[]).includes(m)?r.amount:Math.min(r.amount,((r.part||{})[m])||0);
const rentLeft=(r,m)=>r.amount-rentPaid(r,m);
const rentDueDate=(r,m)=>`${m}-${String(Math.min(r.dueDay||1,dim(+m.slice(0,4),+m.slice(5,7)))).padStart(2,'0')}`;

/* ═══════ debts ═══════ */
const debtPaid=d=>(d.pays||[]).reduce((s,p)=>s+p.amount,0);
const debtLeft=d=>d.settledAt?0:Math.max(0,d.amount-debtPaid(d));

/* ═══════ what's due ═══════ */
/* open debts, upcoming expenses and unpaid rent that are late or due within `days` */
function dueItems({debts=[],plans=[],rents=[]},now,days=7){
  const t=iso(now), soon=iso(addDays(now,days)), out=[];
  for(const d of debts) if(!d.settledAt && d.due && d.due<=soon)
    out.push({type:'debt',id:d.id,name:d.person,dir:d.dir,date:d.due,amount:debtLeft(d),late:d.due<t});
  for(const p of plans) if(!p.done && p.date<=soon)
    out.push({type:'plan',id:p.id,name:p.name,date:p.date,amount:p.amount,late:p.date<t});
  for(const r of rents){
    const ms=months12(r.start,now).filter(m=>rentLeft(r,m)>0 && rentDueDate(r,m)<=soon);
    if(!ms.length) continue;
    out.push({type:'rent',id:r.id,name:r.tenant,date:rentDueDate(r,ms[0]),months:ms.length,
      amount:ms.reduce((s,m)=>s+rentLeft(r,m),0),late:ms.some(m=>rentOverdue(m,r.dueDay,now))});
  }
  return out.sort((a,b)=>a.date.localeCompare(b.date));
}

/* ═══════ natural language entry ═══════ */
const AR_DIGITS={'٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9',
                 '۰':'0','۱':'1','۲':'2','۳':'3','۴':'4','۵':'5','۶':'6','۷':'7','۸':'8','۹':'9'};
const normDigits=s=>s.replace(/[٠-٩۰-۹]/g,d=>AR_DIGITS[d]);
function norm(x){
  return normDigits(String(x||''))
    .replace(/[ً-ْٰـ]/g,'')
    .replace(/[أإآٱ]/g,'ا')
    .replace(/ة/g,'ه')
    .replace(/ى/g,'ي')
    .toLowerCase().trim();
}
const stripAl=w=>{ const n=norm(w); return n.length>4&&n.startsWith('ال')?n.slice(2):n; };
const tokOf=x=>String(x||'').split(/[\s,،.ـ_-]+/).filter(Boolean);
function tokMatch(a,b){
  if(a.length<3||b.length<3) return a===b;
  return a===b || a.startsWith(b) || b.startsWith(a);
}
const REF_W=['مرتجع','رجعت','استرجاع','مردود'];
const INC_W=['دخل','قبضت','استلمت','مرتب','عموله','عمولات','ايجار','ارباح','حصلت'];

/* ctx: {accts, expCats, incCats, pro, lastCat:{exp,inc,ref}, acct} */
function parseSentence(raw,ctx){
  const s=normDigits(String(raw||''));
  const m=s.match(/\d+(\.\d+)?/);
  if(!m) return null;
  const amount=Number(m[0]);
  if(!(amount>0)) return null;
  const toks=tokOf(s.slice(0,m.index)+' '+s.slice(m.index+m[0].length));
  const keys=toks.map(stripAl);
  const used=new Array(toks.length).fill(false);
  const hasW=list=>keys.some((k,i)=>!used[i]&&list.some(w=>tokMatch(k,stripAl(w))));

  /* score a set of named items against the unused tokens */
  const score=(items,nameOf)=>{
    let best=null,bs=0,bh=[];
    for(const it of items){
      const nt=tokOf(nameOf(it)).map(stripAl).filter(w=>w.length>=2);
      if(!nt.length) continue;
      let sc=0,hit=[];
      for(const w of nt){
        for(let i=0;i<keys.length;i++){
          if(used[i]||hit.includes(i)) continue;
          if(tokMatch(keys[i],w)){ sc+=w.length; hit.push(i); break; }
        }
      }
      if(sc>bs){ bs=sc; best=it; bh=hit; }
    }
    return {best,score:bs,hit:bh};
  };

  /* accounts first — their names are the most distinctive */
  const aM=score(ctx.accts,a=>a.name);
  if(aM.best) aM.hit.forEach(i=>used[i]=true);

  const refHit=ctx.pro&&hasW(REF_W), incHit=hasW(INC_W);
  const eM=score(ctx.expCats,c=>c.name);
  const iM=score(ctx.incCats,c=>c.name);
  let kind;
  if(refHit) kind='ref';
  else if(iM.score>eM.score) kind='inc';
  else if(eM.score>iM.score) kind='exp';
  else kind=incHit?'inc':'exp';

  const cM = kind==='inc'?iM:eM;
  if(cM.best) cM.hit.forEach(i=>used[i]=true);

  /* drop leftover trigger words from the note */
  keys.forEach((k,i)=>{
    if(used[i]) return;
    if(REF_W.some(w=>tokMatch(k,stripAl(w)))||INC_W.some(w=>tokMatch(k,stripAl(w)))) used[i]=true;
  });

  const cats=kind==='inc'?ctx.incCats:ctx.expCats;
  const note=toks.filter((_,i)=>!used[i]).join(' ').slice(0,60);
  return {amount,kind,
    cat:(cM.best&&cM.best.id)||ctx.lastCat[kind]||(cats[0]&&cats[0].id),
    acct:(aM.best&&aM.best.id)||ctx.acct, note};
}

/* ═══════ backup ═══════ */
/* returns an error message for a malformed backup, or '' if it's safe to restore */
function checkBackup(d){
  if(!d||typeof d!=='object') return 'not an object';
  if(!Array.isArray(d.tx)||!Array.isArray(d.cats)) return 'missing tx or cats';
  for(const k of ['acct','recur','debt','recon','plan','rent'])
    if(d[k]!=null && !Array.isArray(d[k])) return `${k} is not a list`;
  const ids=x=>x&&typeof x==='object'&&(typeof x.id==='string'||typeof x.id==='number');
  for(const k of ['tx','cats','acct','recur','debt','recon','plan','rent'])
    if((d[k]||[]).some(x=>!ids(x))) return `${k} has a record without an id`;
  for(const t of d.tx){
    if(!(typeof t.amount==='number'&&isFinite(t.amount))) return 'tx with a bad amount';
    if(typeof t.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(t.date)) return 'tx with a bad date';
  }
  for(const r of (d.recon||[]))
    if(typeof r.date!=='string') return 'recon with a bad date';
  return '';
}

if(typeof module!=='undefined') module.exports={iso,parseISO,dim,prevMonth,nextMonth,addDays,daysElapsed,
  txDelta,afterRecon,budgetCross,recurringDue,months12,rentOverdue,rentPaid,rentLeft,rentDueDate,
  debtPaid,debtLeft,dueItems,norm,normDigits,stripAl,tokOf,tokMatch,
  parseSentence,checkBackup};
