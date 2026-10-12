/* KPW2 reading dashboard - faithful port of the KPW5 "native reading time"
   optimized dashboard (L-1116 kindle-reading-records-enhanced 9.7.x,
   ui-calendar templates + Lua layout), scaled from the 1272x1696 design
   canvas to the KPW2 758x1024 screen (x0.596). Plain ES5 for the old
   KPW2 WebKit. Data format (data.js READING_DATA) unchanged.

   IMPORTANT (KPW2 mesquite WebView): the old WebKit does not reliably
   deliver click/touchend to individual elements, so we do NOT attach
   listeners to buttons. A single document-level tap detector watches for a
   light tap anywhere and dispatches by data-act attribute (same approach
   that already works on the device). Like the KPW5 original, every page is
   designed to fit one screen - no scrolling. */
(function(){
var MS=86400000;
var WEEKDAY=["周一","周二","周三","周四","周五","周六","周日"];
var HEAT=[255,235,210,180,145,105,70];  /* gray per heat level 0-6 */

var D,progressMap,byDate={},dayBooks={};

var today=new Date();today.setHours(0,0,0,0);
var state={
    tab:"daily",                 /* KPW5 opens on 每日时长 */
    calY:today.getFullYear(),calM:today.getMonth(),
    selDate:ymdOf(today),dcPage:1,
    ddPage:1,
    bookFilter:"7d",bookPage:1,
    bdId:null,
    /* 本书详情下半部分「阅读日历」的状态 */
    bdCalY:today.getFullYear(),bdCalM:today.getMonth(),bdCalInit:false,bdSelDate:"",
    tPeriod:"week",weekOffset:0,viewYear:today.getFullYear()
};

/* ---------- small helpers ---------- */
function el(id){return document.getElementById(id)}
function p2(n){return n<10?"0"+n:""+n}
function ymdOf(dt){return dt.getFullYear()+"-"+p2(dt.getMonth()+1)+"-"+p2(dt.getDate())}
function addDays(dt,n){return new Date(dt.getTime()+n*MS)}
function escHtml(s){return (""+s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}
function coverHtml(id,cls){
    var m=(typeof READING_COVERS!=="undefined"&&READING_COVERS)?READING_COVERS[id]:null;
    if(!m)return '<span class="'+cls+'"></span>';
    /* 铺满式封面（类似 cover 效果）：mesquite 对 background-size:cover +
       background-position:center 的组合会算错裁剪位置，所以用 <img> + JS
       计算 cover 尺寸（fitCover），配合 translate 绝对居中、overflow 裁边。 */
    return '<span class="'+cls+' cover-img"><img src="'+escHtml(m)+'" alt="" onload="fitCover(this)" /></span>';
}
/* 把封面 <img> 放大到正好盖满父框（等比、居中、超出被裁掉）。
   返回 true 表示已成功套用；返回 false 表示父框此刻不可见(尺寸0)，
   需等页面显示后再来一次。之所以不用 CSS：老 WebKit 不支持 object-fit，
   background 定位又有 bug。 */
function fitCover(img){
    var box=img.parentNode;
    if(!box)return false;
    var bw=box.offsetWidth,bh=box.offsetHeight;
    if(!bw||!bh)return false;
    var nw=img.naturalWidth,nh=img.naturalHeight;
    if(!nw||!nh){
        /* mesquite 上 naturalWidth 可能一直读不到（这是几轮修复都“没变化”
           的最终嫌疑）：用探针 new Image() 重取原始尺寸——这是老 WebKit
           最可靠的取图尺寸方式；探针加载完再算一次。 */
        if(!img._probe){
            img._probe=1;
            var p=new Image();
            p.onload=function(){img._probe=null;if(img.parentNode)fitCover(img);};
            p.src=img.src;
        }
        return false;
    }
    /* 等比铺满 + 像素坐标居中：不依赖 translate/百分比位移，
       left/top/width/height 全部用显式像素值，老 WebKit 绝对可靠。 */
    var s=Math.max(bw/nw,bh/nh),w=nw*s,h=nh*s;
    img.style.width=w.toFixed(1)+"px";
    img.style.height=h.toFixed(1)+"px";
    img.style.left=((bw-w)/2).toFixed(1)+"px";
    img.style.top=((bh-h)/2).toFixed(1)+"px";
    img.style.maxWidth="none";
    img.style.maxHeight="none";
    img.setAttribute("data-fit","1");
    return true;
}
/* 补算所有封面。关键：页面隐藏时(还没切到这一页)框尺寸为0，必须等页面
   真正显示后再算——所以“没算成功就绝不打 data-fit 标记”，待下次翻页时重试。
   注意：不能用 <img onload> 属性——mesquite 用 innerHTML 注入的 img 其
   inline onload 经常不触发；改为用 JS 显式挂 .onload，老 WebKit 可靠。 */
function fixAllCovers(){
    var imgs=document.querySelectorAll(".cover-img img");
    for(var i=0;i<imgs.length;i++){
        var im=imgs[i];
        if(im.getAttribute("data-fit"))continue;
        if(im.naturalWidth||im.complete){
            if(!fitCover(im)){
                (function(el){el.onload=function(){fitCover(el);};})(im);
            }
        }else{
            im.onload=function(){fitCover(this);};
        }
    }
}
/* 启动阶段补算封面：每 700ms 扫一遍未完成的封面，最多 8 次（约 5.6 秒）就停。
   算完的会被 data-fit 跳过；原先用常驻 setInterval 会让老内核在页面开着的
   全程每 700ms 做一次全量 DOM 查询（白耗电、拖慢翻页），改成有限次 +
   每次切页由 showPage 里的同步调用兜底。 */
var _coverTicks=0,_coverTimer=setInterval(function(){
    fixAllCovers();
    if(++_coverTicks>=8){clearInterval(_coverTimer);_coverTimer=null;}
},700);
function looksHex(t){return t&&t.length>=16&&!/[^0-9A-Fa-f]/.test(t)}
function better(a,b){
    if(!a||a==="unknown")return b;
    if(!b||b==="unknown")return a;
    if(looksHex(a)&&!looksHex(b))return b;
    return a;
}

/* ---------- time formats (identical to the KPW5 shell implementation) ---- */
function timeText(s){
    s=Math.round(s);var h=Math.floor(s/3600),m=Math.floor((s%3600)/60);
    if(h>0)return h+"小时"+m+"分钟";
    if(m>0)return m+"分钟"+(s%60)+"秒";
    return s+"秒";
}
function minuteText(s){
    var m=Math.floor(s/60);
    if(m>=60)return Math.floor(m/60)+"小时"+(m%60)+"分钟";
    return m+"分钟";
}
function chartTime(min){
    var h=Math.floor(min/60),r=min%60;
    if(h===0)return r+"min";
    if(r===0)return h+"h";
    return h+"h"+r+"min";
}
function calendarTime(s){
    var m=Math.floor(s/60);
    if(m<1)return s+"秒";
    if(m<60)return m+"分";
    return Math.floor(m/60)+"时"+(m%60)+"分";
}
function summaryTime(s){return s>0?timeText(s):"0分钟"}

/* ---------- data ---------- */
function dataReady(){
    /* data.js 是同步脚本，但 mesquite 上它可能晚于 app.js 生效：
       数据没到就画，用户会先看到“0/空”，过一会儿才被补齐。 */
    return !!(window.READING_DATA&&window.READING_DATA.entries);
}
function loadData(){
    D=window.READING_DATA||{entries:[],progress:[]};
    var entries=D.entries||[],i;
    progressMap={};byDate={};dayBooks={};
    for(i=0;i<(D.progress||[]).length;i++){
        var pr=D.progress[i];
        progressMap[pr[0]]=Number(pr[2])||0;
    }
    for(i=0;i<entries.length;i++){
        var e=entries[i],d=e[0],id=e[1],sec=Number(e[2])||0,title=e[3]||"";
        byDate[d]=(byDate[d]||0)+sec;
        if(sec>0){
            /* merge multiple 30s daemon ticks (and exact-duplicate lines) for
               the same book on the same day into one record */
            var map=dayBooks[d];
            if(!map)map=dayBooks[d]={};
            var rec=map[id];
            if(!rec){rec=map[id]={sec:0,title:better("",title),id:id}}
            else rec.title=better(rec.title,title);
            rec.sec+=sec;
        }
    }
    for(var d in dayBooks){
        var m=dayBooks[d],list=[];
        for(var k in m)list.push(m[k]);
        list.sort(function(a,b){return b.sec-a.sec||(a.title<b.title?-1:1)});
        dayBooks[d]=list;
    }
}
function booksInRange(startYmd,endYmd){
    var agg={},entries=(D&&D.entries)||[],i;
    for(i=0;i<entries.length;i++){
        var e=entries[i],d=e[0];
        if(d>=startYmd&&d<=endYmd){
            var sec=Number(e[2])||0;
            if(sec<=0)continue;
            var b=agg[e[1]];
            if(!b)b=agg[e[1]]={sec:0,title:"",id:e[1]};
            b.sec+=sec;
            b.title=better(b.title,e[3]||"");
        }
    }
    var list=[],k;
    for(k in agg)if(agg[k].sec>=1)list.push(agg[k]);   /* 看满1秒即收录 */
    list.sort(function(a,b){return b.sec-a.sec||(a.title<b.title?-1:1)});
    return list;
}

/* ---------- 每日时长 ---------- */
function heatLevel(s){
    if(s<=0)return 0;
    if(s<1800)return 1;
    if(s<3600)return 2;
    if(s<7200)return 3;
    if(s<10800)return 4;
    if(s<14400)return 5;
    return 6;
}
function renderDaily(){
    var y=state.calY,m=state.calM;
    el("monthTitle").textContent=y+"年"+(m+1)+"月";
    var first=new Date(y,m,1);
    var offset=(first.getDay()+6)%7;               /* Monday-first, 同KPW5 */
    var dim=new Date(y,m+1,0).getDate();
    var rows=Math.ceil((offset+dim)/7);
    var gridH=384,cellH=gridH/rows,cellW=668/7;
    var html="",i;
    for(i=0;i<rows*7;i++){
        var x=(i%7)*cellW,ry=Math.floor(i/7)*cellH;
        var day=i-offset+1;
        var cls="cal-box",inner="",bg="#fff";
        if(day>=1&&day<=dim){
            var ds=y+"-"+p2(m+1)+"-"+p2(day);
            var sec=byDate[ds]||0,lv=heatLevel(sec);
            if(lv>0){
                bg="rgb("+HEAT[lv]+","+HEAT[lv]+","+HEAT[lv]+")";
                if(lv>=5)cls+=" cal-ink-w";
            }
            if(ds===state.selDate)cls+=" cal-sel";
            /* 格子里的文字要“整体”垂直居中：有阅读时长=日期+时长两行(46px)，
               没有时长=只有日期一行(26px)。两种情况都按各自的高度算上下留白，
               不能像以前那样给日期加固定 margin-top + 时长贴底（那样永远不居中）。*/
            var boxH=(cellH-4),pad=0;
            if(sec>0){
                inner='<span class="cal-day">'+day+'</span>'+
                      '<span class="cal-min">'+escHtml(calendarTime(sec))+'</span>';
                pad=(boxH-46)/2;
            }else{
                inner='<span class="cal-day">'+day+'</span>';
                pad=(boxH-26)/2;
            }
            if(pad<0)pad=0;
            html+='<div class="'+cls+'" style="left:'+x.toFixed(1)+"px;top:"+ry.toFixed(1)+
                "px;width:"+(cellW-4).toFixed(1)+"px;height:"+boxH.toFixed(1)+
                "px;background:"+bg+'" data-act="day:'+ds+'">'+
                '<span class="cal-in" style="padding-top:'+pad.toFixed(1)+'px">'+inner+"</span></div>";
        }else{
            html+='<div class="'+cls+'" style="left:'+x.toFixed(1)+"px;top:"+ry.toFixed(1)+
                "px;width:"+(cellW-4).toFixed(1)+"px;height:"+(cellH-4).toFixed(1)+'px"></div>';
        }
    }
    el("calGrid").innerHTML=html;
    var wr=el("weekRow"),whtml="",j;
    for(j=0;j<7;j++){
        whtml+='<span style="left:'+(j*cellW+(cellW-95)/2).toFixed(1)+'px">'+WEEKDAY[j].charAt(1)+"</span>";
    }
    wr.innerHTML=whtml;
    var md=0,mt=0;
    for(j=1;j<=dim;j++){
        var d2=y+"-"+p2(m+1)+"-"+p2(j),s2=byDate[d2]||0;
        if(s2>0){md++;mt+=s2}
    }
    el("monthSummary").textContent="本月阅读 "+md+" 天  共 "+minuteText(mt);
}
function selDateParts(){
    var p=state.selDate.split("-");
    return {y:parseInt(p[0],10),m:parseInt(p[1],10),d:parseInt(p[2],10)};
}
/* 底部"当日速览"卡片（KPW5 daily 页第二个卡片） */
function renderDayCard(){
    var p=selDateParts();
    el("dayCardTitle").textContent=p.m+"月"+p.d+"日 阅读详情  \u203A";
    var list=dayBooks[state.selDate]||[];
    var total=byDate[state.selDate]||0;
    el("dayCardTotal").textContent=total>0?("共 "+timeText(total)):"";
    var cap=3,pages=Math.max(1,Math.ceil(list.length/cap));
    if(state.dcPage>pages)state.dcPage=pages;
    if(state.dcPage<1)state.dcPage=1;
    var html="",j;
    if(total<=0){
        html='<div class="dc-empty">当日无阅读记录</div>';
    }else{
        for(j=0;j<cap;j++){
            var idx=(state.dcPage-1)*cap+j;
            if(idx>=list.length)break;
            html+='<div class="dc-row"><span class="t">'+escHtml(list[idx].title)+
                '</span><span class="s">'+escHtml(timeText(list[idx].sec))+"</span></div>";
        }
    }
    el("dayCardRows").innerHTML=html;
    var oldPager=document.getElementById("dcPager");
    if(oldPager&&oldPager.parentNode)oldPager.parentNode.removeChild(oldPager);
    if(pages>1){
        var pg=document.createElement("div");
        pg.id="dcPager";
        pg.innerHTML='<button class="mini-btn dc-pager-prev" data-act="dcpage:prev">&#8249;</button>'+
            '<span id="dcPageLabel">'+state.dcPage+" / "+pages+"</span>"+
            '<button class="mini-btn dc-pager-next" data-act="dcpage:next">&#8250;</button>';
        el("dayCard").appendChild(pg);
    }
}

/* ---------- 阅读书籍 ---------- */
/* 当前筛选（近7日/本月/今年）命中的书单。renderBooks 与翻页都要用，抽成一个函数避免两处逻辑跑偏。 */
function booksForFilter(){
    var start;
    if(state.bookFilter==="7d")start=addDays(today,-6);
    else if(state.bookFilter==="month")start=new Date(today.getFullYear(),today.getMonth(),1);
    else start=new Date(today.getFullYear(),0,1);
    return booksInRange(ymdOf(start),ymdOf(today));
}
function bookPageCount(){return Math.max(1,Math.ceil(booksForFilter().length/3));}
function renderBooks(){
    var list=booksForFilter();
    var pages=Math.max(1,Math.ceil(list.length/3));
    if(state.bookPage>pages)state.bookPage=pages;
    if(state.bookPage<1)state.bookPage=1;
    var html="",j;
    for(j=0;j<3;j++){
        var idx=(state.bookPage-1)*3+j;
        if(idx>=list.length)break;
        var o=list[idx],prog=progressMap[o.id];
        var pr="";
        if(prog>0){
            if(prog>100)prog=100;
            pr='<span class="p">阅读进度  '+prog+"%</span>"+
               '<span class="bk-bar"><i style="width:'+Math.round(prog*495/100)+'px"></i></span>';
        }else{
            pr='<span class="np">暂无进度</span>';
        }
        html+='<div class="bk-row" data-act="book:'+escHtml(o.id)+'" style="top:'+(j*215)+'px">'+
            coverHtml(o.id,"bk-cover")+
            '<span class="t">'+escHtml(o.title)+"</span>"+
            '<span class="s">阅读 '+escHtml(timeText(o.sec))+"</span>"+pr+"</div>";
        if(j<2&&idx+1<list.length){
            html+='<div class="bk-div" style="top:'+((j+1)*215-1)+'px"></div>';
        }
    }
    if(!list.length)html='<div class="bk-empty">当前范围暂无阅读记录</div>';
    el("bookRows").innerHTML=html;
    el("bookPage").textContent="第 "+state.bookPage+" 页，共 "+pages+" 页";
    var ids=["bf-7d","bf-month","bf-year"],k;
    for(k=0;k<ids.length;k++){
        var b=el(ids[k]);
        b.className=(b.getAttribute("data-act")==="bf:"+state.bookFilter)?"fbtn active":"fbtn";
    }
}

/* ---------- 累计时长 ---------- */
function weekValues(){
    var start=addDays(today,-((today.getDay()+6)%7)+state.weekOffset*7);
    var vals=[],labels=[],i,dark=-1;
    for(i=0;i<7;i++){
        var d=addDays(start,i),ds=ymdOf(d);
        vals.push(Math.round((byDate[ds]||0)/60));
        labels.push(WEEKDAY[i]);
        if(ds===ymdOf(today))dark=i;
    }
    var total=0,days=0;
    for(i=0;i<7;i++){var s=(byDate[ymdOf(addDays(start,i))]||0);if(s>0){days++;total+=s}}
    var f=function(dt){return (dt.getMonth()+1)+"月"+dt.getDate()+"日"};
    return {vals:vals,labels:labels,dark:dark,total:total,days:days,
        title:f(start)+" - "+f(addDays(start,6)),titleBig:false};
}
function yearValues(){
    var y=state.viewYear,vals=[],labels=[],i,total=0,days=0;
    var todayYmd=ymdOf(today);
    for(i=1;i<=12;i++){
        var pre=y+"-"+p2(i)+"-",d;
        for(d in byDate){
            if(d.indexOf(pre)===0&&d<=todayYmd){
                var s=byDate[d];
                vals[i-1]=(vals[i-1]||0)+Math.round(s/60);
                if(s>0){days++;total+=s}
            }
        }
    }
    for(i=0;i<12;i++){vals[i]=vals[i]||0;labels.push((i+1)+"月")}
    var dark=(y===today.getFullYear())?today.getMonth():-1;
    return {vals:vals,labels:labels,dark:dark,total:total,days:days,
        title:y+"年",titleBig:true};
}
function renderTotal(){
    var v=(state.tPeriod==="week")?weekValues():yearValues();
    el("bigTotal").textContent=summaryTime(v.total);
    el("sumDays").textContent="阅读天数  "+v.days+"天";
    var avg=0;
    if(v.days>0)avg=Math.floor((v.total+v.days*30)/(v.days*60))*60;
    el("sumAvg").textContent="阅读日均  "+minuteText(avg);
    el("tt-week").className=(state.tPeriod==="week")?"tgl active":"tgl";
    el("tt-year").className=(state.tPeriod==="year")?"tgl active":"tgl";
    var pt=el("periodTitle");
    pt.textContent=v.title;
    /* 周期标题放大：周视图「10月12日 - 10月18日」原来只有 18px，偏小；
       年视图「2026年」保持更大一号。垂直居中由 CSS 的 line-height:48 保证。 */
    pt.style.fontSize=v.titleBig?"26px":"22px";
    drawChart(v);
}
function drawChart(v){
    var W=668,base=376,chH=352;
    var max=0,i;
    for(i=0;i<v.vals.length;i++)if(v.vals[i]>max)max=v.vals[i];
    var scaleH=Math.max(1,Math.ceil(max*112/6000));      /* 同KPW5, ~12%余量 */
    var tick;
    if(state.tPeriod==="week"){
        tick=scaleH<=3?1:scaleH<=8?2:scaleH<=15?3:5;
    }else{
        var vv=scaleH/5,p=1;
        while(vv>=10){vv/=10;p*=10}
        tick=(vv<1.5?1:vv<3.5?2:vv<7.5?5:10)*p;
    }
    var scale=scaleH*60;
    var maxLbl=1,g;
    for(g=tick;g<=scaleH;g+=tick){var t=""+g+"h";if(t.length>maxLbl)maxLbl=t.length}
    var axisW=maxLbl*8+4,plotLeft=4+axisW+17,plotRight=W-10,plotW=plotRight-plotLeft;
    var html="";
    for(g=tick;g<=scaleH;g+=tick){
        var gy=base-chH*(g*60)/scale;
        html+='<div class="ch-grid" style="left:'+plotLeft+"px;top:"+gy.toFixed(1)+"px;width:"+plotW+'px"></div>'+
            '<span class="ch-gridlabel" style="left:0;top:'+(gy-15).toFixed(1)+"px;width:"+(4+axisW)+'px">'+g+"h</span>";
    }
    html+='<div class="ch-base" style="left:'+plotLeft+"px;top:"+(base-2)+"px;width:"+plotW+'px"></div>';
    var n=v.vals.length,barW=(n===7)?52:35;   /* 柱条适度加宽（原来是 45/29） */
    for(i=0;i<n;i++){
        var center=plotLeft+plotW*(2*i+1)/(2*n);
        var mins=v.vals[i],bh=mins*chH/scale;
        if(mins>0&&bh<5)bh=5;
        if(mins>0){
            var color=(i===v.dark)?"#1a1a1a":"#7d7d7d";
            html+='<div class="ch-bar" style="left:'+(center-barW/2).toFixed(1)+"px;top:"+(base-bh).toFixed(1)+
                "px;width:"+barW+"px;height:"+bh.toFixed(1)+"px;background:"+color+'"></div>';
            html+='<span class="ch-val" style="left:'+(center-40).toFixed(1)+"px;top:"+(base-bh-20).toFixed(1)+
                'px;width:80px">'+chartTime(mins)+"</span>";
        }
        html+='<span class="ch-axis" style="left:'+(center-40).toFixed(1)+"px;top:"+(base+8).toFixed(1)+'px;width:80px">'+
            escHtml(v.labels[i])+"</span>";
    }
    el("chart").innerHTML=html;
}

/* ---------- 阅读详情（day_detail 下钻页） ---------- */
function renderDayDetail(){
    var p=selDateParts();
    el("ddDate").textContent=p.y+"年"+p.m+"月"+p.d+"日";
    var dt=new Date(p.y,p.m-1,p.d);
    el("ddWeekday").textContent=WEEKDAY[(dt.getDay()+6)%7];
    var list=dayBooks[state.selDate]||[];
    var total=byDate[state.selDate]||0;
    el("ddTotal").textContent=summaryTime(total);
    el("ddCount").textContent=list.length+"本";
    var cap=3,pages=Math.max(1,Math.ceil(list.length/cap));
    if(state.ddPage>pages)state.ddPage=pages;
    if(state.ddPage<1)state.ddPage=1;
    var html="",j;
    if(!list.length){
        html='<div class="dd-empty">当日暂无阅读记录</div>';
    }else{
        for(j=0;j<cap;j++){
            var idx=(state.ddPage-1)*cap+j;
            if(idx>=list.length)break;
            var o=list[idx];
            var ratio=total>0?Math.floor((o.sec*100+total/2)/total):0;
            if(ratio>100)ratio=100;
            html+='<div class="dd-row" style="top:'+(j*150)+'px">'+
                coverHtml(o.id,"dd-cover")+
                '<span class="t">'+escHtml(o.title)+"</span>"+
                '<span class="s">'+escHtml(timeText(o.sec))+"</span>"+
                '<span class="p">'+ratio+"%</span></div>";
        }
    }
    el("ddRows").innerHTML=html;
    var pager=el("ddPager");
    if(pages>1){
        pager.className="";
        el("ddPageLabel").textContent=state.ddPage+" / "+pages;
    }else{
        pager.className="hidden";
    }
}

/* ---------- 本书详情（点书籍下钻：看这本书哪天读了多久） ---------- */
function renderBookDetail(){
    var id=state.bdId;
    if(!id)return;
    var entries=(D&&D.entries)||[],i,e;
    var title="";
    var dayMap={};                       /* 日期 -> 当日秒数（tsv 一天多条，须聚合） */
    var total=0;
    for(i=0;i<entries.length;i++){
        e=entries[i];
        if(e[1]!==id)continue;
        title=better(title,e[3]||"");
        var d=e[0],sec=Number(e[2])||0;
        if(sec>0){dayMap[d]=(dayMap[d]||0)+sec;total+=sec;}
    }
    /* 统计值（全部时间口径，与筛选无关） */
    var days=0,first="",last="";
    for(var dk in dayMap){
        days++;
        if(first===""||dk<first)first=dk;
        if(last===""||dk>last)last=dk;
    }
    /* 本月阅读 */
    var mpre=ymdOf(today).slice(0,7),monthSec=0;
    for(var mk in dayMap){if(mk.slice(0,7)===mpre)monthSec+=dayMap[mk];}
    /* 阅读进度（来自 Kindle 目录库，progress=[[book_id,书名,百分比]]） */
    var prog="";
    var pl=(D&&D.progress)||[];
    for(i=0;i<pl.length;i++){
        if(pl[i]&&pl[i][0]===id){prog=Number(pl[i][2])+"%";break;}
    }
    /* 封面框直接就是 #bdCover（HTML 里已带 bd-sum-cover 定位类）。
       不能再包一层普通 span：mesquite 对"绝对定位元素套在无定位行内
       元素里"会算错包含块，把封面锚到卡片顶部（书名高度），导致封面
       偏高、不与"累计阅读"齐平。直接注入 <img>，零嵌套。 */
    var cm=(typeof READING_COVERS!=="undefined"&&READING_COVERS)?READING_COVERS[id]:null;
    el("bdCover").innerHTML=cm?'<img src="'+escHtml(cm)+'" alt="" />':"";
    el("bdName").textContent=title||"(未命名)";
    el("bdValT").textContent=summaryTime(total);
    el("bdValD").textContent=days+"天";
    el("bdValF").textContent=first||"—";
    el("bdValL").textContent=last||"—";
    el("bdValM").textContent=summaryTime(monthSec);
    el("bdValP").textContent=prog||"—";
    renderBookCalendar(dayMap);
}

/* ---------- 本书的「阅读日历」（替换原来的「每日阅读明细」列表） ----------
   dayMap: {"YYYY-MM-DD": 秒}，只含这本书的每日时长。 */
function latestDayIn(dayMap,ym){
    var best="";
    for(var k in dayMap){
        if(ym&&k.slice(0,7)!==ym)continue;
        if(best===""||k>best)best=k;
    }
    return best;
}
function renderBookCalendar(dayMap){
    /* 第一次进入本书：默认落在"最近有阅读的那个月" */
    if(!state.bdCalInit){
        var md0=latestDayIn(dayMap,"");
        if(md0){state.bdCalY=parseInt(md0.slice(0,4),10);state.bdCalM=parseInt(md0.slice(5,7),10)-1;}
        else{state.bdCalY=today.getFullYear();state.bdCalM=today.getMonth();}
        state.bdCalInit=true;
        state.bdSelDate="";
    }
    var y=state.bdCalY,m=state.bdCalM;
    var ym=y+"-"+p2(m+1);
    /* 选中日：没选、或选的日期不在当前显示的月份 → 取本月最后一个有阅读的日子 */
    if(!state.bdSelDate||state.bdSelDate.slice(0,7)!==ym)state.bdSelDate=latestDayIn(dayMap,ym);
    el("bdCalTitle").textContent=y+"年"+(m+1)+"月";
    var first=new Date(y,m,1);
    var offset=(first.getDay()+6)%7;                 /* 周一开头，与每日页一致 */
    var dim=new Date(y,m+1,0).getDate();
    var rows=Math.ceil((offset+dim)/7);
    var gridH=364,cellH=gridH/rows,cellW=651/7;
    /* 若这本书每天读的量都很小（绝对刻度下全是第1档），按本书自身最大值放大刻度，
       否则格子里几乎看不出深浅差别（用户的数据每天只有几分钟）。 */
    var maxSec=0,kk;
    for(kk in dayMap){if(dayMap[kk]>maxSec)maxSec=dayMap[kk];}
    var promote=heatLevel(maxSec)<=1;
    var html="",i;
    for(i=0;i<rows*7;i++){
        var x=(i%7)*cellW,ry=Math.floor(i/7)*cellH;
        var day=i-offset+1;
        var cls="cal-box",inner="",bg="#fff",boxH=cellH-4;
        if(day>=1&&day<=dim){
            var ds=ym+"-"+p2(day);
            var sec=dayMap[ds]||0,lv=0;
            if(sec>0){
                if(!promote)lv=heatLevel(sec);
                else{
                    lv=Math.round(sec/maxSec*3)+2;
                    if(lv<2)lv=2;
                    if(lv>5)lv=5;
                }
            }
            if(lv>0){
                bg="rgb("+HEAT[lv]+","+HEAT[lv]+","+HEAT[lv]+")";
                if(lv>=5)cls+=" cal-ink-w";
            }
            if(ds===state.bdSelDate)cls+=" cal-sel";
            /* 格子里只有日期（同图一），整组按格子高度垂直居中 */
            var pad=(boxH-26)/2;
            if(pad<0)pad=0;
            inner='<span class="cal-day">'+day+"</span>";
            html+='<div class="'+cls+'" style="left:'+x.toFixed(1)+"px;top:"+ry.toFixed(1)+
                "px;width:"+(cellW-4).toFixed(1)+"px;height:"+boxH.toFixed(1)+
                "px;background:"+bg+'" data-act="bdday:'+ds+'">'+
                '<span class="cal-in" style="padding-top:'+pad.toFixed(1)+'px">'+inner+"</span></div>";
        }else{
            html+='<div class="'+cls+'" style="left:'+x.toFixed(1)+"px;top:"+ry.toFixed(1)+
                "px;width:"+(cellW-4).toFixed(1)+"px;height:"+boxH.toFixed(1)+'px"></div>';
        }
    }
    el("bdCalGrid").innerHTML=html;
    var wh="",j;
    for(j=0;j<7;j++){
        wh+='<span style="left:'+(j*cellW+(cellW-93)/2).toFixed(1)+'px">'+WEEKDAY[j].charAt(1)+"</span>";
    }
    el("bdWeekRow").innerHTML=wh;
    /* 底部一行：所选日期 + 当天读了多久（同图一的「2026年10月11日 · 阅读 4小时33分钟」） */
    var sel=state.bdSelDate;
    if(sel&&sel.slice(0,7)===ym){
        var sp=sel.split("-"),sec2=dayMap[sel]||0;
        el("bdCalSummary").textContent=sp[0]+"年"+parseInt(sp[1],10)+"月"+parseInt(sp[2],10)+"日 · "+
            (sec2>0?("阅读 "+timeText(sec2)):"未阅读");
    }else{
        el("bdCalSummary").textContent="本月暂无阅读记录";
    }
}

/* ---------- page switching ---------- */
var _origShowPage;
function showPage(name){
    var names=["daily","books","total","daydetail","bookdetail"],j;
    for(j=0;j<names.length;j++){
        var pg=el("page-"+names[j]);
        if(!pg)continue;
        if(names[j]===name){
            pg.className=(name==="daydetail"||name==="bookdetail")?"page page-full":"page";
        }else{
            pg.className="page hidden";
        }
    }
    var tb=document.querySelectorAll(".tab"),k;
    for(k=0;k<tb.length;k++){
        var isAct=(tb[k].getAttribute("data-act")==="tab:"+name);
        tb[k].className=isAct?"tab active":"tab";
    }
    /* detail pages: dedicate the whole top-left corner to "back" */
    var detail=(name==="daydetail"||name==="bookdetail");
    var bz=el("backZone");
    if(bz){
        if(detail){
            bz.className="";
            bz.setAttribute("data-act",name==="daydetail"?"dback":"bdback");
        }else{
            bz.className="hidden";
            bz.setAttribute("data-act","");
        }
    }
    if(name==="daily"){renderDaily();renderDayCard()}
    else if(name==="books")renderBooks();
    else if(name==="total")renderTotal();
    else if(name==="daydetail")renderDayDetail();
    else if(name==="bookdetail")renderBookDetail();
}

/* ---------- global tap dispatcher (KPW2-safe) ---------- */
function findAct(node){
    while(node&&node!==document.body){
        if(node.getAttribute&&node.getAttribute("data-act"))return node.getAttribute("data-act");
        node=node.parentNode;
    }
    return null;
}
function dispatch(act){
    if(!act)return;
    var p=act.indexOf(":"),cmd=act,arg="";
    if(p>=0){cmd=act.substring(0,p);arg=act.substring(p+1)}
    if(cmd==="tab"){state.tab=arg;showPage(arg)}
    else if(cmd==="month"){
        if(arg==="prev"){state.calM--;if(state.calM<0){state.calM=11;state.calY--}}
        else{state.calM++;if(state.calM>11){state.calM=0;state.calY++}}
        renderDaily();
    }
    else if(cmd==="day"){state.selDate=arg;state.dcPage=1;renderDaily();renderDayCard()}
    else if(cmd==="dopen"){state.ddPage=1;showPage("daydetail")}
    else if(cmd==="dback"){showPage(state.tab)}
    else if(cmd==="book"){state.bdId=arg;state.bdCalInit=false;state.bdSelDate="";showPage("bookdetail")}
    else if(cmd==="bdback"){showPage("books")}
    /* 本书详情里的「阅读日历」翻月 / 点选某一天 */
    else if(cmd==="bdcal"){
        if(arg==="prev"){state.bdCalM--;if(state.bdCalM<0){state.bdCalM=11;state.bdCalY--}}
        else{state.bdCalM++;if(state.bdCalM>11){state.bdCalM=0;state.bdCalY++}}
        state.bdSelDate="";
        renderBookDetail();
    }
    else if(cmd==="bdday"){state.bdSelDate=arg;renderBookDetail()}
    else if(cmd==="dcpage"){
        if(arg==="prev"){if(state.dcPage>1)state.dcPage--}else state.dcPage++;
        renderDayCard();
    }
    else if(cmd==="dpage"){
        if(arg==="prev"){if(state.ddPage>1)state.ddPage--}else state.ddPage++;
        renderDayDetail();
    }
    else if(cmd==="bf"){state.bookFilter=arg;state.bookPage=1;renderBooks()}
    else if(cmd==="bpg"){
        var bpages=bookPageCount();
        if(arg==="prev"){if(state.bookPage>1)state.bookPage--;}
        else{if(state.bookPage<bpages)state.bookPage++;}
        renderBooks();
    }
    else if(cmd==="tp"){state.tPeriod=arg;renderTotal()}
    else if(cmd==="tnav"){
        if(state.tPeriod==="week"){
            if(arg==="prev")state.weekOffset--;else state.weekOffset++;
        }else{
            if(arg==="prev")state.viewYear--;else state.viewYear++;
        }
        renderTotal();
    }
}
var tapX=0,tapY=0,tapT=0,lastHandled=0;
document.addEventListener("touchstart",function(e){
    if(e.touches.length!==1){tapT=0;return}
    tapX=e.touches[0].clientX;tapY=e.touches[0].clientY;tapT=Date.now();
},false);
document.addEventListener("touchend",function(e){
    if(tapT===0)return;
    var ct=e.changedTouches&&e.changedTouches[0];
    var dx=0,dy=0;
    if(ct){dx=ct.clientX-tapX;dy=ct.clientY-tapY}
    var dt=Date.now()-tapT;
    tapT=0;
    if(Math.abs(dx)<12&&Math.abs(dy)<12&&dt<700){
        var act=findAct(e.target);
        if(act){lastHandled=Date.now();dispatch(act)}
    }
},false);
/* desktop / preview fallback: real click also works */
document.addEventListener("click",function(e){
    if(Date.now()-lastHandled<700)return;
    var act=findAct(e.target);
    if(act){e.preventDefault();lastHandled=Date.now();dispatch(act)}
},false);

/* ---------- fixed 5% shrink, centered in the ACTUAL viewport -------------
   Keep the original full-screen layout, scale the whole frame to 95%, and
   center it using the real visible area (not the assumed 758x1024), so the
   bottom pager stays fully visible and nothing looks off-center. */
/* 连续两次量到相同尺寸、且间隔≥150ms 才算“系统布局已稳定”。
   只量一次就显示会在 mesquite 画完工具条前抢跑（工具条会吃掉一段高度，
   首帧按虚高尺寸居中 → 系统画完工具条再 resize → 用户看到“跳一下”）。 */
var _fitLastW=0,_fitLastH=0,_fitLastT=0,_fitTimer=null,_readyTs=0;
/* 舞台留白 = 0，画面按真实可视区铺满。
   设备可视高 908，设计高 978 → s=908/978=0.9284，缩放后正好 908，满屏。
   这就是用户认可的「删掉退出键之前刚刚好」的大小。
   （上一轮为躲工具栏加了上下各 12px 留白，s 掉到 884/978=0.9039，
     整屏缩小 2.6%，用户立刻察觉「整个画面缩小了」→ 撤销该改动。）
   而「顶部缺一小块」的真因是：原来左上角的「退出」按钮 top 很小、贴顶，
   其上边框被浏览器工具栏压住。该按钮已删除，现在顶部最高元素是标题
   （top:26px，缩放后约 24px），不会再被压到，所以铺满即可。 */
function applyFit(f,w,h){
    var s=Math.min(0.95,w/738,h/978);
    if(s<0.5)s=0.5;
    /* mesquite's old WebKit only honours the -webkit- prefixed transform */
    f.style.webkitTransformOrigin="0 0";
    f.style.transformOrigin="0 0";
    f.style.webkitTransform="scale("+s.toFixed(4)+")";
    f.style.transform="scale("+s.toFixed(4)+")";
    f.style.left=Math.round((w-738*s)/2)+"px";
    f.style.top=Math.round((h-978*s)/2)+"px";
    if(!/\bready\b/.test(f.className))f.className=(f.className+" ready").trim();
    f.style.visibility="visible";
}
function fitStage(){
    var f=document.getElementById("frame");
    if(!f)return;
    var de=document.documentElement||{};
    var w=de.clientWidth||window.innerWidth||0;
    var h=de.clientHeight||window.innerHeight||0;
    var hide=function(){
        if(/\bready\b/.test(f.className))f.className=f.className.replace(/\bready\b/g," ").trim();
        f.style.visibility="hidden";
    };
    var now=(new Date()).getTime();
    if(dataReady()&&!_readyTs)_readyTs=now;
    /* 尺寸不可信（0/默认值/过小）→ 保持隐藏；数据没到、或刚到不足 80ms
       （画面还没画稳）也先别亮 —— 否则用户第一眼是“0/空”，随后才被“补齐”。
       这里的每一毫秒都是用户盯着看的白屏，所以压到 80ms（原 120ms）。 */
    if(!(w>0&&h>0&&w>=700&&h>=800)||!_readyTs||(now-_readyTs)<80){
        _fitLastW=0;_fitLastH=0;_fitLastT=0;
        hide();
        if(_fitTimer)clearTimeout(_fitTimer);
        _fitTimer=setTimeout(fitStage,50);
        return;
    }
    if(w===_fitLastW&&h===_fitLastH&&(now-_fitLastT)>=80){
        _fitTimer=null;
        applyFit(f,w,h);
        return;
    }
    if(w!==_fitLastW||h!==_fitLastH){_fitLastW=w;_fitLastH=h;_fitLastT=now;}
    hide();
    if(_fitTimer)clearTimeout(_fitTimer);
    _fitTimer=setTimeout(fitStage,50);
}
window.addEventListener("resize",fitStage,false);

/* ---------- boot / robust re-render (keeps the "first open shows 0" fix) -- */
var currentTab=state.tab;
/* 数据没就绪时不画、也不亮屏（#frame 一直隐藏），等 data.js 到位后一次性
   画好再亮 —— 这样第一眼就是完整画面。旧版会先画一版空的再补渲染，
   在老浏览器上就是用户看到的“先残缺、过一会才补齐”。
   defer=true 时先只画首屏（每日页），书籍页/累计页推到首屏绘制之后再补：
   书籍页要注入 78 张封面、累计页要算 12 根柱子，同步做完会让白屏多等
   好几百毫秒（KPW2 上很肉）。切页时 showPage 会再补一次，不会看到空页。 */
function renderAll(defer){
    loadData();
    renderDaily();renderDayCard();
    if(defer){
        setTimeout(function(){renderBooks();renderTotal();fixAllCovers();},50);
    }else{
        renderBooks();renderTotal();
    }
}
function boot(){
    if(dataReady()){
        renderAll(true);
        showPage(currentTab);
    }
    fitStage();
    setTimeout(fixAllCovers,300);
    setTimeout(fixAllCovers,700);
}
function renderWhenReady(){
    if(!dataReady())return false;
    renderAll(true);showPage(currentTab);fitStage();
    return true;
}
_origShowPage=showPage;
showPage=function(name){
    if(name!=="daydetail"&&name!=="bookdetail")currentTab=name;
    _origShowPage(name);
    fixAllCovers();
};
if(document.readyState==="loading"){
    document.addEventListener("DOMContentLoaded",boot,false);
}else{
    boot();
}
if(!dataReady()){
    /* 数据晚到：一开始不画不亮，数据一到立即画好并亮屏（只画一次） */
    window.addEventListener("load",renderWhenReady,false);
    setTimeout(renderWhenReady,350);
    (function(){
        var tries=0;
        var t=setInterval(function(){
            tries++;
            if(renderWhenReady()){clearInterval(t);return;}
            if(tries>40)clearInterval(t);   /* 最多等 6 秒 */
        },150);
    })();
}
/* 保险：若 2.5s 后数据仍未就绪（data.js 缺失或极慢），先画一版并强制亮屏，
   避免一直白屏；正常情况下 2.5s 前早就借着数据亮屏了。 */
setTimeout(function(){
    var f=document.getElementById("frame");
    if(!f)return;
    if(!dataReady()){renderAll();showPage(currentTab);}
    if(!/\bready\b/.test(f.className)){
        var de=document.documentElement||{};
        var w=de.clientWidth||window.innerWidth||758;
        var h=de.clientHeight||window.innerHeight||1024;
        applyFit(f,w,h);
    }
},2500);
}());
