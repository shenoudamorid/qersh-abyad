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
/* money a debt moved through accounts: lending takes it out, borrowing brings it in,
   and each repayment goes the other way. No account = recorded only, balances untouched. */
function debtFlows(d){
  const s=d.dir==='out'?-1:1, out=[];
  if(d.acct) out.push({acct:d.acct,date:d.date,at:d.at,amount:s*d.amount});
  for(const p of (d.pays||[])) if(p.acct) out.push({acct:p.acct,date:p.date,at:p.at,amount:-s*p.amount});
  return out;
}

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

/* starter keywords for the default categories, by category name. Seeded into
   each category's editable `words` list once; a keyword that shows up in the
   text picks its category but stays in the note (unlike the category's name). */
const CAT_WORDS={
  'أكل وشرب':['فطار','غدا','غداء','عشا','عشاء','مطعم','كافيه','قهوة','شاي','نسكافيه','عصير','مياه','ميه','بيبسي',
    'كولا','فول','طعمية','فلافل','كشري','شاورما','بيتزا','برجر','فراخ','لحمة','سمك','جمبري','كباب','كفتة',
    'حواوشي','سندوتش','ساندوتش','ساندويتش','عيش','فينو','جبنة','لبن','زبادي','بيض','خضار','فاكهة','طماطم',
    'بطاطس','رز','مكرونة','سكر','زيت','بقالة','سوبرماركت','ماركت','كارفور','هايبر','حلويات','جاتوه','تورتة',
    'كيك','شيكولاتة','ايس كريم','ايسكريم','شيبسي','بسكويت','سناكس','طلبات','دليفري','ماكدونالدز','كنتاكي',
    'سوشي','فطير','كريب','بن','تموين','جزار','فكهاني','خضري'],
  'مواصلات':['اوبر','uber','careem','كريم','ديدي','اندرايف','indrive','تاكسي','ميكروباص','مكروباص','توكتوك',
    'تكتك','اتوبيس','باص','مترو','قطر','قطار','سوبرجيت','بنزين','سولار','جاز','عربية','موقف','جراج','ركنة',
    'كارتة','تذكرة','ميكانيكي','مكانيكي','كاوتش','ترخيص','مخالفة','سواق','غسيل العربية','زيت العربية'],
  'بيت ومعيشة':['شقة','منظفات','صابون','مسحوق','اريال','برسيل','كلور','فلاش','مناديل','شامبو','معجون',
    'اثاث','عفش','نجار','سباك','كهربائي','نقاش','دهان','صيانة','تصليح','بواب','شغالة','مكوجي','مطبخ',
    'اطباق','ستاير','سجاد','مفروشات','ملايات','لمبة','اسانسير','حاجات البيت'],
  'الولد':['ولد','عيال','اطفال','طفل','بيبي','بامبرز','حفاضات','لبن اطفال','حضانة','مدرسة','مدارس','دروس',
    'درس','مدرس','سنتر','كتب','كراسات','شنطة المدرسة','باص المدرسة','يونيفورم','لعب','لعبة','العاب','تمرين'],
  'فواتير':['كهربا','كهرباء','نور','عداد','غاز','نت','انترنت','واي فاي','وايفاي','راوتر','باقة','رصيد',
    'كارت شحن','شحن','فودافون','اورنج','اتصالات','وي','تليفون','ارضي','اشتراك','قسط','اقساط','تامين',
    'ضرايب','ضريبة','زبالة','نظافة','فاتورة','فاتورة الميه','فاتورة المياه'],
  'صحة':['دكتور','دكتورة','طبيب','كشف','عيادة','مستشفى','صيدلية','دوا','دواء','ادوية','علاج','تحليل',
    'تحاليل','اشعة','سونار','اسنان','ضروس','نضارة','نظارة','عدسات','جيم','فيتامين','حقنة','عملية','روشتة',
    'بنادول','مضاد'],
  'ترفيه':['سينما','فيلم','خروجة','فسحة','رحلة','مصيف','ساحل','سفر','فندق','نادي','بلايستيشن','بلاي',
    'نتفليكس','netflix','شاهد','سبوتيفاي','يوتيوب','شيشة','سجاير','سجائر','دخان','معسل','حفلة','ماتش',
    'ملاهي','كافيه بلايستيشن'],
  'تسوق':['لبس','هدوم','ملابس','قميص','بنطلون','جزمة','كوتشي','شوز','فستان','جاكيت','تيشيرت','بلوزة',
    'شنطة','ساعة','برفان','عطر','ميكب','مكياج','ميك اب','اكسسوار','اكسسوارات','موبايل','سماعة','شاحن',
    'لابتوب','كمبيوتر','جهاز','اجهزة','امازون','amazon','نون','noon','جوميا','shein','شي ان','مول','سوق'],
  'أخرى':['هدية','هدايا','صدقة','زكاة','تبرع','عيدية','نقوط','عشور','كنيسة','جامع','رسوم','بريد'],
  'المرتب':['راتب','قبض','salary','بونص','حافز','حوافز','مكافأة'],
  'عمولات':['عمولة','كوميشن','تارجت'],
  'إيجار الشقة':['ساكن','ايجار'],
  'دخل آخر':['فريلانس','مشروع','بيع','شغل اضافي']
};

/* ctx: {accts, expCats, incCats, pro, lastCat:{exp,inc,ref}, acct} — a category may carry `words` */
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
  let best=null,bs=0,bh=[];
  for(const it of items){
    const taken=[], hit=[];
    const find=w=>{
      for(let i=0;i<keys.length;i++)
        if(!used[i]&&!taken.includes(i)&&tokMatch(keys[i],w)) return i;
      return -1;
    };
    let sc=0;
    for(const w of tokOf(nameOf(it)).map(stripAl).filter(w=>w.length>=2)){
      const i=find(w); if(i<0) continue;
      sc+=w.length; taken.push(i); hit.push(i);
    }
    for(const ph of (wordsOf&&wordsOf(it))||[]){
      const ws=tokOf(ph).map(stripAl).filter(Boolean), at=[];
      for(const w of ws){ const i=find(w); if(i<0) break; at.push(i); taken.push(i); }
      /* score the overlap, plus one for an exact word, so «كهربا» prefers itself over «كهربائي» */
      if(ws.length && at.length===ws.length)
        ws.forEach((w,j)=>{ const k=keys[at[j]]; sc+=Math.min(k.length,w.length)+(k===w?1:0); });
      else taken.splice(taken.length-at.length,at.length);
    }
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
  debtPaid,debtLeft,debtFlows,dueItems,norm,normDigits,stripAl,tokOf,tokMatch,
  parseSentence,guessCat,CAT_WORDS,checkBackup};
