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
  'أكل وشرب':[
    /* وجبات وأماكن */ 'فطار','فطور','غدا','غداء','عشا','عشاء','سحور','اكلة','وجبة','مطعم','كافيه','كافتيريا',
    'قهوة','كوفي','coffee','شاي','نسكافيه','كابتشينو','لاتيه','اسبريسو','موكا','ستاربكس','starbucks','كوستا','سينابون',
    'عصير','عصاير','قصب','سوبيا','عرقسوس','تمر هندي','سحلب','مياه','ميه','مياة معدنية','بيبسي','كولا','كوكاكولا',
    'سفن اب','فانتا','ريد بول','ردبول','مشروب','مشروبات','حاجة ساقعة',
    /* أكل الشارع والمطاعم */ 'فول','طعمية','فلافل','كشري','كشرى','شاورما','بيتزا','pizza','برجر','burger','هامبرجر',
    'كريسبي','فرايز','بطاطس محمرة','كباب','كفتة','حواوشي','سندوتش','سندوتشات','ساندوتش','ساندويتش','كبدة','سجق',
    'مشويات','مشاوي','فطير','فطير مشلتت','كريب','سوشي','نودلز','مندي','بيتزا هت','دومينوز','ماكدونالدز','ماك',
    'كنتاكي','kfc','هارديز','بازوكا','مؤمن','كوك دور','بخيت','ابو طارق','التابعي','بلبن','طلبات','talabat','دليفري',
    'delivery','اورديلو','بريدفاست','حلواني','حلويات','بسبوسة','كنافة','قطايف','جاتوه','تورتة','كيك','دونتس','وافل',
    'ايس كريم','ايسكريم','جيلاتي','شيكولاتة','شوكولاتة','بونبون','لب','سوداني','مكسرات','فشار','ترمس','حمص الشام',
    'شيبسي','بسكويت','سناكس','مقرمشات','كورن فليكس',
    /* بقالة وتموين */ 'عيش','خبز','عيش بلدي','عيش فينو','فينو','توست','جبنة','جبن','رومي','لبن','زبادي','رايب','زبدة',
    'سمنة','قشطة','بيض','عسل','مربى','حلاوة','طحينة','تونة','بلوبيف','لانشون','بسطرمة','لحمة','لحم','فراخ','فرخة',
    'دجاج','بانيه','ديك رومي','بط','سمك','جمبري','كابوريا','سبيط','فيليه','بلطي','بوري','كبده','خضار','خضروات',
    'فاكهة','فاكهه','طماطم','بطاطس','بصل','توم','خيار','جزر','كوسة','باذنجان','فلفل','ليمون','موز','تفاح',
    'برتقال','عنب','مانجا','بطيخ','فراولة','بلح','تمر','رز','ارز','مكرونة','مكرونه','دقيق','سكر','زيت','ملح',
    'شاي ليبتون','عدس','فاصوليا','لوبيا','بسلة','بقوليات','توابل','بهارات','صلصة','كاتشب','مايونيز','بقالة',
    'سوبرماركت','سوبر ماركت','ماركت','هايبر','كارفور','carrefour','سبينيس','spinneys','خير زمان','اولاد رجب',
    'فتح الله','بيم','كازيون','ميترو ماركت','جملة ماركت','لولو','تموين','جزار','فكهاني','خضري','فرارجي','سماك',
    'فرن','مخبز','لبان','ميني ماركت','كشك'],
  'مواصلات':[
    'مواصلة','اوبر','uber','careem','ديدي','didi','اندرايف','indrive','سويفل','swvl','بلت','bolt','تاكسي','taxi',
    'ميكروباص','مكروباص','ميكرو','توكتوك','تكتك','اتوبيس','اوتوبيس','باص','مترو','ترام','مونوريل','قطر','قطار',
    'سكة حديد','سوبرجيت','جو باص','go bus','بلو باص','عبارة','معدية','مركب','طيارة','طيران','تذكرة طيران',
    'بنزين','بنزينة','سولار','جاز','غاز طبيعي','بنزين ٩٢','بنزين ٩٥','محطة بنزين','عربية','عربيه','العربية',
    'موتوسيكل','موتوسكل','سكوتر','عجلة','دراجة','موقف','جراج','ركنة','باركينج','parking','سايس','كارتة','بوابة',
    'تذكرة','تذاكر','ميكانيكي','مكانيكي','ميكانيكا','كهربائي سيارات','سمكري','دوكو','كاوتش','كاوتشات','اطار',
    'بطارية العربية','زيت العربية','تغيير زيت','فلتر','فرامل','تيل','غسيل العربية','مغسلة','ترخيص','رخصة',
    'مخالفة','مخالفات','مرور','سواق','سائق','نقل','ونش','قسط العربية','تأمين العربية'],
  'بيت ومعيشة':[
    'شقة','البيت','منظفات','صابون','صابونة','مسحوق','اريال','برسيل','تايد','داوني','كلور','فلاش','ديتول',
    'ريحة','معطر','مناديل','فاين','ورق تواليت','ورق مطبخ','شامبو','بلسم','معجون','فرشة سنان','موس','شفرات',
    'مزيل','ليفة','اسفنجة','جوانتي','اكياس','اكياس زبالة','فوط','مقشة','جاروف','مساحة','ممسحة','سلك مواعين',
    'سائل اطباق','فيري','اثاث','عفش','نجار','سباك','كهربائي','نقاش','دهان','محارة','سيراميك','الوميتال',
    'صيانة','تصليح','تركيب','فني','بواب','حارس','شغالة','خدامة','عاملة نظافة','مكوجي','مكوة','غسيل','دراي كلين',
    'مطبخ','حلة','طاسة','اطباق','كوبايات','معالق','ادوات منزلية','ستاير','ستارة','سجاد','سجادة','مفروشات',
    'ملايات','بطانية','لحاف','مخدة','مرتبة','سرير','دولاب','كنبة','انتريه','سفرة','لمبة','لمبات','كشاف',
    'فيشة','وصلة','بطاريات','اسانسير','العمارة','صيانة العمارة','حاجات البيت','مستلزمات البيت','زرع','نباتات',
    'ايكيا','ikea','هوم سنتر','ايس','ace','تلاجة','غسالة','بوتاجاز','سخان','تكييف','مروحة','مكنسة','خلاط',
    'ميكروويف','فرن كهربا','مبيد','رش'],
  'الولد':[
    'ولد','الواد','بنت','البنت','عيال','العيال','اطفال','الاطفال','طفل','بيبي','baby','رضيع','بامبرز','pampers',
    'حفاضات','بامبرز','مولفكس','لبن اطفال','لبن صناعي','سيريلاك','ببرونة','بزازة','سكاته','مناديل مبللة',
    'حضانة','نيرسري','مدرسة','المدرسة','مدارس','مصاريف المدرسة','مصاريف مدرسة','باص المدرسة','شنطة المدرسة',
    'يونيفورم','زي المدرسة','دروس','درس','درس خصوصي','مدرس','مدرسة خصوصي','سنتر','مجموعة','كتب','كتاب',
    'كتب خارجية','كراسات','كشكول','ادوات مدرسية','ادوات مكتبية','مكتبة','اقلام','الوان','رحلة المدرسة',
    'لعب','لعبة','العاب','ليجو','عروسة','بلاي ستيشن العيال','تمرين','تمارين','سباحة','كورة','اكاديمية','كاراتيه',
    'جمباز','باليه','كورس','كورسات','حضانه','دكتور اطفال','تطعيم','تطعيمات','هدوم العيال','لبس العيال',
    'كيدز','kids','مصروف','مصروف العيال','عيد ميلاد'],
  'فواتير':[
    'فاتورة','فواتير','كهربا','كهرباء','الكهربا','نور','عداد','عداد الكهربا','كارت الكهربا','عداد مسبق الدفع',
    'شحن العداد','مياه البيت','فاتورة الميه','فاتورة المياه','عداد الميه','غاز','الغاز','انبوبة','انبوبه',
    'فاتورة الغاز','نت','انترنت','internet','واي فاي','وايفاي','wifi','راوتر','باقة','باقة النت','adsl',
    'رصيد','كارت شحن','كروت شحن','شحن','شحن رصيد','فكة','فودافون','vodafone','فودافون كاش','اورنج','orange',
    'اتصالات','etisalat','وي','we','تليفون','تليفون ارضي','ارضي','خط','موبايل الشهر','اشتراك','اشتراكات',
    'قسط','اقساط','تقسيط','فاليو','valu','سهولة','كونتكت','contact','امان','تامين','تأمين','تامينات','ضرايب',
    'ضريبة','عقارية','زبالة','نظافة','رسوم نظافة','دش','ريسيفر','اشتراك الدش','تجديد','صيانة الاسانسير',
    'اتحاد ملاك','فوري','fawry','ممكن','مدفوعات'],
  'صحة':[
    'دكتور','دكتورة','د.','طبيب','دكتورة اسنان','كشف','كشف دكتور','استشارة','عيادة','مستشفى','مستشفي',
    'طوارئ','اسعاف','صيدلية','صيدليه','pharmacy','العزبي','سيف','رشدي','دوا','دواء','ادوية','ادويه','روشتة',
    'علاج','مضاد','مضاد حيوي','مسكن','بنادول','panadol','كونجستال','اوجمنتين','فيتامين','فيتامينات','مكمل',
    'شراب كحة','نقط','قطرة','مرهم','كريم','لزقة','قطن','شاش','بلاستر','ترمومتر','جهاز ضغط','جهاز سكر','شرايط سكر',
    'انسولين','حقنة','حقن','محلول','تحليل','تحاليل','معمل','البرج','المختبر','اشعة','اشعه','سونار','رنين',
    'مقطعية','ايكو','رسم قلب','اسنان','سنان','ضرس','ضروس','حشو','تقويم','خلع','عصب','زراعة اسنان','نضارة',
    'نظارة','عدسات','كشف نظر','عيون','جلدية','باطنة','عظام','نسا','نسا وتوليد','علاج طبيعي','عملية',
    'جراحة','حجز','متابعة','جيم','gym','نادي صحي','بروتين','دايت','تغذية','اخصائي','نفسي','حلاق','كوافير',
    'صالون','بشرة','سكين كير'],
  'ترفيه':[
    'سينما','فيلم','افلام','مسرح','مسرحية','خروجة','خروجه','فسحة','نزهة','رحلة','رحلات','مصيف','ساحل',
    'الساحل','الغردقة','شرم','العين السخنة','اسكندرية','سفر','سفرية','اجازة','فندق','اوتيل','hotel',
    'شاليه','قرية','airbnb','حجز فندق','نادي','اشتراك النادي','بلايستيشن','بلاي ستيشن','playstation','ps5',
    'ps4','بلاي','العاب فيديو','جيمز','games','ستيم','steam','xbox','نتفليكس','netflix','شاهد','shahid',
    'osn','واتش ات','watch it','يانجو','سبوتيفاي','spotify','انغامي','anghami','يوتيوب','youtube','يوتيوب بريميوم',
    'ديزني','disney','شيشة','شيشه','سجاير','سجائر','سيجارة','دخان','معسل','فيب','vape','ايكوس','iqos',
    'حفلة','حفلات','كونسيرت','ماتش','تذكرة ماتش','بولينج','بلياردو','ملاهي','ملاهى','دريم بارك','مول العاب',
    'كافيه بلايستيشن','قعدة','سهرة','كارنيه','كتب روايات','رواية','هواية','صيد','كامب','تخييم'],
  'تسوق':[
    'لبس','هدوم','ملابس','قميص','قمصان','بنطلون','بنطلونات','جينز','تيشيرت','تيشرت','بلوزة','فستان','جيبة',
    'عباية','طرحة','حجاب','بيجامة','ترنج','بدلة','جاكيت','جاكت','سويت شيرت','هودي','بلوفر','كارديجان','شراب',
    'شرابات','بوكسر','داخلي','ملابس داخلية','جزمة','جزم','كوتشي','كوتشيات','شوز','صندل','شبشب','حذاء','شنطة',
    'شنط','محفظة','حزام','ساعة','نضارة شمس','برفان','عطر','بارفيوم','ميكب','مكياج','ميك اب','روج','ماسكرا',
    'كريمات','اكسسوار','اكسسوارات','خاتم','سلسلة','حلق','غويشة','دهب','فضة','موبايل','تليفون جديد','ايفون',
    'iphone','سامسونج','samsung','شاومي','xiaomi','جراب','اسكرينة','سماعة','سماعات','ايربودز','airpods','شاحن',
    'كابل','باور بانك','لابتوب','laptop','كمبيوتر','تابلت','ايباد','ipad','ماوس','كيبورد','شاشة','تليفزيون',
    'تلفزيون','جهاز','اجهزة','الكترونيات','امازون','amazon','نون','noon','جوميا','jumia','شي ان','shein',
    'تيمو','temu','علي اكسبرس','aliexpress','مول','سيتي ستارز','مول مصر','كايرو فستيفال','اوت لت','outlet',
    'سوق','عتبة','وكالة البلح','ديفاكتو','defacto','زارا','zara','اتش اند ام','h&m','ماكس','max','ال سي وايكيكي',
    'lc waikiki','تخفيضات','اوكازيون','عرض','اونلاين','شوبينج','shopping'],
  'أخرى':[
    'هدية','هدايا','صدقة','صدقات','زكاة','زكاه','تبرع','تبرعات','عيدية','عيديات','نقوط','عشور','كنيسة','جامع',
    'مسجد','نذر','كفارة','اضحية','رسوم','غرامة','بريد','شحنة','شحن طرد','شحنات','طوابع','توثيق','شهر عقاري',
    'محامي','محاماة','استخراج','بطاقة','باسبور','جواز سفر','تصديق','سجل مدني','قرض','عزاء','فرح',
    'خطوبة','مناسبة','واجب','سلفة','عربون','بقشيش','تيبس','طباعة','تصوير','ورق']
  ,
  'المرتب':['راتب','مرتب الشهر','قبض','القبض','قبضية','salary','بونص','bonus','حافز','حوافز','مكافأة','مكافئة',
    'اضافي','اوفر تايم','overtime','بدل','بدلات','علاوة','ارباح سنوية','منحة'],
  'عمولات':['عمولة','كوميشن','commission','تارجت','target','نسبة','نسبة مبيعات','صفقة','بيعة'],
  'إيجار الشقة':['ساكن','السكان','ايجار','ايجارات','مستأجر','المستأجر','ايجار المحل','ايجار الشقة'],
  'دخل آخر':['فريلانس','freelance','مشروع','بيع','بعت','شغل اضافي','شغلانة','بيزنس','business','ارباح',
    'فوايد','فايدة','عايد','شهادات','وديعة','سهم','اسهم','بورصة','cashback','استرداد','هدية فلوس',
    'نقطة','جمعية','قبضت الجمعية','ميراث','ورث']
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
