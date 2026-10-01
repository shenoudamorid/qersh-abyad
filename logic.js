'use strict';
/* Pure date / money / parsing logic — no DOM, no app state. Loaded before the
   main script in index.html, and required by the tests in test/ under Node. */

/* ═══════ dates ═══════ */
const iso=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const parseISO=s=>{const[y,m,d]=s.split('-').map(Number);return new Date(y,m-1,d);};
const dim=(y,m)=>new Date(y,m,0).getDate();
const prevMonth=k=>{const[y,m]=k.split('-').map(Number);return iso(new Date(y,m-2,1)).slice(0,7);};
const nextMonth=k=>{const[y,m]=k.split('-').map(Number);return iso(new Date(y,m,1)).slice(0,7);};

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

/* ═══════ recurring ═══════ */
/* the postings a fixed item owes as of `now`: every month after r.lastMonth whose
   day has arrived, but never more than 12 months back */
function recurringDue(r,now){
  const mk=iso(now).slice(0,7);
  let floor=mk; for(let i=0;i<11;i++) floor=prevMonth(floor);
  let k=r.lastMonth?nextMonth(r.lastMonth):mk;
  if(k<floor) k=floor;
  const out=[];
  while(k<=mk){
    const [y,m]=k.split('-').map(Number);
    const day=Math.min(r.day,dim(y,m));
    if(k===mk && now.getDate()<day) break;
    out.push({month:k,date:iso(new Date(y,m-1,day))});
    k=nextMonth(k);
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

if(typeof module!=='undefined') module.exports={iso,parseISO,dim,prevMonth,nextMonth,daysElapsed,
  txDelta,afterRecon,recurringDue,months12,rentOverdue,norm,normDigits,stripAl,tokOf,tokMatch,
  parseSentence,checkBackup};
