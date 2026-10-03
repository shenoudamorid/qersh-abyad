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
  /* bought on credit: the expense counts on the day of purchase, but money only leaves with each payment (creditFlows) */
  if(t.credit && t.kind==='exp') return 0;
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
/* money a debt moved through accounts: lending takes it out, borrowing brings it in,
   and each repayment goes the other way. No account = recorded only, balances untouched. */
function debtFlows(d){
  const s=d.dir==='out'?-1:1, out=[];
  if(d.acct) out.push({acct:d.acct,date:d.date,at:d.at,amount:s*d.amount});
  for(const p of (d.pays||[])) if(p.acct) out.push({acct:p.acct,date:p.date,at:p.at,amount:-s*p.amount});
  return out;
}

/* ═══════ bought on credit ═══════ */
/* an expense with `credit:{vendor,due,pays:[{amount,date,acct,at}],settledAt?}` — logged when bought
   or repaired, paid later in one go or in parts. Payments move account balances; they are never
   counted as expenses again. */
const creditPaid=t=>((t.credit&&t.credit.pays)||[]).reduce((s,p)=>s+p.amount,0);
const creditLeft=t=>!t.credit||t.credit.settledAt?0:Math.max(0,t.amount-creditPaid(t));
const creditFlows=t=>t.credit?(t.credit.pays||[]).filter(p=>p.acct).map(p=>({acct:p.acct,date:p.date,at:p.at,amount:-p.amount})):[];

/* ═══════ nightly stays ═══════ */
/* a booking: {from:'YYYY-MM-DD', nights, total, fee, channel, pays:[{amount,date,acct,pre?}]} — the guest
   sleeps the nights from `from` up to (not including) the checkout day. Payments are what actually
   arrived (a deposit, then the rest); `pre` marks money received before the app was in use, already
   inside the opening balance. Older bookings carry a single `paidOn` instead of `pays`.
   `atProp`: a platform booking the guest pays in full at the property; the platform bills its
   commission later (`feePay` once it's paid). `cancelled`: the day it was called off — its nights
   are free again, what was kept is earned on that day, and `refunds` is what went back to the guest. */
const stayNet=st=>Math.max(0,(st.total||0)-(st.fee||0));
const stayPaid=st=>st.pays?st.pays.reduce((s,p)=>s+p.amount,0):(st.paidOn?stayNet(st):0);
const stayRefunded=st=>(st.refunds||[]).reduce((s,p)=>s+p.amount,0);
/* what reaches you for the booking: the net payout, or the full price when the guest pays at the property */
const stayDue=st=>st.atProp?(st.total||0):stayNet(st);
const stayLeft=st=>st.cancelled?0:Math.max(0,stayDue(st)-stayPaid(st));
/* commission still owed to the platform for a pay-at-property booking */
const stayFeeOwed=st=>st.atProp&&!st.cancelled&&!st.feePay&&(st.fee||0)>0?st.fee:0;
const isPlatform=st=>st.channel==='booking'||st.channel==='airbnb';
const stayOut=st=>iso(addDays(parseISO(st.from),Math.max(1,st.nights|0)));
/* nights of the stay that fall in month `mk` (a cancelled booking has none) */
function stayNightsIn(st,mk){
  if(st.cancelled) return 0;
  const [y,m]=mk.split('-').map(Number), a=parseISO(st.from), out=parseISO(stayOut(st));
  const lo=new Date(Math.max(a,new Date(y,m-1,1))), hi=new Date(Math.min(out,new Date(y,m,1)));
  return Math.max(0,Math.round((hi-lo)/864e5));
}
/* what a booking earned in month `mk`: its net split by the nights, or for a cancelled one
   whatever was kept, on the day it was cancelled */
function stayEarnedIn(st,mk){
  if(st.cancelled) return st.cancelled.slice(0,7)===mk?Math.max(0,stayPaid(st)-stayRefunded(st)):0;
  const n=stayNightsIn(st,mk);
  return n?stayNet(st)*n/Math.max(1,st.nights|0):0;
}
/* the month's picture: nights booked, money by channel (split by the nights in the month),
   and payouts not received yet (any month) */
function staySummary(stays,mk){
  const out={nights:0,gross:0,fees:0,net:0,count:0,by:{},pending:0,pendingN:0,kept:0};
  for(const st of stays){
    const left=stayLeft(st);
    if(left>0.005){ out.pending+=left; out.pendingN++; }
    if(st.cancelled){ const k=stayEarnedIn(st,mk); out.kept+=k; out.net+=k; continue; }
    const n=stayNightsIn(st,mk); if(!n) continue;
    const share=n/Math.max(1,st.nights|0);
    out.count++; out.nights+=n;
    out.gross+=st.total*share; out.fees+=(st.fee||0)*share; out.net+=stayNet(st)*share;
    const b=out.by[st.channel]||(out.by[st.channel]={nights:0,net:0,count:0});
    b.nights+=n; b.net+=stayNet(st)*share; b.count++;
  }
  return out;
}

/* ═══════ rental units ═══════ */
/* a unit is {id,name,archived?}. Bookings, contracts and expenses point at it by `unitId`;
   older data carries the unit's name in `unit` instead. */
const unitKey=x=>x.unitId||String(x.unit||'').trim();
/* is this tx part of the rental business rather than personal money? */
const isBiz=t=>!!(t.stay||t.rent||t.unitId||t.unit);
/* scope 'mine' = personal only, 'biz' = the rentals only, anything else = everything */
const inScope=(t,scope)=>scope==='mine'?!isBiz(t):scope==='biz'?isBiz(t):true;

/* move names to ids: creates a unit per distinct name (case/spacing-insensitive), points every
   booking, contract and tx at it, and tags the income each booking or contract logged.
   Returns the touched records so the caller can save just those. */
function migrateUnits({units=[],stays=[],rents=[],txs=[]},newId){
  const out={units:units.slice(),stays:new Set(),rents:new Set(),txs:new Set(),unitsChanged:false};
  const byName=new Map(out.units.map(u=>[norm(u.name),u]));
  const idOf=name=>{
    const n=String(name||'').trim(); if(!n) return '';
    let u=byName.get(norm(n));
    if(!u){ u={id:newId(),name:n}; out.units.push(u); byName.set(norm(n),u); out.unitsChanged=true; }
    return u.id;
  };
  const fix=(x,set)=>{ if(x.unitId||!('unit' in x)) return;
    const id=idOf(x.unit); delete x.unit; if(id) x.unitId=id; set.add(x); };
  stays.forEach(x=>fix(x,out.stays)); rents.forEach(x=>fix(x,out.rents)); txs.forEach(x=>fix(x,out.txs));
  const txById=new Map(txs.map(t=>[t.id,t]));
  const tag=(id,f)=>{ const t=txById.get(id); if(t&&f(t)) out.txs.add(t); };
  for(const st of stays) for(const p of [...(st.pays||[]),...(st.refunds||[]),...(st.feePay?[st.feePay]:[])])
    if(p.tx) tag(p.tx,t=>{ let ch=false;
      if(t.stay!==st.id){ t.stay=st.id; ch=true; }
      if((t.unitId||'')!==(st.unitId||'')){ if(st.unitId) t.unitId=st.unitId; else delete t.unitId; ch=true; }
      return ch; });
  for(const r of rents) for(const ids of Object.values(r.txs||{})) for(const id of ids)
    tag(id,t=>{ let ch=false;
      if(t.rent!==r.id){ t.rent=r.id; ch=true; }
      if((t.unitId||'')!==(r.unitId||'')){ if(r.unitId) t.unitId=r.unitId; else delete t.unitId; ch=true; }
      return ch; });
  return {units:out.units,unitsChanged:out.unitsChanged,stays:[...out.stays],rents:[...out.rents],txs:[...out.txs]};
}

/* the rentals' month, for one unit (`unit` = its id, '' = no unit) or all of them (undefined).
   Two views of the same month, side by side:
   - earned: bookings by the nights slept (net of commission) plus each contract's monthly rent —
     what the month is worth, paid or not
   - cash: the money that actually came in this month (deposits for later stays included) less
     what went out, commissions paid and refunds to guests included */
function rentalMonth({stays=[],rents=[],txs=[]},mk,unit,now){
  const mine=x=>unit===undefined||unitKey(x)===unit;
  let earned=0, nights=0, rentDue=0;
  for(const st of stays) if(mine(st)){ earned+=stayEarnedIn(st,mk); nights+=stayNightsIn(st,mk); }
  const cur=iso(now||new Date()).slice(0,7);
  for(const r of rents) if(mine(r) && mk>=String(r.start||'').slice(0,7) && mk<=cur) rentDue+=r.amount;
  earned+=rentDue;
  const tx=txs.filter(t=>isBiz(t) && mine(t) && t.date.slice(0,7)===mk);
  const s=f=>tx.filter(f).reduce((a,t)=>a+t.amount,0);
  const collected=s(t=>t.kind==='inc')-s(t=>t.kind==='exp'&&t.refund);
  const fees=s(t=>t.kind==='exp'&&t.fee);
  const cost=s(t=>t.kind==='exp'&&!t.refund)-s(t=>t.kind==='ref');
  /* the earned view already took the commission off each booking — don't take it twice */
  const costEarned=cost-fees;
  return {earned,nights,rentDue,collected,cost,fees,costEarned,
    profit:collected-cost, profitEarned:earned-costEarned};
}
/* kept for older callers: a unit's month, earned view */
function unitMonth(stays,txs,unit,mk){
  const r=rentalMonth({stays,txs},mk,unit);
  return {income:r.earned,cost:r.costEarned,profit:r.profitEarned,nights:r.nights};
}
/* units that could have been rented by the night in month `mk` — the occupancy divisor */
function unitsLiveIn(stays,mk){
  return new Set(stays.filter(st=>!st.cancelled && st.from.slice(0,7)<=mk).map(unitKey)).size;
}

/* other bookings of the same unit whose nights overlap `st`'s (checkout day is free for the next guest) */
function stayClashes(stays,st){
  const u=unitKey(st), a=st.from, b=stayOut(st);
  return stays.filter(x=>x.id!==st.id && !x.cancelled && unitKey(x)===u && x.from<b && stayOut(x)>a);
}
/* WhatsApp wants the number in international form: 010… → 2010… */
function waNumber(x){
  let d=normDigits(String(x||'')).replace(/\D/g,'');
  if(d.startsWith('00')) d=d.slice(2);
  if(d.startsWith('0')) d='20'+d.slice(1);
  return d.length>=10?d:'';
}

/* ═══════ what's due ═══════ */
/* open debts, upcoming expenses and unpaid rent that are late or due within `days` */
function dueItems({debts=[],plans=[],rents=[],stays=[],credits=[]},now,days=7){
  const t=iso(now), soon=iso(addDays(now,days)), out=[];
  for(const c of credits){ const left=creditLeft(c);
    if(left>0.005 && c.credit.due && c.credit.due<=soon)
      out.push({type:'credit',id:c.id,name:c.credit.vendor||c.note||'',date:c.credit.due,amount:left,late:c.credit.due<t}); }
  /* guests arriving within 3 days (or already in) who still owe part of the booking */
  const near=iso(addDays(now,3));
  for(const st of stays){
    const left=stayLeft(st), co=stayOut(st);
    if(left>0.005){
      /* a platform pays out after the guest arrives — only chase it once it's two weeks past checkout */
      if(isPlatform(st)&&!st.atProp){ const late=iso(addDays(parseISO(co),14));
        if(late<t) out.push({type:'stay',id:st.id,name:st.guest||st.unit||'',unit:st.unit||'',unitId:st.unitId||'',date:co,amount:left,late:true,payout:true}); }
      else if(st.from<=near)
        out.push({type:'stay',id:st.id,name:st.guest||st.unit||'',unit:st.unit||'',unitId:st.unitId||'',date:st.from,amount:left,late:st.from<t});
    }
    /* commission the platform will bill for a pay-at-property stay, from checkout on */
    const fee=stayFeeOwed(st);
    if(fee>0 && co<=soon)
      out.push({type:'fee',id:st.id,name:st.guest||st.unit||'',unit:st.unit||'',unitId:st.unitId||'',channel:st.channel,date:co,amount:fee,
        late:iso(addDays(parseISO(co),30))<t});
  }
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
/* a note worth remembering as a category keyword: its first words, no numbers */
function learnPhrase(note){
  const w=tokOf(normDigits(String(note||'')).replace(/\d+(\.\d+)?/g,' ')).filter(x=>norm(x).length>=2);
  if(!w.length || w.length>3) return '';
  return w.join(' ').slice(0,30);
}
/* amounts said in words — dictation writes «خمسين» or «ألف وخمسمية», not 50 / 1500.
   Keys are in norm() form (ة→ه, أ→ا). */
const NUM_W={
  'واحد':1,'واحده':1,'اتنين':2,'اثنين':2,'اتنان':2,'تلاته':3,'ثلاثه':3,'تلات':3,'ثلاث':3,'اربعه':4,'اربع':4,
  'خمسه':5,'خمس':5,'سته':6,'ست':6,'سبعه':7,'سبع':7,'تمانيه':8,'ثمانيه':8,'تمن':8,'تسعه':9,'تسع':9,'عشره':10,'عشر':10,
  'حداشر':11,'اتناشر':12,'تلتاشر':13,'اربعتاشر':14,'اربعطاشر':14,'خمستاشر':15,'خمسطاشر':15,'ستاشر':16,'سبعتاشر':17,'سبعطاشر':17,
  'تمنتاشر':18,'تمنطاشر':18,'تسعتاشر':19,'تسعطاشر':19,
  'عشرين':20,'تلاتين':30,'ثلاثين':30,'اربعين':40,'خمسين':50,'ستين':60,'سبعين':70,'تمانين':80,'ثمانين':80,'تسعين':90,
  'ميه':100,'مايه':100,'مائه':100,'ميت':100,'ميتين':200,'مايتين':200,'مئتين':200,'مائتين':200,
  'تلتميه':300,'تلاتميه':300,'ثلاثمائه':300,'ثلثمائه':300,'ربعميه':400,'اربعميه':400,'اربعمائه':400,
  'خمسميه':500,'خمسمائه':500,'ستميه':600,'ستمائه':600,'سبعميه':700,'سبعمائه':700,
  'تمنميه':800,'تمانميه':800,'ثمانمائه':800,'تسعميه':900,'تسعمائه':900,
  'الفين':2000,'الفان':2000
};
const NUM_MUL={'الف':1000,'الاف':1000,'الوف':1000,'مليون':1e6,'ملايين':1e6};
/* the first run of number words in `toks`: {value,start,end} (end exclusive), or null */
function wordNumber(toks){
  const key=w=>{ const n=norm(w); if(NUM_W[n]!=null||NUM_MUL[n]||n==='نص') return n;
    return n.length>2&&n.startsWith('و')&&(NUM_W[n.slice(1)]!=null||NUM_MUL[n.slice(1)]||n.slice(1)==='نص')?n.slice(1):''; };
  let i=toks.findIndex(t=>key(t)&&key(t)!=='نص'&&!(norm(t).startsWith('و')&&key(t)!==norm(t)));
  if(i<0) return null;
  const start=i; let total=0, cur=0, last=1;
  for(;i<toks.length;i++){
    const k=key(toks[i]); if(!k) break;
    if(k==='نص'){ cur+=last/2; continue; }
    if(NUM_MUL[k]){ total+=(cur||1)*NUM_MUL[k]; cur=0; last=NUM_MUL[k]; continue; }
    const v=NUM_W[k]; cur+=v; last=v>=1000?1000:v>=100?100:v>=10?10:1;
  }
  const value=total+cur;
  return value>0?{value,start,end:i}:null;
}
const REF_W=['مرتجع','رجعت','استرجاع','مردود'];
const INC_W=['دخل','قبضت','استلمت','مرتب','عموله','عمولات','ايجار','ارباح','حصلت'];

/* starter keywords for the default categories, by category name. Seeded into
   each category's editable `words` list once; a keyword that shows up in the
   text picks its category but stays in the note (unlike the category's name). */
const CAT_WORDS={
  'أكل وشرب':['فطار','فطور','غدا','غداء','عشا','عشاء','سحور','اكلة','وجبة','مطعم','كافيه','كافتيريا','قهوة',
    'كوفي','شاي','نسكافيه','كابتشينو','لاتيه','اسبريسو','موكا','ستاربكس','كوستا','سينابون','عصير','عصاير',
    'قصب','سوبيا','عرقسوس','تمر هندي','سحلب','مياه','ميه','مياة معدنية','بيبسي','كولا','كوكاكولا','سفن اب',
    'فانتا','ريد بول','ردبول','مشروب','مشروبات','حاجة ساقعة','فول','طعمية','فلافل','كشري','كشرى','شاورما',
    'بيتزا','برجر','هامبرجر','كريسبي','فرايز','بطاطس محمرة','كباب','كفتة','حواوشي','سندوتش','سندوتشات',
    'ساندوتش','ساندويتش','كبدة','سجق','مشويات','مشاوي','فطير','فطير مشلتت','كريب','سوشي','نودلز','مندي',
    'بيتزا هت','دومينوز','ماكدونالدز','ماك','كنتاكي','هارديز','بازوكا','مؤمن','كوك دور','بخيت','ابو طارق',
    'التابعي','بلبن','طلبات','دليفري','اورديلو','بريدفاست','حلواني','حلويات','بسبوسة','كنافة','قطايف','جاتوه',
    'تورتة','كيك','دونتس','وافل','ايس كريم','ايسكريم','جيلاتي','شيكولاتة','شوكولاتة','بونبون','لب','سوداني',
    'مكسرات','فشار','ترمس','حمص الشام','شيبسي','بسكويت','سناكس','مقرمشات','كورن فليكس','عيش','خبز','عيش بلدي',
    'عيش فينو','فينو','توست','جبنة','جبن','رومي','لبن','زبادي','رايب','زبدة','سمنة','قشطة','بيض','عسل','مربى',
    'حلاوة','طحينة','تونة','بلوبيف','لانشون','بسطرمة','لحمة','لحم','فراخ','فرخة','دجاج','بانيه','ديك رومي',
    'بط','سمك','جمبري','كابوريا','سبيط','فيليه','بلطي','بوري','كبده','خضار','خضروات','فاكهة','فاكهه','طماطم',
    'بطاطس','بصل','توم','خيار','جزر','كوسة','باذنجان','فلفل','ليمون','موز','تفاح','برتقال','عنب','مانجا',
    'بطيخ','فراولة','بلح','تمر','رز','ارز','مكرونة','مكرونه','دقيق','سكر','زيت','ملح','شاي ليبتون','عدس',
    'فاصوليا','لوبيا','بسلة','بقوليات','توابل','بهارات','صلصة','كاتشب','مايونيز','بقالة','سوبرماركت',
    'سوبر ماركت','ماركت','هايبر','كارفور','سبينيس','خير زمان','اولاد رجب','فتح الله','بيم','كازيون',
    'ميترو ماركت','جملة ماركت','لولو','تموين','جزار','فكهاني','خضري','فرارجي','سماك','فرن','مخبز','لبان',
    'ميني ماركت','كشك','فطار الصبح','فطاري','غدايا','عشايا','لقمة','اكل بره','اكل البيت','تيك اواي','اوردر',
    'طلبية اكل','مطاعم','كافيهات','قهوه تركي','قهوة فرنساوي','نسكافيه بلاك','شاي بلبن','ينسون','كركديه',
    'نعناع','حلبة','ليمون نعناع','موهيتو','سموذي','ميلك شيك','فرابيه','مشروب طاقة','مية','ازازة مية','كانز',
    'فطيرة','ليتل سيزر','باباجونز','دومينوز بيتزا','ماكدونالد','برجر كينج','بافلو برجر','جاد','بخيت وعثمان',
    'الشبراوي','ابو مازن','ابو حيدر','زعبلاوي','كشري التحرير','حمزاوي','صبحي كابر','حاتي','كبابجي','كفتجي',
    'شيف','طاجن','طواجن','محشي','ورق عنب','ملوخية','بامية','مسقعة','صينية','فتة','ممبار','كوارع','رقاق',
    'مكرونة بشاميل','بشاميل','رز بلبن','مهلبية','ام علي','بلح الشام','زلابية','لقمة القاضي','كحك','بسكوت',
    'غريبة','بيتي فور','سميط','بقسماط','عيش شامي','عيش سن','كيزر','باتون ساليه','كرواسون','دونات','مافن',
    'كب كيك','شيز كيك','تشيز كيك','بقلاوة','جلاش','فايش','شاورما فراخ','شاورما لحمة','فراخ مشوية',
    'فراخ بانيه','كريسبي فراخ','استربس','ناجتس','هوت دوج','كبدة اسكندراني','سجق اسكندراني','فول وطعمية',
    'بيض اومليت','شكشوكة','عيش وجبنة','جبنة بيضا','جبنة رومي','جبنة نستو','جبنة شيدر','جبنة قريش','مش','لبنة',
    'حليب','لبن جهينة','جهينة','المراعي','دومتي','لمار','بخيرة','عبور لاند','جبنة فيتا','بيض بلدي',
    'كرتونة بيض','طبق بيض','لحمة مفرومة','مفروم','كفتة نية','ريش','موزة','كتف','فخدة','اوراك','صدور','وراك',
    'كبد وقوانص','حمام','ارانب','بط مسكوفي','سمك بلطي','سمك بوري','سردين','ماكريل','رنجة','فسيخ','ملوحة',
    'تونة قطع','جمبري مقلي','كاليماري','بطارخ','خضرة','جرجير','بقدونس','كزبرة','شبت','خس','كرنب','قرنبيط',
    'سبانخ','ملوخية خضرا','بطاطا','قلقاس','بنجر','فجل','ذرة','فاكهة الصيف','جوافة','رمان','خوخ','مشمش',
    'كمثرى','كيوي','يوسفي','تين','كانتلوب','شمام','اناناس','بلح زغلول','عصير قصب','فول سوداني','لب سوري',
    'لب ابيض','حمص','عين جمل','لوز','بندق','كاجو','فستق','زبيب','ياميش','قمر الدين','تمر رمضان','شوربة',
    'شوربة عدس','مرقة','ماجي','صلصة طماطم','خل','كمون','شطة','فلفل اسود','قرفة','فانيليا','بيكنج باودر',
    'خميرة','نشا','كاكاو','نوتيلا','مربي','جبنة مثلثات','بسكويت شاي','ويفر','كيت كات','جالكسي','كادبوري',
    'مارس','سنيكرز','تويكس','دوريتوس','تايجر','بيك رولز','كرانشي','مولتو','تودو','باتون','ايس كريم نستلة',
    'كاندي','علكة','اكل قطط','اكل الكلب','بقالة الشهر','طلبات البيت','خزين','تموين الشهر','فرق التموين',
    'عيش التموين','سلع تموينية','سوق الخضار','سوق السمك','حلقة السمك','الجمعية الاستهلاكية','سعودي ماركت',
    'هايبر وان','كارفور ماركت','سبينيس ماركت','مترو ماركت','كازيون ماركت','بيم ماركت','ابا زيد','الراية',
    'جوردن ماركت','اوسكار','زهران ماركت','المحلاوي','العبد','الحلواني','لابوار','تسيباس','مونجيني','اوتيكو',
    'عم شلتوت','كنافة وبسبوسة','اكل','الاكل','أكلة حلوة','ساندويتشات','سندوتش فول','سندوتش طعمية','طبق فول',
    'طبق كشري','علبة كشري','كشري سادة','فول بالزيت','فول اسكندراني','فول بالسجق','طعمية محشية','بابا غنوج',
    'باذنجان مخلل','مخلل','طرشي','سلطة','سلطات','سلطة خضرا','طحينة سلطة','حمص بالطحينة','متبل','تبولة','فتوش',
    'ورق عنب سوري','شيش طاووق','فراخ شيش','كباب حلة','لحمة راس','لسان','كوارع وممبار','فشة','طحال','مخ',
    'كلاوي','حلويات شرقي','بسبوسة بالقشطة','كنافة بالمانجا','كنافة نابلسية','قطايف بالمكسرات','ارز بلبن',
    'بليلة','عاشورا','رز معمر','فطير بالعسل','فطير حلو','فطير حادق','بيتزا فطاطري','فطاطري','الفطاطري',
    'كبدة سوري','شاورما سوري','شاورما عربي','فتة شاورما','كريب حلو','كريب حادق','وافل نوتيلا','بان كيك',
    'مولتن كيك','براونيز','كوكيز','ايس كوفي','كولد برو','فرابتشينو','هوت شوكليت','شاي اخضر','شاي كرك','كرك',
    'قهوة مظبوط','قهوة سادة','قهوة زيادة','كوباية شاي','كوباية قهوة','فنجان قهوة','تيك اواي قهوة','مشروب سخن',
    'مشروب ساقع','عصير مانجا','عصير فراولة','عصير برتقال','عصير ليمون','عصير جوافة','كوكتيل','افوكادو',
    'عصير موز باللبن','زبادي فواكه','ريد بول طاقة','باور هورس','ستينج','مياه غازية','صودا','شويبس','ميرندا',
    'كوكا','بيبسي دايت','مياه نستلة','مياه بركة','مياه صافي','ايلانو','دسانی','جبنة اسطنبولي','جبنة براميلي',
    'جبنة دبل كريم','جبنة موتزاريلا','موتزاريلا','بارميزان','جبنة كيري','لافاش كيري','بيبي بل','زبدة بلدي',
    'سمنة بلدي','سمن','زيت زيتون','زيت عباد','زيت ذرة','كريستال','عافية','الطيبين','رز مصري','رز بسمتي',
    'مكرونة اسباجتي','اسباجتي','مكرونة قلم','شعرية','لسان عصفور','دقيق فاخر','سكر ناعم','سكر بني','ملح طعام',
    'شاي العروسة','شاي احمد','ليبتون','بن برازيلي','بن محوج','نسكافيه جولد','كوفي ميت','كريمة طبخ',
    'كريمة خفق','لبن بودرة','لبن مكثف','صلصة جهينة','هاينز','كاتشب هاينز','مستردة','صوص','صوص باربكيو',
    'جبنة شيدر سايحة','بانيه جاهز','فراخ مجمدة','لحمة مجمدة','خضار مجمد','بسلة مجمدة','بطاطس مجمدة',
    'بيتزا مجمدة','سوسيس','ناجتس مجمد','برجر مجمد','كفتة مجمدة','تونة صن شاين','سردين علب','فول مدمس علب',
    'فول علب','حمص علب','ذرة علب','زيتون اسود','زيتون اخضر','مربى فراولة','عسل نحل','عسل اسود','حلاوة طحينية',
    'الرشيدي','العبد حلويات','بسكويت بيتي بان','بيمبو','اولكر','كيك تودو','مولتو ماجنوم','شيكولاتة كورونا',
    'كورونا','بونبوني','ابو حمزة','هوهوز','توينكيز','تشيبس','شيبسي عائلي','فشار ميكروويف','مقرمشات كرانشي',
    'لب وسوداني','مكسرات العيد','عصير رمضان','تمور','تمر سكري','تمر سيوي','خشاف','قمر دين','فانوس شيكولاتة',
    'فطار رمضان','سحور رمضان','اكل العزومة','عزومة','عزومة اكل','غدا عمل','غدا شغل','اكل الشغل','فطار الشغل',
    'بوفيه مفتوح','اوبن بوفيه','مطعم فندق','مطعم سمك','مطعم مشويات','شاورمجي','كشرجي','فوال','فول وفلافل',
    'عربية فول','عربية كبدة','اكل شارع','فاست فود','بيتزا كينج','شيكن فيلا','تشيكن تكا','كوك دور سندوتش',
    'ماكدونالدز وجبة','وجبة توفير','وجبة اطفال','باكت فراخ','بوكس','قهوة الصبح','شاي الصبح','فطار المدرسة',
    'سندوتشات المدرسة'],
  'مواصلات':['مواصلة','اوبر','ديدي','اندرايف','سويفل','بلت','تاكسي','ميكروباص','مكروباص','ميكرو','توكتوك',
    'تكتك','اتوبيس','اوتوبيس','باص','مترو','ترام','مونوريل','قطر','قطار','سكة حديد','سوبرجيت','جو باص',
    'بلو باص','عبارة','معدية','مركب','طيارة','طيران','تذكرة طيران','بنزين','بنزينة','سولار','جاز',
    'محطة بنزين','عربية','عربيه','العربية','موتوسيكل','موتوسكل','سكوتر','عجلة','دراجة','موقف','جراج','ركنة',
    'باركينج','سايس','كارتة','بوابة','تذكرة','تذاكر','ميكانيكي','مكانيكي','ميكانيكا','كهربائي سيارات','سمكري',
    'دوكو','كاوتش','كاوتشات','اطار','بطارية العربية','زيت العربية','تغيير زيت','فلتر','فرامل','تيل',
    'غسيل العربية','مغسلة','ترخيص','رخصة','مخالفة','مخالفات','مرور','سواق','سائق','نقل','ونش','قسط العربية',
    'تأمين العربية','اوبار','كريم كار','دي دي','ان درايف','بولت','تاكسي ابيض','تاكسي اصفر','تاكس','ميكروباس',
    'ميني باص','سرفيس','سيرفس','توناية','اتوبيس نقل عام','اتوبيس مكيف','النقل العام','مترو الانفاق',
    'كارت المترو','اشتراك المترو','تذكرة مترو','شحن كارت المترو','القطار الكهربائي','قطر الصعيد',
    'القطر السريع','تذكرة قطر','حجز قطر','قطار النوم','اتوبيس سفر','سوبر جيت','شرق الدلتا','غرب الدلتا',
    'الاتوبيس','عربية نقل','ربع نقل','تروسيكل','حنطور','فلوكة','تذكرة طيارة','مصر للطيران','المطار',
    'تاكسي المطار','شنط السفر','وزن زيادة','فول تانك','تفويل','بنزينه','محطة وطنية','موبيل','توتال','شل',
    'اكسون','شيل اوت','كاوتش جديد','ترصيص','ضبط زوايا','ميزان','تيل فرامل','بوجيهات','بوجيه','سير','طلمبة',
    'رادياتير','تكييف العربية','فريون','دبرياج','عفشة','مساعدين','شكمان','بطارية','فانوس','زجاج العربية',
    'فيميه','تلميع','تنظيف العربية','غسيل وتشحيم','تشحيم','كارتة الطريق','كارتة الصحراوي',
    'كارتة العين السخنة','بوابة الدفع','رسوم طريق','جراج العمارة','ركنة العربية','سايس الجراج','ونش انقاذ',
    'توكيل','صيانة دورية','الكشف الفني','فحص العربية','رخصة العربية','رخصة القيادة','تجديد الرخصة',
    'مخالفات المرور','نيابة المرور','اشتراك الجراج','قسط عربية','تأمين عربية','بنزين الموتوسيكل',
    'صيانة الموتوسيكل','عجلة جديدة','اسكوتر','مواصلات الشغل','مواصلات الجامعة','مواصلات المدرسة','اجرة',
    'الاجرة','أجرة التاكسي','اجرة الميكروباص','توصيلة','توصيل','مشوار','مشاوير','رايح جاي','رايح وجاي',
    'اوبر الشغل','اوبر البيت','تاكسي البيت','كريم تاكسي','سواق خاص','سواق العربية','كابتن اوبر',
    'اسكوتر كهربا','دراجة نارية','موتوسيكل دليفري','مشوار المطار','باص المطار','اتوبيس المطار',
    'اتوبيس الجامعة','باص الشغل','باص الشركة','اشتراك باص الشغل','تذكرة اتوبيس','تذكرة ترام','تذكرة القطر',
    'القطر الروسي','القطر المكيف','التالجو','قطار تالجو','الدرجة الاولى','الدرجة التانية','سفر بالقطر',
    'تذكرة سفر','حجز اتوبيس','ميكروباص سفر','بيجو','بيجو سفر','معدية النيل','عبارة السويس','كوبري',
    'رسوم كوبري','الطريق الدائري','الطريق الاقليمي','الصحراوي','الزراعي','طريق السويس','كمين','غسيل عربية',
    'تلميع عربية','تغيير كاوتش','كاوتش احتياطي','استبن','جنط','جنوط','كفر','كفرات','ميكانيكي العربية',
    'كهربائي العربية','سمكرة','دوكو العربية','رش دوكو','تصليح العربية','صيانة العربية','قطع غيار','قطعة غيار',
    'اسبير','اسبيرات','مساحات','مساحات العربية','زيت فرامل','زيت فتيس','مية رادياتير','فلتر هوا','فلتر زيت',
    'فلتر بنزين','كاربراتير','انجكشن','تيل امامي','كاوتش امامي','شمعات','حساس','كمبيوتر العربية',
    'فحص كمبيوتر','اكسسوارات عربية','فرش عربية','كفر كراسي','معطر عربية','شاشة عربية','كاميرا خلفية',
    'حساسات ركن','جهاز انذار','تأمين ضد الغير','رخصة مرور','تجديد رخصة العربية','لوحات','نمر العربية',
    'تحويل نمر','توكيل بيع','شهر العربية','ركنة الشارع','الباركينج','سايس الشارع','جراج المول','جراج المستشفى'],
  'بيت ومعيشة':['شقة','منظفات','صابون','صابونة','مسحوق','اريال','برسيل','تايد','داوني','كلور','فلاش','ديتول',
    'ريحة','معطر','مناديل','فاين','ورق تواليت','ورق مطبخ','شامبو','بلسم','معجون','فرشة سنان','موس','شفرات',
    'مزيل','ليفة','اسفنجة','جوانتي','اكياس','اكياس زبالة','فوط','مقشة','جاروف','مساحة','ممسحة','سلك مواعين',
    'سائل اطباق','فيري','اثاث','عفش','نجار','سباك','كهربائي','نقاش','دهان','محارة','سيراميك','الوميتال',
    'صيانة','تصليح','تركيب','فني','بواب','حارس','شغالة','خدامة','عاملة نظافة','مكوجي','مكوة','غسيل',
    'دراي كلين','مطبخ','حلة','طاسة','اطباق','كوبايات','معالق','ادوات منزلية','ستاير','ستارة','سجاد','سجادة',
    'مفروشات','ملايات','بطانية','لحاف','مخدة','سرير','دولاب','كنبة','انتريه','سفرة','لمبة','لمبات','كشاف',
    'فيشة','وصلة','بطاريات','اسانسير','العمارة','صيانة العمارة','حاجات البيت','مستلزمات البيت','زرع','نباتات',
    'ايكيا','هوم سنتر','ايس','تلاجة','غسالة','بوتاجاز','سخان','تكييف','مروحة','مكنسة','خلاط','ميكروويف',
    'فرن كهربا','مبيد','رش','المنزل','الشقه','منظف','منظف ارضيات','منظف حمامات','منظف زجاج','سافو','سافولون',
    'كلوركس','هاربيك','بريل','فيري اطباق','ريكس','اوكسي','برسيل جل','اريال جل','مسحوق غسيل','منعم','كومفورت',
    'صابون لوكس','صابون ديتول','صابون سائل','شاور جل','معجون سنان','سيجنال','كولجيت','فرشة','فرش سنان',
    'مزيل عرق','ريكسونا','ماكينة حلاقة','جيليت','كريم حلاقة','فوطة','مناشف','بشكير','مناديل وجه','مناديل جيب',
    'مناديل حمام','زينة','كلينكس','فاين مناديل','ورق فويل','فويل','ورق زبدة','استرتش','اكياس تجميد',
    'علب بلاستيك','سلة زبالة','صفيحة زبالة','جردل','مساحة ارض','شرشوبة','فرشة سجاد','منفضة','سبراي','بف باف',
    'رايد','ناموسية','مصيدة','صراصير','فئران','رش حشرات','تعفير','مكافحة حشرات','سباكة','حنفية','خلاط مية',
    'سيفون','بالوعة','تسليك','مواسير','كهربا البيت','سلك','مفتاح كهربا','بريزة','كوبس','نجف','اباجورة',
    'ابليك','ليد','نجارة','باب','شباك','قفل','كالون','مفتاح','نسخ مفتاح','زجاج','مراية','رخام','بلاط','جبس',
    'جبس بورد','ورق حائط','دهانات','بوية','معجون حيطة','عزل','سطوح','خزان','موتور مية','طلمبة مية','فلتر مية',
    'شمعة فلتر','ريكسون','جهاز تنقية','سخان غاز','سخان كهربا','بوتجاز','شفاط','مكيف','صيانة التكييف',
    'فريون التكييف','صيانة التلاجة','صيانة الغسالة','فني غسالات','فني تلاجات','فني تكييف','غسالة اطباق',
    'ديب فريزر','فريزر','مكواة','مكوة بخار','خلاط كهربا','كبة','محضر طعام','كاتل','غلاية','ماكينة قهوة',
    'توستر','قلاية هوائية','اير فراير','شواية','حلة ضغط','طقم حلل','طقم اطباق','طقم كوبايات','صواني','بايركس',
    'ترامس','ادوات مطبخ','سكاكين','لوح تقطيع','مصفاة','طقم ملايات','كوفرته','كوفرتة','مفرش','مفارش','وسادة',
    'مخدات','ستارة حمام','دواسة','كليم','موكيت','رف','رفوف','ترابيزة','كرسي','كراسي','نيش','بوفيه','جزامة',
    'شماعة','شماعات','علاقة','مرايه','ديكور','تابلوه','فازة','زرع البيت','اصيص','سماد','جنينة','جناينى',
    'حارس العمارة','فلوس البواب','الزبال','عامل النظافة','شغالة البيت','دادة','مربية','جليسة','غسيل سجاد',
    'غسيل ستاير','مغسلة هدوم','نقل عفش','ونش عفش','عتال','شيال','المعيشة','مصاريف البيت','مصروف البيت',
    'احتياجات البيت','طلبات المنزل','تشطيب','تشطيبات','تشطيب الشقة','مقاول','صنايعي','صنايعية','عامل','عمال',
    'يومية عامل','اسمنت','رمل','طوب','حديد تسليح','خشب','الواح','سقف معلق','بلاط حمام','سيراميك مطبخ',
    'بورسلين','رخام مطبخ','جرانيت','حوض','حوض مطبخ','بانيو','شاور','دش حمام','كابينة شاور','قاعدة حمام',
    'تواليت','شطاف','صرف','مواسير مية','جلبة','محبس','عوامة السيفون','سخان شمسي','عزل سطح','عزل مية','تسريب',
    'رطوبة','نش','ترميم','شباك المنيوم','باب خشب','باب حديد','باب مصفح','كالون باب','سلك شباك','سلك ناموس',
    'شيش','شيش حصيرة','ستارة رول','بلاك اوت','ورق جدران','تابلوهات','ساعة حيطة','رف كتب','مكتبة خشب',
    'دولاب هدوم','تسريحة','كومودينو','سرير اطفال خشب','مرتبة سرير','مراتب','ملاية','لحاف شتوي','بطانية شتوي',
    'كوفرتات','فوط حمام','طقم فوط','بشاكير','دواسة حمام','سجاد مطبخ','موكيت ارض','باركيه','فينيل','دهان شقة',
    'نقاشة','دهانات جوتن','جوتن','سايبس','دهان بلاستيك','دهان زيت','معجون جدران','صنفرة','فرشة دهان','رولة',
    'سلم','شنيور','عدة','صندوق عدة','مفك','شاكوش','مسامير','مسمار','خوابير','سيليكون','لاصق','شريط لاصق',
    'كهرباء الشقة','لوحة كهربا','قاطع','ديجنتير','سلك كهربا','مفاتيح كهربا','فيش وبرايز','كشافات ليد',
    'سبوت لايت','اضاءة','نجفة','شمعة','مولد كهربا','ماتور','يو بي اس','مثبت جهد','منظم كهربا','حامي اجهزة',
    'شاشة بيت','ريموت','ريموت تكييف','بطارية ريموت','حامل شاشة','رف شاشة','فلتر تكييف','تنظيف تكييف',
    'شحن فريون','تركيب تكييف','فك وتركيب','تركيب ستاير','تركيب نجف','صيانة سخان','صيانة بوتاجاز','تسليك حوض',
    'تسليك بالوعة','صيانة موتور','تغيير محبس','مكنسة كهربا','مكنسة شحن','روبوت مكنسة','مكوة هدوم','منشر',
    'منشر غسيل','مشابك','حبل غسيل','سبت غسيل','سلة غسيل','معطر غسيل','مزيل بقع','فانيش','كلوركس الوان',
    'منظف فرن','جل ديتول','معطر جو','جليد','فواحة','شموع معطرة','بخور البيت','معطر حمام','مكعبات تواليت',
    'حجر سيفون','مسلك','فرشة تواليت','سلة حمام','ليفة مواعين','سلك مطبخ','فوطة مطبخ','جوانتي مطبخ',
    'مريلة مطبخ','اكياس ساندوتش','علب حفظ','برطمانات','بلاستيكات','ادوات بلاستيك','صحون','صحن','كاسات',
    'فناجين','طقم شاي','طقم قهوة','صينية تقديم','كاتل كهربا','ابريق','شفشق','كنكة','مصفاة شاي','مغرفة','مضرب',
    'فتاحة علب','مقص مطبخ','مبشرة','هراسة','مفرمة','فرامة','ميزان مطبخ','شنطة تسوق','عربية سوق',
    'كيس زبالة اسود','مخزن','كرتونة تخزين'],
  'الولد':['ولد','الواد','بنت','البنت','عيال','العيال','اطفال','الاطفال','طفل','بيبي','رضيع','بامبرز',
    'حفاضات','مولفكس','لبن اطفال','لبن صناعي','سيريلاك','ببرونة','بزازة','سكاته','مناديل مبللة','حضانة',
    'نيرسري','مدرسة','المدرسة','مدارس','مصاريف المدرسة','مصاريف مدرسة','باص المدرسة','شنطة المدرسة',
    'يونيفورم','زي المدرسة','دروس','درس','درس خصوصي','مدرس','مدرسة خصوصي','سنتر','مجموعة','كتب','كتاب',
    'كتب خارجية','كراسات','كشكول','ادوات مدرسية','ادوات مكتبية','مكتبة','اقلام','الوان','رحلة المدرسة','لعب',
    'لعبة','العاب','ليجو','عروسة','بلاي ستيشن العيال','تمرين','تمارين','سباحة','كورة','اكاديمية','كاراتيه',
    'جمباز','باليه','كورس','كورسات','حضانه','دكتور اطفال','تطعيم','تطعيمات','هدوم العيال','لبس العيال','كيدز',
    'مصروف','مصروف العيال','عيد ميلاد','ابني','بنتي','ولادي','العيل','الاولاد','الصغير','الصغيرة','النونو',
    'المولود','مولود','ولادة','سبوع','شنطة السبوع','هدوم بيبي','لبس بيبي','حفاضة','بامبرز مقاس','فاين بيبي',
    'بيبي جوي','مولفكس بيبي','مناديل بيبي','كريم بيبي','بودرة بيبي','شامبو اطفال','صابون اطفال','لبن بيبي',
    'لبن ابتاميل','ابتاميل','بيبلاك','نان','سيميلاك','بيبيلاك','سيريلاك بيبي','رضعة','ببرونات','سكاتة',
    'عضاضة','مشاية','عربية اطفال','كرسي عربية','سرير اطفال','مهد','كاروسة','بامبرز ليلي','حضانة الولد',
    'مصاريف الحضانة','ميس','ميس الحضانة','المدرسة الخاصة','مدرسة لغات','مدرسة انترناشونال','مصاريف دراسية',
    'القسط الدراسي','قسط المدرسة','تقديم المدرسة','كتب المدرسة','كتب الوزارة','الاضواء','سلاح التلميذ',
    'المعاصر','الامتحان','كتب الامتحان','ملازم','ملزمة','مذكرات','شيت','شيتات','مراجعة','مراجعات',
    'ليلة الامتحان','حصة','حصص','مدرس خصوصي','مدرس رياضيات','مدرس انجليزي','مدرس عربي','سنتر الدروس',
    'اشتراك السنتر','مجموعة تقوية','تحفيظ','قرآن','مدارس الاحد','شنط مدرسة','لانش بوكس','زمزمية','مقلمة',
    'استيكة','براية','مسطرة','الوان خشب','الوان مية','صلصال','كراسة رسم','جلاد','تجليد','ادوات هندسية',
    'الة حاسبة','يونيفورم المدرسة','مريلة','جزمة المدرسة','رحلة مدرسية','اشتراك باص','باص الحضانة','زي رياضي',
    'تمرين الكورة','تمرين السباحة','اشتراك التمرين','كابتن','اكاديمية كورة','جودو','تايكوندو','كونغ فو',
    'شطرنج','رسم','موسيقى','بيانو','جيتار','كورس انجليزي','كورس برمجة','اونلاين كورس','العاب اطفال','عرايس',
    'باربي','عربيات لعب','بازل','دبدوب','كيدز اريا','ملاهي اطفال','العاب اطفال مول','هدية الولد',
    'عيد ميلاد الولد','تورتة عيد ميلاد','حفلة عيد ميلاد','بالونات','دكتور الاطفال','تطعيمات الولد',
    'فيتامينات اطفال','شراب اطفال','مصروف الولد','مصروف البنت','مصروف المدرسة','هدوم الولاد','لبس الولاد',
    'جزمة الولد','لبس العيد للعيال','الطفل','الطفلة','العيال الصغيرين','ولدي','بناتي','ولادي الصغيرين','طفلي',
    'بيبي البيت','حمام بيبي','بانيو بيبي','ترمومتر بيبي','شفاط مناخير','مرهم تسلخات','كريم تسلخات',
    'بودرة تلك','زيت جونسون','جونسون','شامبو جونسون','مناديل مبلولة','بامبرز بيبي','حفاضات بيبي',
    'مقاس حفاضات','لبن تكميلي','لبن المرحلة','سيريلاك موز','بيبي فود','اكل بيبي','بريه','بيوريه','كرسي اكل',
    'كرسي اطفال','مريلة اكل','ببرونة زجاج','سكاتة بيبي','كيس بيبي','شنطة بيبي','حمالة بيبي','كانجارو',
    'اتوبيس الحضانة','مصاريف الكي جي','كي جي','كي جي وان','كي جي تو','تمهيدي','ابتدائي','اعدادي','ثانوي',
    'ثانوية عامة','تالتة ثانوي','تانية ثانوي','اولى ثانوي','سنة اولى','الجامعة','جامعة','مصاريف الجامعة',
    'كلية','مصاريف الكلية','تنسيق','تقديم الجامعة','كتب الجامعة','ملازم الجامعة','مذكرات الكلية',
    'مصروف الجامعة','سكن جامعي','المدينة الجامعية','سكن الطلبة','اشتراك المكتبة','كتاب مدرسي','كتب ابتدائي',
    'كتاب الامتحان','كتاب المعاصر','كراسة','كشاكيل','دفتر','دفاتر','قلم رصاص','اقلام جاف','اقلام الوان',
    'فلوماستر','الوان شمع','الوان باستيل','كوريكتور','مسطرة وبراية','برجل','منقلة','شنطة الدروس',
    'تابلت المدرسة','تابلت الثانوية','لاب الطالب','اشتراك منصة','منصة تعليمية','كورس اونلاين','حصة اونلاين',
    'مدرس اونلاين','مجموعات','مجموعة مدرسة','درس فيزيا','درس كيميا','درس احيا','درس ماث','درس انجلش',
    'درس فرنساوي','درس الماني','درس عربي','مدرس فيزيا','مدرس كيميا','فلوس الدرس','حساب الدرس','شهر الدرس',
    'حصة المراجعة','المراجعة النهائية','امتحانات','نتيجة','شهادة الولد','حفلة المدرسة','يوم رياضي',
    'رحلة الحضانة','زي الحضانة','يونيفورم الحضانة','شراب مدرسة','جزمة مدرسة','كوتشي مدرسة','شنطة تروللي',
    'لانش المدرسة','ساندوتش المدرسة','كانتين','كانتين المدرسة','مصروف يومي','مصروف الشهر للعيال',
    'العاب فيديو للعيال','بلاي دو','صلصال اطفال','تلوين','كتاب تلوين','قصص اطفال','قصص','مجلة ميكي','ميكي',
    'عجلة اطفال','سكوتر اطفال','تروسيكل اطفال','عربية شحن اطفال','مسدس مية','كورة قدم','كورة سلة',
    'تمرين كورة سلة','تمرين تنس','تمرين اسكواش','تمرين جمباز','تمرين كاراتيه','حزام كاراتيه','بدلة كاراتيه',
    'مايوه اطفال','نضارة سباحة','كاب سباحة','اشتراك تمرين السباحة','النادي للعيال','كامب صيفي','نادي صيفي',
    'سمر كامب','حضانة صيفي','كورس صيفي','دكتور اسنان اطفال','تقويم الولد','نضارة الولد','علاج الولد',
    'دوا الولد','تطعيم المدرسة','كشف الحضانة','حلاقة الولد','قص شعر الولد'],
  'فواتير':['فاتورة','فواتير','كهربا','كهرباء','الكهربا','نور','عداد','عداد الكهربا','كارت الكهربا',
    'عداد مسبق الدفع','شحن العداد','مياه البيت','فاتورة الميه','فاتورة المياه','عداد الميه','غاز','الغاز',
    'انبوبة','انبوبه','فاتورة الغاز','نت','انترنت','واي فاي','وايفاي','راوتر','باقة','باقة النت','رصيد',
    'كارت شحن','كروت شحن','شحن','شحن رصيد','فكة','فودافون','فودافون كاش','اورنج','اتصالات','وي','تليفون',
    'تليفون ارضي','ارضي','خط','موبايل الشهر','اشتراك','اشتراكات','قسط','اقساط','تقسيط','فاليو','سهولة',
    'كونتكت','امان','تامين','تأمين','تامينات','ضرايب','ضريبة','عقارية','زبالة','نظافة','رسوم نظافة','دش',
    'ريسيفر','اشتراك الدش','تجديد','صيانة الاسانسير','اتحاد ملاك','فوري','ممكن','مدفوعات','الفاتورة',
    'فاتورة الكهربا','فاتورة الكهرباء','فاتورة النور','كهربا الشهر','شحن الكهربا','كارت كهربا','كارت العداد',
    'عداد الكارت','عداد كودي','كود العداد','ممارسة','فاتورة المية','مياه الشرب','الصرف الصحي',
    'شحن عداد المية','كارت المية','الغاز الطبيعي','عداد الغاز','شحن الغاز','كارت الغاز','فاتورة غاز',
    'انبوبة بوتاجاز','تغيير انبوبة','فاتورة النت','فاتورة الانترنت','نت البيت','النت الارضي','الراوتر',
    'باقة انترنت','باقة موبايل','باقة الموبايل','تجديد الباقة','فليكس','كارت فكة','كارت فودافون','كارت اورنج',
    'كارت اتصالات','كارت وي','شحن فودافون','شحن اورنج','شحن اتصالات','شحن وي','رصيد موبايل','تحويل رصيد',
    'سلفني شكرا','فاتورة الموبايل','فاتورة التليفون','فاتورة الارضي','المصرية للاتصالات','تليفون البيت',
    'خط ارضي','خط موبايل','خط جديد','شريحة','اشتراك شهري','اشتراك سنوي','الاشتراك','قسط شهري','قسط الشهر',
    'القسط','قسط التلاجة','قسط الموبايل','قسط الغسالة','قسط التكييف','قسط القرض','قرض البنك','قسط البنك',
    'مصاريف البنك','رسوم البنك','مصاريف الكارت','رسوم الكارت','كارت الائتمان','الكريدت','تقسيط بنكي',
    'فاليو قسط','سهولة قسط','كونتكت قسط','تمويل','تأمين صحي','تأمين حياة','تأمين البيت','تأمينات اجتماعية',
    'التأمينات','الضريبة العقارية','ضريبة دخل','الضرايب','رسوم الزبالة','فلوس الزبالة','الزبال الشهري',
    'كارت الدش','بي ان','بي ان سبورت','اشتراك القنوات','كاميرات','اشتراك الكاميرات','صيانة المصعد',
    'الاسانسير الشهري','فلوس العمارة','مصاريف العمارة','صندوق العمارة','اتحاد الملاك','الحارس الشهري',
    'فوري دفع','دفع فاتورة','سداد فاتورة','سداد قسط','فاتورة الشهر','الفواتير','سداد الفواتير','دفع الفواتير',
    'فواتير البيت','الكهربا الشهرية','شحن كارت الكهربا','استهلاك الكهربا','عداد الشقة','عداد المحل',
    'فاتورة مياه','الميه الشهرية','استهلاك المية','شحن عداد الغاز','فاتورة غاز طبيعي','الغاز الشهري',
    'انبوبة غاز','تبديل انبوبة','نت المنزل','باقة النت الارضي','تجديد النت','كارت نت','باقة جيجا','جيجا',
    'ميجا','ميجابايت','باقة دقايق','دقايق','باقة سوشيال','باقة واتساب','كارت فكة فودافون','فليكس فودافون',
    'ريد فودافون','فودافون ريد','اورنج بريميير','اتصالات اموشن','وي جولد','ماي وي','انا فودافون',
    'فاتورة الخط','الخط الشهري','اشتراك الخط','شحن الخط','شحن رصيد اورنج','شحن رصيد اتصالات','شحن رصيد وي',
    'رصيد الموبايل','فك رصيد','كروت','كارت ابو عشرة','كارت ابو خمسة','كارت ابو عشرين','دفع الكارت',
    'سداد الكارت','الحد الادنى','سداد البطاقة','بطاقة الائتمان','كريدت كارد','كارت مشتريات','قسط البطاقة',
    'فوايد الكارت','رسوم سنوية','رسوم اصدار','رسوم سحب','قسط الشقة','قسط الارض','قسط الجهاز','قسط اللاب',
    'قسط الايفون','قسط النادي','قسط المدرسة الشهري','سداد قرض','قسط تمويل','تمويل شخصي','تمويل عقاري',
    'ايصال امانة','كمبيالة','كمبيالات','شيك','شيكات','تأمين طبي','بوليصة','بوليصة تأمين','قسط التأمين',
    'تأمين السيارة','تأمين على الحياة','معاش التأمينات','تأمينات العمال','الضريبة','ضريبة القيمة المضافة',
    'ضريبة المبيعات','ضريبة كسب العمل','اقرار ضريبي','محاسب ضرايب','رسوم المحليات','الحي','رسوم الحي',
    'النظافة الشهرية','كهربا السلم','نور السلم','مية العمارة','موتور العمارة','فلوس الموتور',
    'صيانة العمارة الشهرية','اشتراك الامن','اشتراك الحراسة','انترنت العمارة','دش العمارة',
    'اشتراك انترنت العمارة','اشتراك يانجو','اشتراك جوجل','جوجل ون','ايكلاود','اشتراك ابل','اشتراك مايكروسوفت',
    'اوفيس','اشتراك برنامج','استضافة','دومين','اشتراك سنوي برنامج'],
  'صحة':['دكتور','دكتورة','د.','طبيب','دكتورة اسنان','كشف','كشف دكتور','استشارة','عيادة','مستشفى','مستشفي',
    'طوارئ','اسعاف','صيدلية','صيدليه','العزبي','سيف','رشدي','دوا','دواء','ادوية','ادويه','روشتة','علاج',
    'مضاد','مضاد حيوي','مسكن','بنادول','كونجستال','اوجمنتين','فيتامين','فيتامينات','مكمل','شراب كحة','نقط',
    'قطرة','مرهم','كريم','لزقة','قطن','شاش','بلاستر','ترمومتر','جهاز ضغط','جهاز سكر','شرايط سكر','انسولين',
    'حقنة','حقن','محلول','تحليل','تحاليل','معمل','البرج','المختبر','اشعة','اشعه','سونار','رنين','مقطعية',
    'ايكو','رسم قلب','اسنان','سنان','ضرس','ضروس','حشو','تقويم','خلع','عصب','زراعة اسنان','نضارة','نظارة',
    'عدسات','كشف نظر','عيون','جلدية','باطنة','عظام','نسا','نسا وتوليد','علاج طبيعي','عملية','جراحة','حجز',
    'متابعة','جيم','نادي صحي','بروتين','دايت','تغذية','اخصائي','نفسي','حلاق','كوافير','صالون','بشرة',
    'سكين كير','الدكتور','الدكتورة','دكتورة نسا','دكتور عيون','دكتور جلدية','دكتور عظام','دكتور باطنة',
    'دكتور قلب','دكتور اسنان','دكتور انف واذن','دكتور مخ واعصاب','دكتور نفسي','دكتور تغذية','دكتور مسالك',
    'دكتور جراحة','استشاري','اخصائي علاج طبيعي','كشف مستعجل','اعادة كشف','استشارة دكتور','فيزيتا','الفيزيتا',
    'تمن الكشف','حجز دكتور','فيزيتا دكتور','عيادة خاصة','مستوصف','مركز طبي','مجمع طبي','المستشفى',
    'دخول مستشفى','اقامة مستشفى','عناية مركزة','رعاية','حضانة اطفال مستشفى','الطوارئ','الاسعاف','عربية اسعاف',
    'الصيدلية','صيدلية العزبي','صيدلية سيف','صيدلية رشدي','مصر صيدلية','علاجات','علاج الشهر','دوا الضغط',
    'دوا السكر','دوا القلب','دوا الكحة','دوا البرد','دوا الصداع','برد','انفلونزا','كحة','سخونية',
    'مضاد التهاب','مسكنات','بروفين','كتافلام','فولتارين','بانادول اكسترا','اوميبرازول','انتينال','فلاجيل',
    'ديفلوكان','كونكور','جلوكوفاج','فيتامين د','فيتامين سي','اوميجا','كالسيوم','حديد','زنك','بروبيوتك',
    'اقراص','كبسولات','برشام','علبة دوا','كريم جلد','مرهم حروق','قطرة عين','بخاخ','جلسة بخار','جهاز بخار',
    'جهاز قياس ضغط','جهاز قياس سكر','شرايط قياس','ابر انسولين','سرنجة','سرنجات','كانيولا','جبس طبي',
    'رباط ضاغط','حزام طبي','كرسي متحرك','عكاز','سماعة اذن','تحليل دم','صورة دم','تحليل سكر','تحليل بول',
    'تحليل شامل','تحاليل طبية','معامل','معمل المختبر','معمل البرج','الفا','اشعة عادية','اشعة صوتية',
    'سونار حمل','متابعة حمل','ولادة قيصري','كشف حمل','تحليل حمل','رسم مخ','منظار','جلسات','جلسة علاج طبيعي',
    'تخسيس','نادي رياضي','اشتراك الجيم','الجيم','مدرب','كوتش','يوجا','بيلاتس','سباحة كبار','مكملات',
    'واي بروتين','كرياتين','تقويم اسنان','تبييض اسنان','تنظيف اسنان','حشو عصب','طربوش','تركيبات','زراعة',
    'نضارة نظر','عدسات لاصقة','محلول عدسات','ليزك','عملية عين','حلاقة','الحلاق','الكوافير','صالون تجميل',
    'سبا','مساج','بديكير','منيكير','ازالة شعر','ليزر','تنظيف بشرة','كريم بشرة','واقي شمس','صن بلوك','صحتي',
    'العلاج الشهري','كشف عيون','كشف اسنان','كشف باطنة','كشف عظام','كشف جلدية','كشف قلب','كشف انف واذن',
    'كشف نسا','كشف اطفال','كشف مخ واعصاب','كشف مسالك','كشف نفسي','جلسة نفسية','معالج نفسي','طبيب نفسي',
    'دكتور تخسيس','عيادة تخسيس','نظام غذائي','اخصائي تغذية','كشف تغذية','دكتور السكر','دكتور الضغط',
    'دكتور الكلى','دكتور الكبد','دكتور الصدر','دكتور الروماتيزم','دكتور غدد','دكتور اورام','دكتور جراحة عامة',
    'جراح','تخدير','عملية صغيرة','عملية كبيرة','عملية زايدة','عملية مرارة','عملية فتق','ولادة طبيعي',
    'ولادة قيصرية','مستشفى ولادة','حضانة مولود','غرفة عمليات','اقامة','سرير مستشفى','مرافق','زيارة مستشفى',
    'علاج كيماوي','كيماوي','اشعاع','غسيل كلى','جلسة غسيل','علاج على نفقة الدولة','تأمين صحي شامل',
    'كارت التأمين الصحي','مساهمة تأمين','فرق تأمين','روشتة تأمين','صيدلية تأمين','علاج مزمن','الدوا الشهري',
    'ادوية الضغط','ادوية السكر','انسولين لانتوس','ميتفورمين','اسبرين','اسبوسيد','بلافكس','تينورمين',
    'كولشيسين','ليبيتور','كريستور','ثيروكسين','التروكسين','اوجمانتين','زيثروماكس','سيبروفلوكساسين',
    'فلاجيل اقراص','انتينال كبسول','موتيليوم','نكسيوم','كونترولوك','جافيسكون','ريفو','بروفين اطفال','سيتال',
    'كتافاست','بريفيكس','اوبلكس','تيجريتول','ديباكين','فيتامين ب','نيوروبيون','ميلجا','مالتي فيتامين',
    'سنتروم','فيرو','فيروجلوبين','كالسيوم د','اوستيوكير','زنك اقراص','بيبي فيت','فيتامين اطفال','شراب حديد',
    'شراب كالسيوم','شراب برد','شراب احتقان','بخاخ انف','نقط انف','قطرة اذن','قطرة عيون','مرطب عيون',
    'دموع صناعية','كريم كورتيزون','فيوسيدين','بيبانثين','بانثينول','كريم حروق','مرهم جروح','بيتادين','كحول',
    'قطن طبي','شاش طبي','بلاستر جروح','رباط','جبيرة','جبس رجل','جبس ايد','دعامة','دعامة قلب','قسطرة',
    'رسم قلب مجهود','هولتر','ايكو قلب','دوبلر','اشعة مقطعية','رنين مغناطيسي','اشعة سينية','ماموجرام',
    'سونار بطن','تحليل فيروسات','تحليل غدة','تحليل هرمونات','تحليل فيتامين د','تحليل كوليسترول',
    'تحليل وظايف كبد','وظايف كلى','تحليل براز','مزرعة','مسحة','بي سي ار','تحليل كورونا','كمامة','كمامات',
    'معقم','مطهر','جل معقم','جوانتي طبي','ترمومتر ديجيتال','جهاز اكسجين','اسطوانة اكسجين','جهاز نيبولايزر',
    'بخاخة ربو','فنتولين','سيريتايد','سماعة طبية','قياس سمع','فحص نظر','مقاس نضارة','عدسة نضارة','اطار نضارة',
    'فريم نضارة','نضارة طبية','عدسات طبية','عدسات ملونة','محلول رينو','تبييض','فينيرز','ابتسامة هوليود',
    'حشو تجميلي','علاج جذور','تنظيف جير','خلع ضرس عقل','ضرس العقل','كوبري اسنان','طقم اسنان','تركيبة اسنان',
    'جيم شهري','اشتراك جيم','نادي رياضي شهري','مدرب شخصي','برايفت كوتش','زومبا','ايروبكس','كروس فيت',
    'مكمل غذائي','بروتين بار','شيكر','حلاقة دقن','تحديد دقن','قص شعر','حلاق رجالي','كوافير حريمي',
    'صبغة كوافير','فرد شعر','كيراتين','بروتين شعر','حمام كريم','سشوار كوافير','ميش','هايلايت','رموش',
    'تركيب رموش','حواجب','رسم حواجب','تنظيف بشرة عميق','جلسة ليزر','ازالة شعر بالليزر','حلاوة جسم',
    'شمع ازالة','باديكير','مانيكير','مساج علاجي','حجامة'],
  'ترفيه':['سينما','فيلم','افلام','مسرح','مسرحية','خروجة','خروجه','فسحة','نزهة','رحلة','رحلات','مصيف','ساحل',
    'الساحل','الغردقة','شرم','العين السخنة','اسكندرية','سفر','سفرية','اجازة','فندق','اوتيل','شاليه','قرية',
    'حجز فندق','نادي','اشتراك النادي','بلايستيشن','بلاي ستيشن','بلاي','العاب فيديو','جيمز','ستيم','نتفليكس',
    'شاهد','واتش ات','يانجو','سبوتيفاي','انغامي','يوتيوب','يوتيوب بريميوم','ديزني','شيشة','شيشه','سجاير',
    'سجائر','سيجارة','دخان','معسل','فيب','ايكوس','حفلة','حفلات','كونسيرت','ماتش','تذكرة ماتش','بولينج',
    'بلياردو','ملاهي','ملاهى','دريم بارك','مول العاب','كافيه بلايستيشن','قعدة','سهرة','كارنيه','كتب روايات',
    'رواية','هواية','صيد','كامب','تخييم','السينما','تذكرة سينما','فيلم سينما','فشار سينما','مسرح مصر',
    'حفلة مسرح','الاوبرا','حفلة الاوبرا','خروجة العيلة','خروجة صحاب','قعدة صحاب','قعدة قهوة','قهوة بلدي',
    'طاولة','دومينو','كوتشينة','بلاي ستيشن قهوة','ساعة بلايستيشن','فيفا','بيس','كول اوف ديوتي','شحن شدات',
    'شدات','ببجي','جواهر فري فاير','فري فاير','العاب موبايل','اشتراك لعبة','جيم كارد','بطاقة جوجل بلاي',
    'ايتونز','اشتراك نتفليكس','اشتراك شاهد','يانغو بلاي','اشتراك سبوتيفاي','اشتراك يوتيوب','اشتراك انغامي',
    'تيك توك','شحن تيك توك','مصيف السنة','الساحل الشمالي','مرسى مطروح','مطروح','العلمين','العلمين الجديدة',
    'شرم الشيخ','مرسى علم','السخنة','راس سدر','الفيوم','وادي الريان','الاقصر','اسوان','سيوة','الاسكندرية',
    'بورسعيد','الاسماعيلية','راس البر','جمصة','بلطيم','رحلة نيلية','مركب في النيل','فلوكة نيل','رحلة يوم',
    'داي يوز','شاطئ','تذكرة شاطئ','كابينة','شمسية','عوامة','سنوركل','غطس','سفاري','كوادز','ركوب خيل',
    'تذكرة طيران سياحة','حجز رحلة','شركة سياحة','عمرة','حج','تأشيرة سياحة','منتجع','شاليه الساحل','شقة مصيف',
    'النادي','اشتراك نادي','تذكرة نادي','كافيتريا النادي','حديقة','الحديقة الدولية','حديقة الحيوان',
    'الازهر بارك','اكواريوم','متحف','تذكرة متحف','الهرم','الاهرامات','القلعة','خان الخليلي','المعز','الحسين',
    'ملاهي ديزني','ماجيك لاند','كيدزانيا','سكاي زون','ترامبولين','كارتنج','باينت بول','اسكيب روم','كاريوكي',
    'بولنج','بلياردو قهوة','سنوكر','حفلة عمرو دياب','حفلة تامر حسني','حفلة ويجز','تذكرة حفلة','الاهلي',
    'الزمالك','ماتش الاهلي','استاد','كافيه ماتش','شيشة قهوة','حجر','حجر شيشة','معسل تفاحتين','فحم شيشة',
    'علبة سجاير','سجاير كليوباترا','كليوباترا','مارلبورو','ميريت','ال ام','روثمان','دافيدوف','سيجار','ولاعة',
    'تبغ','جوزة','سيجارة الكترونية','ليكويد','فيب ليكويد','معرض الكتاب','رواية جديدة','مجلة','جريدة','كاميرا',
    'تصوير','فوتوسيشن','صنارة','رحلة صيد','تخييم صحرا','شواء','باربكيو','نزلة البلد','فسحة العيد',
    'خروجة العيد','خروجة الجمعة','خروجة الويك اند','ويك اند','اجازة الصيف','اجازة نص السنة','اجازة العيد',
    'شم النسيم','فسحة شم النسيم','فسحة النيل','كورنيش','قعدة كورنيش','حمص الشام كورنيش','عربية ذرة',
    'ذرة مشوي','كوفي شوب','قعدة كافيه','كافيه الجامعة','جلسة صحاب','سهرة صحاب','عيد ميلاد صاحبي','حفلة تخرج',
    'حفلة الشغل','يوم ترفيهي','رحلة الشغل','رحلة الكنيسة','رحلة الجامعة','رحلة اليوم الواحد','مصيف العيلة',
    'شقة الساحل','شاليه العين السخنة','حجز الساحل','مارينا','هاسيندا','مراسي','الجونة','سهل حشيش','طابا',
    'نويبع','سانت كاترين','شرم الشيخ رحلة','الغردقة رحلة','فندق الغردقة','فندق شرم','بوكينج','حجز بوكينج',
    'حجز اوتيل','ليلة فندق','ليالي فندق','فطار فندق','تذكرة عبارة','رحلة غطس','رحلة سفاري','رحلة بحرية','يخت',
    'رحلة يخت','بانانا بوت','باراشوت','جيت سكي','اكوا بارك','اكوا','مدينة الملاهي','العاب الملاهي',
    'تذاكر ملاهي','فن سيتي','جيمز مول','العاب مول','سنتر العاب','بلاي ستيشن خمسة','لعبة بلايستيشن',
    'سي دي لعبة','شريط لعبة','اشتراك بلاي ستيشن بلس','بلاي ستيشن بلس','فيفا الجديدة','اف سي','كارت بلايستيشن',
    'شحن فيفا','كوينز','فيفا بوينتس','شحن ببجي','يو سي','شحن جواهر','روبلكس','شحن روبلكس','ماين كرافت',
    'العاب اونلاين','اشتراك ديسكورد','نيترو','تويتش','اشتراك قناة','دعم يوتيوبر','سينما مول','فيلم جديد',
    'تذكرة فيلم','سينما ثري دي','ايماكس','فشار وكولا','عرض مسرحي','ستاند اب كوميدي','ستاند اب','ساقية الصاوي',
    'الساقية','حفلة الساقية','مهرجان','مهرجان الموسيقى','حفلة رمضان','خيمة رمضانية','سحور بره',
    'حفلة راس السنة','راس السنة','الكريسماس','شجرة كريسماس','زينة الكريسماس','عيد الحب','الفالنتين',
    'هدية فالنتين','معرض','معارض','تذكرة معرض','معرض فني','جاليري','قعدة شيشة','شيشة فواكه','معسل نخلة',
    'نخلة','معسل الزغلول','شيشة سلوم','فحم','ولاعة بنزين','سجاير ال ام','سجاير مارلبورو','سجاير كيلوباترا',
    'علبة سجاير ميريت','فرط سجاير','كروز سجاير','خرطوشة سجاير','سجاير الكتروني','فيب جديد','كويل فيب','بودز',
    'تبغ لف','بايب','معسل نخلة تفاحتين','مزاج','كتاب جديد','روايات','مكتبة الشروق','ديوان','مكتبة ديوان',
    'كتب مستعملة','سور الازبكية','الازبكية','مجلات','كاميرا جوبرو','هواية التصوير','صيد سمك','سنارة',
    'طعم صيد','رحلة الصيد','كامب صحرا','خيمة','شنطة نوم','ركوب عجل','ركوب خيل الاهرامات','ركوب جمل',
    'رحلة الفيوم','تونس الفيوم','وادي الحيتان','فلل الساحل'],
  'تسوق':['لبس','هدوم','ملابس','قميص','قمصان','بنطلون','بنطلونات','جينز','تيشيرت','تيشرت','بلوزة','فستان',
    'جيبة','عباية','طرحة','حجاب','بيجامة','ترنج','بدلة','جاكيت','جاكت','سويت شيرت','هودي','بلوفر','كارديجان',
    'شراب','شرابات','بوكسر','داخلي','ملابس داخلية','جزمة','جزم','كوتشي','كوتشيات','شوز','صندل','شبشب','حذاء',
    'شنطة','شنط','محفظة','حزام','ساعة','نضارة شمس','برفان','عطر','بارفيوم','ميكب','مكياج','ميك اب','روج',
    'ماسكرا','كريمات','اكسسوار','اكسسوارات','خاتم','سلسلة','حلق','غويشة','دهب','فضة','موبايل','تليفون جديد',
    'ايفون','سامسونج','شاومي','جراب','اسكرينة','سماعة','سماعات','ايربودز','شاحن','كابل','باور بانك','لابتوب',
    'كمبيوتر','تابلت','ايباد','ماوس','كيبورد','شاشة','تليفزيون','تلفزيون','جهاز','اجهزة','الكترونيات',
    'امازون','نون','جوميا','شي ان','تيمو','علي اكسبرس','مول','سيتي ستارز','مول مصر','كايرو فستيفال','اوت لت',
    'سوق','عتبة','وكالة البلح','ديفاكتو','زارا','اتش اند ام','ماكس','ال سي وايكيكي','تخفيضات','اوكازيون',
    'عرض','شوبينج','اللبس','لبسي','هدومي','الهدوم','طقم','طقم جديد','لبس العيد','لبس الشتا','لبس الصيف',
    'بالطو','جاكيت جلد','جاكيت جينز','بدلة رسمي','كرافتة','قميص رسمي','قميص كاجوال','بولو','كارجو','شورت',
    'بنطلون قماش','بنطلون جينز','ليجن','عباية سودا','اسدال','خمار','نقاب','ايشارب','شال','بادي','تونيك',
    'كاش مايوه','مايوه','بوركيني','لانجري','قمصان نوم','روب','شراب حريمي','جوارب','كاب','طاقية','كوفية',
    'جوانتي شتوي','حزام جلد','جزمة جلد','جزمة رياضي','صنادل','بوت','هاف بوت','كعب','باليرينا','سليبر',
    'شوز رياضي','اديداس','نايكي','بوما','سكيتشرز','شنطة يد','شنطة ضهر','شنطة سفر','شنطة لابتوب','كلاتش',
    'محفظة جلد','ساعة يد','ساعة سمارت','سمارت واتش','اسورة','انسيال','دبلة','شبكة','دهب عيار','جرام دهب',
    'جنيه دهب','سبيكة','فضة ستيرلنج','مجوهرات','برفيوم','مسك','بخور','عود','معطر جسم','بودي سبلاش',
    'مزيل مكياج','فاونديشن','كونسيلر','بلاشر','كحل','ايلاينر','اي شادو','احمر شفايف','مناكير','طلاء اضافر',
    'فرش مكياج','كريم شعر','زيت شعر','صبغة','صبغة شعر','مكواة شعر','سشوار','ماكينة شعر','فون','موبايل جديد',
    'ايفون جديد','ايباد جديد','سامسونج جالاكسي','اوبو','ريلمي','فيفو','هواوي','انفنكس','نوكيا','جراب موبايل',
    'اسكرينة حماية','سماعة بلوتوث','سماعة ايربودز','سماعة راس','شاحن موبايل','شاحن سريع','كابل شحن',
    'وصلة شاحن','باور بنك','فلاشة','كارت ميموري','هارد','هارد ديسك','لاب توب','لابتوب جديد','شاشة كمبيوتر',
    'تلفزيون سمارت','شاشة سمارت','ريسيفر جديد','رسيفر','بلايستيشن جديد','دراع','يد تحكم','طابعة','حبر طابعة',
    'كاميرا مراقبة','محل موبايلات','محل هدوم','محل احذية','محل شنط','مول العرب','داون تاون','مول الحجاز',
    'سيتي سنتر','العتبة','الموسكي','شارع الشواربي','سوق الجمعة','سوق التلات','اوكازيون الصيف',
    'اوكازيون الشتا','خصومات','الجمعة البيضا','بلاك فرايداي','اونلاين شوبينج','طلب اونلاين','امازون مصر',
    'نون مصر','جوميا مصر','ماكس فاشون','امريكان ايجل','بول اند بير','كونكريت','تاون تيم','اكتيف','لوتو',
    'كوتون ايجيبت','بيم ستورز','كنز','كيرياكي','دبنهامز','ادوات تجميل','هدية لنفسي','شوبنج','مشتريات',
    'مشترياتي','اشتريت','اشتريت حاجة','حاجات جديدة','لبس جديد','لبس الشغل','لبس الجامعة','لبس خروج','لبس بيت',
    'بيجامات','هدوم بيت','هدوم خروج','فساتين','فستان سواريه','فستان فرح','فستان خطوبة','بدلة فرح',
    'بدلة العريس','خياطة','ترزي','الترزي','تقصير بنطلون','تضييق','تفصيل','تفصيل بدلة','قماش','اقمشة','كلف',
    'زراير','سوستة','خيط','ابرة','مكنة خياطة','تريكو','كروشيه','صوف','بلوفر صوف','جاكيت شتوي','جاكيت بافر',
    'بافر','كوت','بالطو شتوي','كنزة','سويتر','ترينج','ترنج رياضي','بنطلون رياضي','تيشرت رياضي','شورت رياضي',
    'طقم رياضي','جزمة كورة','حذاء رياضي','كوتشي جري','شبشب حمام','شبشب بيت','صندل صيفي','جزمة شتوي',
    'بوت شتوي','ميداليات','مفاتيح ميدالية','شنطة كروس','شنطة كتف','شنطة جلد','شنطة حريمي','شنطة رجالي',
    'محفظة رجالي','كارت هولدر','نضارة شمسية','نضارة بولارايزد','ساعة رجالي','ساعة حريمي','كاسيو','ابل واتش',
    'سمارت باند','سوار','اساور','حلق دهب','سلسلة دهب','خاتم دهب','دبلة دهب','دبل','دبل الخطوبة',
    'شبكة العروسة','مجوهرات فضة','اكسسوارات شعر','توكة','تويكات','بنسة','مشط','فرشة شعر','سيروم','سيروم بشرة',
    'كريم مرطب','مرطب','لوشن','كريم ايد','كريم عين','تونر','غسول','غسول وش','ماسك','ماسكات','ريتينول',
    'فيتامين سي سيروم','صابون طبي','شامبو طبي','بلسم شعر','ماسك شعر','زيت ارجان','جل شعر','واكس شعر',
    'سبراي شعر','برفان رجالي','برفان حريمي','بارفان','عطور','عطر اوريجينال','تستر','برفانات','مزيل عرق رولون',
    'ميك اب جديد','باليتة','بالتة','ماسكرا جديدة','احمر خدود','بودرة وش','برايمر','هايلايتر','كونتور',
    'ايلاينر قلم','رموش صناعية','اضافر صناعية','مزيل طلاء','فرش ميك اب','اسفنجة ميك اب','موبايل اندرويد',
    'موبايل مستعمل','تليفون مستعمل','ايفون مستعمل','شراء موبايل','تغيير موبايل','شاشة موبايل','تغيير شاشة',
    'تصليح موبايل','صيانة موبايل','بطارية موبايل','فلاشة يو اس بي','هارد خارجي','ماوس لاسلكي','كيبورد لاسلكي',
    'سماعات جيمنج','كرسي جيمنج','مكتب كمبيوتر','رامات','كارت شاشة','بروسيسور','تجميعة','تجميعة كمبيوتر',
    'لاب جيمنج','شنطة لاب','ستاند لاب','شاحن لاب','راوتر جديد','مقوي اشارة','ريبيتر','كاميرا ويب','ميكروفون',
    'رينج لايت','تريبود','سيلفي ستيك','شاحن عربية','حامل موبايل','باور بانك سريع','ساعة ذكية','تابلت جديد',
    'كيندل','قارئ كتب','سماعة بلوتوث كبيرة','سبيكر','مكبر صوت','ريسيفر فضائي','اندرويد بوكس','تي في بوكس',
    'جيم ستيك','اكس بوكس','نينتندو','معرض موبايلات','محل اكسسوارات','مول تجاري','هايبر ملابس','داون تاون مول',
    'مول اركان','مول العرب الشيخ زايد','كايرو فيستيفال مول','سيتي ستارز مول','طلب من نون','طلب من امازون',
    'طلب من جوميا','طلب شي ان','اوردر شي ان','اوردر امازون','شحن الاوردر','كوبون','كود خصم','عرض الجمعة',
    'عروض','اوفر','اوفرات'],
  'أخرى':['هدية','هدايا','صدقة','صدقات','زكاة','زكاه','تبرع','تبرعات','عيدية','عيديات','نقوط','عشور','كنيسة',
    'جامع','مسجد','نذر','كفارة','اضحية','رسوم','غرامة','بريد','شحنة','شحن طرد','شحنات','طوابع','توثيق',
    'شهر عقاري','محامي','محاماة','استخراج','بطاقة','باسبور','جواز سفر','تصديق','سجل مدني','قرض','عزاء','فرح',
    'خطوبة','مناسبة','واجب','سلفة','عربون','بقشيش','طباعة','ورق','هدية عيد ميلاد','هدية جواز','هدية خطوبة',
    'هدية نجاح','هدية مولود','هدية للماما','هدية للبابا','هدية لصاحبي','ورد','بوكيه ورد','بوكيه',
    'شيكولاتة هدية','صدقة جارية','زكاة مال','زكاة فطر','زكاة الفطر','فطرة','كفالة يتيم','كفالة','جمعية خيرية',
    'بنك الطعام','مستشفى سرطان','تبرع مستشفى','تبرع كنيسة','تبرع جامع','صندوق كنيسة','صندوق النذور',
    'طبق الكنيسة','عشور الكنيسة','بكور','قداس','شموع','شمع','تونية','نقطة فرح','نقوط فرح','فلوس عزا',
    'تمن عزا','واجب عزا','دار مناسبات','قاعة افراح','فرح صاحبي','عيدية العيال','عيدية الحريم','العيد الكبير',
    'العيد الصغير','كحك العيد','فانوس رمضان','زينة رمضان','شنطة رمضان','كرتونة رمضان','موائد الرحمن','ضحية',
    'اللحمة الضحية','صك اضحية','رسوم حكومية','رسوم ادارية','دمغة','طوابع دمغة','طابع','شهادة ميلاد',
    'قيد عائلي','فيش وتشبيه','فيش','صحيفة حالة جنائية','تجديد البطاقة','بطاقة الرقم القومي','الباسبور',
    'جواز السفر','تأشيرة','سفارة','توكيل رسمي','الشهر العقاري','مكتب توثيق','محامي قضية','اتعاب محاماة',
    'اتعاب','قضية','محكمة','رسوم قضية','كشف حساب','رسوم تحويل','عمولة تحويل','عمولة بنك','فلوس ضايعة',
    'اتسرقت','غرامة تأخير','تصوير ورق','طباعة ورق','سكانر','ظرف','بوستة','البريد المصري','ارامكس','دي اتش ال',
    'بوسطة','شحنة طرد','مندوب شحن','فلوس الشحن','بقشيش الدليفري','تيبس الجرسون','اكرامية','سلفة لحد',
    'فلوس لماما','فلوس لبابا','مصروف ماما','مصروف البيت لاهلي','مساعدة اهلي','فلوس لاخويا','جمعية الشهر',
    'دفع جمعية','مصاريف متنوعة','نثريات','حاجات متفرقة','متفرقات','حاجة متفرقة','مصاريف تانية','حاجات تانية',
    'مصاريف اضافية','مصروف طارئ','طوارئ فلوس','ظرف طارئ','مصيبة','هدية زميل','هدية مدير','هدية مدرسة',
    'هدية ميس','هدية العروسة','هدية العريس','هدية فرح','هدية سبوع','هدية تخرج','هدية عيد الام','عيد الام',
    'هدية عيد الاب','كارت هدية','جيفت كارد','جيفت','تغليف هدية','تغليف','ورد طبيعي','ورد صناعي','محل ورد',
    'صدقة الجمعة','صدقة البيت','صدقة على روح','رحمة ونور','اطعام','اطعام مساكين','شنطة خير','كرتونة خير',
    'فرش جامع','مصحف','مصاحف','سجادة صلاة','سبحة','اسورة دينية','صليب','ايقونة','ايقونات','كتاب مقدس','انجيل',
    'قربانة','القربان','عشية','تمجيد','نهضة','خلوة','اعتكاف','رحلة دينية','زيارة دير','دير','الدير',
    'شنطة الدير','تبرع دير','تبرع ابونا','ابونا','الكاهن','الشيخ','درس الشيخ','صندوق الزكاة','بيت الزكاة',
    'مصر الخير','الاورمان','ابو الريش','بنك الشفاء','صناع الحياة','اهل مصر','تبرع اون لاين','كفالة طفل',
    'كفالة اسرة','سقيا مية','كولدير','كولدير مية','مساعدة جار','مساعدة صاحب','مساعدة قريب','فلوس للعيلة',
    'فلوس للاهل','مساهمة','مشاركة','شير','شير هدية','لمة','لمة فلوس','تقسيم حساب','حسابي في الخروجة',
    'واجب فرح','واجب عزاء','فلوس الفرح','فلوس الخطوبة','فلوس الواجب','عزومة فرح','قاعة','قاعة مناسبات',
    'فوتوجرافر','مصور فرح','دي جي','زفة','كوشة','ميك اب ارتست','توزيعات فرح','توزيعات سبوع','شنط سبوع',
    'حلويات سبوع','شوار','جهاز العروسة','فرش الشقة','مهر','شبكة الخطوبة','حنة','ليلة الحنة','كتب الكتاب',
    'كتب كتاب','المأذون','مأذون','قسيمة','توثيق جواز','قسيمة جواز','شهادة وفاة','دفنة','الدفنة','مدافن',
    'تربة','التربي','مقابر','قراية قرآن','قارئ','ختمة','ذكرى','اربعين','الاربعين','السنوية','صوان',
    'صوان عزاء','قهوجي العزا','ورق رسمي','مصلحة حكومية','الاحوال المدنية','الجوازات','تصريح عمل','تصريح سفر',
    'تأشيرة خروج','شهادة تحركات','تصديقات','تصديق الخارجية','ترجمة معتمدة','ترجمة ورق','مكتب ترجمة','ختم',
    'اختام','ختم النسر','استمارة','استمارات','نموذج','كارنيه نقابة','النقابة','اشتراك النقابة','تجديد كارنيه',
    'رسوم امتحان','رسوم تقديم','رسوم كورس','رسوم شهادة','شهادة خبرة','شهادة تخرج','فلوس ورق','تصوير مستندات',
    'طباعة ملون','برنت','سكان','تصوير بطاقة','صور شخصية','صور باسبور','استوديو','استوديو تصوير',
    'فلوس ضاعت مني','وقعت مني','اتنشلت','نشال','سرقة','غرامة مرور','مخالفة ركن','غرامة كهربا','غرامة مية',
    'تصالح','رسوم تصالح','عمولة محفظة','رسوم انستاباي','رسوم تحويل فودافون','مصاريف تحويل','بقشيش القهوجي',
    'بقشيش السايس','بقشيش البواب','حلاوة العيد','فلوس الحلاوة','حلاوة للعامل','اكرامية العامل',
    'اكرامية البواب','فكة الشحات','كفارة يمين','فدية','وفاء نذر','طلبات متنوعة','مصاريف غير متوقعة',
    'حاجات صغيرة','مصاريف صغيرة'],
  'المرتب':['راتب','مرتب الشهر','قبض','القبض','قبضية','بونص','حافز','حوافز','مكافأة','مكافئة','اضافي',
    'اوفر تايم','بدل','بدلات','علاوة','ارباح سنوية','منحة','المرتب','مرتبي','راتبي','الراتب','راتب الشهر',
    'المعاش','معاش','القبضية','قبض الشهر','اول الشهر','البونص','حافز الانتاج','حوافز الشهر','الحافز',
    'مكافئة نهاية الخدمة','مكافأة سنوية','الاضافي','ساعات اضافي','شيفت اضافي','بدل سفر','بدل انتقال',
    'بدل وجبة','بدل سكن','العلاوة','علاوة دورية','الارباح السنوية','ربح سنوي','منحة العيد','منحة رمضان',
    'الشهر الثالث عشر','مرتب الشغل','راتب الشغل','المرتب الشهري','الراتب الشهري','تحويل المرتب','نزل المرتب',
    'المرتب نزل','صرف المرتب','يوم القبض','القبض الشهري','الماهية','ماهية','اجر','الاجر','الاجر الشهري',
    'يومية','اليومية','اسبوعية','الاسبوعية','اجر اسبوعي','حساب الشهر','حساب الشغل','فلوس الشغل',
    'المرتب الاساسي','الاساسي','المتغير','الحافز الشهري','الحافز السنوي','بونص اخر السنة','بونص سنوي',
    'مكافأة امتحانات','مكافأة الامتحانات','جهود غير عادية','الجهود','حافز تميز','علاوة اجتماعية','علاوة غلاء',
    'علاوة الترقية','ترقية','فرق ترقية','فرق علاوة','فرق مرتب','متأخرات','متاخرات المرتب','معاش بابا',
    'معاش ماما','معاش الوالد','معاش تكافل','تكافل وكرامة','كرامة','منحة عمالة','منحة العمالة غير المنتظمة',
    'مكافأة نهاية سنة','صرف الارباح','ارباح الشركة السنوية'],
  'عمولات':['عمولة','كوميشن','تارجت','نسبة','نسبة مبيعات','صفقة','بيعة','العمولة','عمولتي','عمولات الشهر',
    'التارجت','نسبتي','نسبة البيع','نسبة من البيع','مبيعات','بيعة حلوة','صفقات','سمسرة','عمولة سمسرة',
    'عمولة شقة','عمولة عربية','دلالة','عمولة البيع','عمولة المبيعات','عمولة العقار','عمولة الصفقة',
    'عمولة شهرية','نسبة المبيعات','نسبتي من البيع','البارسنت','كوميشن الشهر','حافز مبيعات','حافز التارجت',
    'تارجت الشهر','التحقيق','بونص مبيعات','عمولة تسويق','تسويق بالعمولة','افلييت','عمولة تأمين','عمولة سمسار',
    'سمسار','عمولة توصيل','عمولة مندوب','مندوب مبيعات','عمولة طلبيات','عمولة توريد','توريدات','عمولة وساطة',
    'وساطة'],
  'إيجار الشقة':['ساكن','ايجار','ايجارات','مستأجر','المستأجر','ايجار المحل','ايجار الشقة','ايجار الساكن',
    'الساكن','ساكن الدور','المستأجرين','ايجار المحل التجاري','ايجار الدكان','ايجار الجراج','ايجار الشاليه',
    'ايجار المصيف','ايجار العربية','ايجار الارض','ايجار الشهر','الايجار','استلمت الايجار','ايجار مقدم',
    'تأمين الشقة','مقدم ايجار','ايجار الشقة التانية','ايجار الدور','ايجار الدور الارضي','ايجار الروف',
    'ايجار السطوح','ايجار الشقة المفروشة','مفروش','شقة مفروشة','ايجار مفروش','ايجار يومي','ايجار اسبوعي',
    'ايجار شهري','ايجار سنوي','ايجار الفيلا','ايجار المكتب','ايجار العيادة','ايجار المخزن','ايجار الورشة',
    'ايجار الكشك','ايجار الاوضة','ايجار سرير','ايجار طلبة','ايجار الجنينة','ايجار الارض الزراعية',
    'ايجار الفدان','ايجار القيراط','ايجار البيت القديم','ايجار المصيف للغير','الشهر من الساكن','ايجار متأخر',
    'باقي الايجار','تأمين الساكن','عقد ايجار','تجديد عقد الايجار'],
  'دخل آخر':['فريلانس','مشروع','بيع','بعت','شغل اضافي','شغلانة','بيزنس','ارباح','فوايد','فايدة','عايد',
    'شهادات','وديعة','سهم','اسهم','بورصة','استرداد','هدية فلوس','نقطة','جمعية','قبضت الجمعية','ميراث','ورث',
    'شغل حر','شغل من البيت','شغلانة اضافية','مشروع صغير','ارباح المشروع','ارباح المحل','بيع حاجة','بعت حاجة',
    'بعت الموبايل','بعت العربية','بيع دهب','بعت دهب','فوايد البنك','فوايد الشهادة','عايد الشهادة',
    'عايد الوديعة','ارباح البورصة','ارباح الاسهم','توزيعات','اتردتلي','رجعلي','فلوس هدية','نقطة فرحي',
    'قبضت جمعية','الجمعية','الميراث','تعويض','جايزة','جائزة','مسابقة','يانصيب','دروس خصوصية بديها',
    'درس اديته','كورس اديته','تصميم','ترجمة','يوتيوب ارباح','اعلانات','فلوس جات','فلوس دخلت','دخل اضافي',
    'مصدر دخل','شغل جانبي','شغل بارت تايم','بارت تايم','شغل اونلاين','شغل عن بعد','مشروع اونلاين',
    'بيع اونلاين','صفحة البيع','بيع على الفيس','ماركت بليس','اوليكس','بعت على اوليكس','بيع مستعمل','بعت هدوم',
    'بعت جهاز','بعت عفش','بعت العجلة','بعت اللاب','بيع ذهب','بيع فضة','بيع عملة','تغيير عملة','فرق عملة',
    'تحويل من بره','تحويل من الخارج','حوالة','حوالة بنكية','ويسترن يونيون','ويسترن','موني جرام','فلوس من برة',
    'فلوس من اخويا','فلوس من ابويا','فلوس من ماما','مصروف من بابا','هدية من حد','عيدية العيد','فلوس العيد',
    'كسبت','مكسب','ربح','ربحت','مكسب البيع','فرق البيع','تجارة','بيزنس صغير','محل صغير','كشك ابني',
    'عربية فول ارباح','دروس بديها','درس خصوصي بديه','مجموعات بديها','تدريس','تدريس خصوصي','كورس بقدمه',
    'تدريب بقدمه','محاضرة','استشارة بقدمها','كشف عيادتي','عيادة خاصة بيا','تصميم لوجو','تصميم جرافيك',
    'مونتاج','فيديو مونتاج','كتابة محتوى','ترجمة ورق للناس','تصوير مناسبات','تصوير فرح','برمجة',
    'شغل فري لانس','منصة فريلانسر','مستقل','خمسات','فايفر','ابورك','ارباح يوتيوب','ارباح تيك توك',
    'ارباح فيسبوك','اعلان ممول ارباح','شراكة','نصيبي','نصيب','نصيبي من الارباح','ريع','عايد شهري',
    'عايد ربع سنوي','فايدة الشهادة','فايدة الوديعة','كوبون شهادة','فك شهادة','كسر وديعة','استثمار',
    'عايد الاستثمار','صندوق استثمار','ذهب استثمار','اسهم البورصة','توزيعات ارباح','تعويض تأمين','صرف تأمين',
    'مكافأة نهاية خدمة','تعويض نهاية خدمة','بدل نقدي','فلوس الجمعية','جمعيتي','دوري في الجمعية','قبض الجمعية',
    'رد الدين','اتسدلي','جايزة مسابقة','جايزة اليانصيب','كسبت مسابقة','لوتري','منحة دراسية','منحة تفوق',
    'مكافأة تفوق','مكافأة الجامعة']
};

/* ctx: {accts, expCats, incCats, pro, lastCat:{exp,inc,ref}, acct} — a category may carry `words` */
function parseSentence(raw,ctx){
  const s=normDigits(String(raw||''));
  const m=s.match(/\d+(\.\d+)?/);
  let amount, toks;
  if(m){
    amount=Number(m[0]);
    toks=tokOf(s.slice(0,m.index)+' '+s.slice(m.index+m[0].length));
  }else{
    const all=tokOf(s), w=wordNumber(all);
    if(!w) return null;
    amount=w.value; toks=all.filter((_,i)=>i<w.start||i>=w.end);
  }
  if(!(amount>0)) return null;
  const keys=toks.map(stripAl);
  const used=new Array(toks.length).fill(false);
  const hasW=list=>keys.some((k,i)=>!used[i]&&list.some(w=>tokMatch(k,stripAl(w))));

  /* accounts first — their names are the most distinctive */
  const aM=scoreItems(keys,used,ctx.accts,a=>a.name);
  if(aM.best) aM.hit.forEach(i=>used[i]=true);

  const refHit=ctx.pro&&hasW(REF_W), incHit=hasW(INC_W);
  const eM=scoreItems(keys,used,ctx.expCats,c=>c.name,c=>c.words);
  const iM=scoreItems(keys,used,ctx.incCats,c=>c.name,c=>c.words);
  let kind;
  if(refHit) kind='ref';
  else if(iM.score>eM.score) kind='inc';
  else if(eM.score>iM.score) kind='exp';
  else kind=incHit?'inc':'exp';

  /* only the category's own name leaves the note — a keyword ("شاورما") is worth keeping */
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

/* best match among named items for the unused tokens. The name scores word by word
   (`hit` = the tokens it used); each keyword phrase counts only when all its words are there. */
function scoreItems(keys,used,items,nameOf,wordsOf){
  /* overlap length, plus one for an exact word, so «كهربا» prefers itself over «كهربائي» */
  const pts=(k,w)=>Math.min(k.length,w.length)+(k===w?1:0);
  const find=(w,taken)=>{
    let at=-1,bp=0;
    for(let i=0;i<keys.length;i++){
      if(used[i]||taken.includes(i)||!tokMatch(keys[i],w)) continue;
      const p=pts(keys[i],w); if(p>bp){ bp=p; at=i; }
    }
    return at;
  };
  let best=null,bs=0,bh=[];
  for(const it of items){
    const hit=[];
    let sc=0;
    for(const w of tokOf(nameOf(it)).map(stripAl).filter(w=>w.length>=2)){
      const i=find(w,hit); if(i<0) continue;
      sc+=pts(keys[i],w); hit.push(i);
    }
    /* plus its single best keyword phrase — every word of the phrase must be there */
    let kw=0;
    for(const ph of (wordsOf&&wordsOf(it))||[]){
      const ws=tokOf(ph).map(stripAl).filter(Boolean), at=[];
      let p=0;
      for(const w of ws){ const i=find(w,at); if(i<0){ p=0; break; } at.push(i); p+=pts(keys[i],w); }
      if(p>kw) kw=p;
    }
    sc+=kw;
    if(sc>bs){ bs=sc; best=it; bh=hit; }
  }
  return {best,score:bs,hit:bh};
}

/* the category a free-text note points to (by name or keyword), or null */
function guessCat(text,cats){
  const keys=tokOf(normDigits(String(text||''))).map(stripAl);
  return scoreItems(keys,keys.map(()=>false),cats,c=>c.name,c=>c.words).best;
}

/* ═══════ backup ═══════ */
/* returns an error message for a malformed backup, or '' if it's safe to restore */
function checkBackup(d){
  if(!d||typeof d!=='object') return 'not an object';
  if(!Array.isArray(d.tx)||!Array.isArray(d.cats)) return 'missing tx or cats';
  for(const k of ['acct','recur','debt','recon','plan','rent','stay','goal'])
    if(d[k]!=null && !Array.isArray(d[k])) return `${k} is not a list`;
  const ids=x=>x&&typeof x==='object'&&(typeof x.id==='string'||typeof x.id==='number');
  for(const k of ['tx','cats','acct','recur','debt','recon','plan','rent','stay','goal'])
    if((d[k]||[]).some(x=>!ids(x))) return `${k} has a record without an id`;
  for(const st of (d.stay||[]))
    if(typeof st.from!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(st.from)||!(st.total>=0)) return 'stay with a bad date or amount';
  for(const t of d.tx){
    if(!(typeof t.amount==='number'&&isFinite(t.amount))) return 'tx with a bad amount';
    if(typeof t.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(t.date)) return 'tx with a bad date';
  }
  for(const r of (d.recon||[]))
    if(typeof r.date!=='string') return 'recon with a bad date';
  return '';
}

/* fix what can be fixed in a backup instead of refusing the whole file:
   numbers stored as text, dates with a time part, records without an id, broken rows.
   Returns {d, skipped} — `skipped` counts the rows that had to be dropped. */
function repairBackup(raw){
  if(!raw||typeof raw!=='object') return {d:null,skipped:0};
  const d={...raw}; let skipped=0;
  const list=k=>Array.isArray(d[k])?d[k]:[];
  const hasId=x=>x&&typeof x==='object'&&(typeof x.id==='string'||typeof x.id==='number');
  const day=v=>{ const m=String(v||'').match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); return m?`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`:''; };
  let n=0; const newId=()=>'r'+Date.now().toString(36)+(n++);
  for(const k of ['cats','acct','recur','debt','recon','plan','rent','stay','goal','tx']){
    const out=[];
    for(const x of list(k)){
      if(!x||typeof x!=='object'){ skipped++; continue; }
      const y=hasId(x)?{...x}:{...x,id:newId()};
      if(k==='tx'){
        y.amount=Number(y.amount); y.date=day(y.date);
        if(!(isFinite(y.amount)&&y.amount>0)||!y.date){ skipped++; continue; }
      }
      if(k==='recon'){ y.date=day(y.date); if(!y.date){ skipped++; continue; } }
      if(k==='stay'){ y.from=day(y.from); y.total=Number(y.total); y.nights=Number(y.nights)||1;
        if(!y.from||!(y.total>=0)){ skipped++; continue; } }
      out.push(y);
    }
    d[k]=out;
  }
  return {d,skipped};
}

if(typeof module!=='undefined') module.exports={iso,parseISO,dim,prevMonth,nextMonth,addDays,daysElapsed,
  txDelta,afterRecon,budgetCross,recurringDue,months12,rentOverdue,rentPaid,rentLeft,rentDueDate,
  debtPaid,debtLeft,debtFlows,creditPaid,creditLeft,creditFlows,stayNet,stayPaid,stayLeft,stayDue,stayRefunded,stayFeeOwed,isPlatform,stayOut,stayNightsIn,stayEarnedIn,staySummary,stayClashes,unitMonth,
  unitKey,isBiz,inScope,migrateUnits,rentalMonth,unitsLiveIn,waNumber,dueItems,learnPhrase,wordNumber,norm,normDigits,stripAl,tokOf,tokMatch,
  parseSentence,guessCat,CAT_WORDS,checkBackup,repairBackup};
