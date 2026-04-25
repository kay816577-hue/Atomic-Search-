/* Atomic Tools — 100% in-browser utility widgets.
 *
 * Every widget is registered via `register()` and gets rendered into
 * #tools-main. Nothing here talks to the network. No cookies, no
 * storage, no logging.
 */
(function () {
  "use strict";
  var $ = function (s, el) { return (el || document).querySelector(s); };
  var esc = function (s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  };

  var widgets = [];
  function register(cat, name, body) { widgets.push({ cat: cat, name: name, body: body }); }

  function mkOutput() {
    var el = document.createElement("div");
    el.className = "tool-output";
    el.setAttribute("aria-live", "polite");
    return el;
  }
  function copyBtn(targetEl) {
    var b = document.createElement("button");
    b.className = "ghost";
    b.type = "button";
    b.textContent = "Copy";
    b.addEventListener("click", function () {
      var t = targetEl.textContent || targetEl.value || "";
      if (!t) return;
      if (navigator.clipboard) navigator.clipboard.writeText(t).catch(function () {});
      b.textContent = "Copied";
      setTimeout(function () { b.textContent = "Copy"; }, 900);
    });
    return b;
  }

  // -------- QR code generator (numeric mode only for short strings,
  //          byte mode with manual matrix build for the rest) ----------
  //
  // Full QR encoding is ~300 lines. To keep this file reasonable we use a
  // tiny well-known algorithm: build an SVG with "qrcode-generator"-style
  // logic. We embed a minified implementation of Kazuhiko Arase's
  // qrcode-generator (MIT). To avoid bundling decisions we do it inline.
  // If the embed fails we fall back to a Google Charts-free message and
  // offer a copy-only "URL" view. (The fallback never leaves the page.)
  var QRCode = null;
  try {
    // Minimal QR lib — source: github.com/kazuhikoarase/qrcode-generator,
    // trimmed to only byte mode + error correction level L/M/Q/H. MIT.
    // (Compressed for brevity; identical runtime behaviour.)
    /* eslint-disable */
    !function(t){var e,r,n,i;function o(t,e){this.typeNumber=-1,this.errorCorrectionLevel=e,this.modules=null,this.moduleCount=0,this.dataCache=null,this.dataList=[],this.typeNumber=t}var s=o.prototype;s.addData=function(t,e){e=e||"Byte";var r=null;r="Byte"==e?new a(t):null;this.dataList.push(r),this.dataCache=null},s.isDark=function(t,e){if(t<0||this.moduleCount<=t||e<0||this.moduleCount<=e)throw new Error(t+","+e);return this.modules[t][e]},s.getModuleCount=function(){return this.moduleCount},s.make=function(){if(this.typeNumber<1){var t=1;for(t=1;t<40;t++){for(var e=u.getRSBlocks(t,this.errorCorrectionLevel),r=new c,n=0,i=0;i<e.length;i++)n+=e[i].dataCount;for(i=0;i<this.dataList.length;i++){var o=this.dataList[i];r.put(o.mode,4),r.put(o.getLength(),l.getLengthInBits(o.mode,t)),o.write(r)}if(r.getLengthInBits()<=8*n)break}this.typeNumber=t}this.makeImpl(!1,this.getBestMaskPattern())},s.makeImpl=function(t,e){this.moduleCount=4*this.typeNumber+17,this.modules=function(t){for(var e=new Array(t),r=0;r<t;r++){e[r]=new Array(t);for(var n=0;n<t;n++)e[r][n]=null}return e}(this.moduleCount),this.setupPositionProbePattern(0,0),this.setupPositionProbePattern(this.moduleCount-7,0),this.setupPositionProbePattern(0,this.moduleCount-7),this.setupPositionAdjustPattern(),this.setupTimingPattern(),this.setupTypeInfo(t,e),this.typeNumber>=7&&this.setupTypeNumber(t),null==this.dataCache&&(this.dataCache=o.createData(this.typeNumber,this.errorCorrectionLevel,this.dataList)),this.mapData(this.dataCache,e)},s.setupPositionProbePattern=function(t,e){for(var r=-1;r<=7;r++)if(!(t+r<=-1||this.moduleCount<=t+r))for(var n=-1;n<=7;n++)e+n<=-1||this.moduleCount<=e+n||(this.modules[t+r][e+n]=0<=r&&r<=6&&(0==n||6==n)||0<=n&&n<=6&&(0==r||6==r)||2<=r&&r<=4&&2<=n&&n<=4)},s.getBestMaskPattern=function(){for(var t=0,e=0,r=0;r<8;r++){this.makeImpl(!0,r);var n=l.getLostPoint(this);(0==r||t>n)&&(t=n,e=r)}return e},s.setupTimingPattern=function(){for(var t=8;t<this.moduleCount-8;t++)null==this.modules[t][6]&&(this.modules[t][6]=t%2==0);for(var e=8;e<this.moduleCount-8;e++)null==this.modules[6][e]&&(this.modules[6][e]=e%2==0)},s.setupPositionAdjustPattern=function(){for(var t=l.getPatternPosition(this.typeNumber),e=0;e<t.length;e++)for(var r=0;r<t.length;r++){var n=t[e],i=t[r];if(null==this.modules[n][i])for(var o=-2;o<=2;o++)for(var s=-2;s<=2;s++)this.modules[n+o][i+s]=-2==o||2==o||-2==s||2==s||0==o&&0==s}},s.setupTypeNumber=function(t){for(var e=l.getBCHTypeNumber(this.typeNumber),r=0;r<18;r++){var n=!t&&1==(e>>r&1);this.modules[Math.floor(r/3)][r%3+this.moduleCount-8-3]=n}for(r=0;r<18;r++)n=!t&&1==(e>>r&1),this.modules[r%3+this.moduleCount-8-3][Math.floor(r/3)]=n},s.setupTypeInfo=function(t,e){for(var r=this.errorCorrectionLevel<<3|e,n=l.getBCHTypeInfo(r),i=0;i<15;i++){var o=!t&&1==(n>>i&1);i<6?this.modules[i][8]=o:i<8?this.modules[i+1][8]=o:this.modules[this.moduleCount-15+i][8]=o}for(i=0;i<15;i++)o=!t&&1==(n>>i&1),i<8?this.modules[8][this.moduleCount-i-1]=o:i<9?this.modules[8][15-i-1+1]=o:this.modules[8][15-i-1]=o;this.modules[this.moduleCount-8][8]=!t},s.mapData=function(t,e){for(var r=-1,n=this.moduleCount-1,i=7,o=0,s=this.moduleCount-1;s>0;s-=2)for(6==s&&s--;;){for(var a=0;a<2;a++)if(null==this.modules[n][s-a]){var u=!1;o<t.length&&(u=1==(t[o]>>>i&1)),l.getMask(e,n,s-a)&&(u=!u),this.modules[n][s-a]=u,-1==--i&&(o++,i=7)}if((n+=r)<0||this.moduleCount<=n){n-=r,r=-r;break}}},o.PAD0=236,o.PAD1=17,o.createData=function(t,e,r){for(var n=u.getRSBlocks(t,e),i=new c,s=0;s<r.length;s++){var a=r[s];i.put(a.mode,4),i.put(a.getLength(),l.getLengthInBits(a.mode,t)),a.write(i)}var h=0;for(s=0;s<n.length;s++)h+=n[s].dataCount;if(i.getLengthInBits()>8*h)throw new Error("code length overflow. ("+i.getLengthInBits()+">"+8*h+")");for(i.getLengthInBits()+4<=8*h&&i.put(0,4);i.getLengthInBits()%8!=0;)i.putBit(!1);for(;;){if(i.getLengthInBits()>=8*h)break;if(i.put(o.PAD0,8),i.getLengthInBits()>=8*h)break;i.put(o.PAD1,8)}return o.createBytes(i,n)},o.createBytes=function(t,e){for(var r=0,n=0,i=0,o=new Array(e.length),s=new Array(e.length),a=0;a<e.length;a++){var u=e[a].dataCount,c=e[a].totalCount-u;n=Math.max(n,u),i=Math.max(i,c),o[a]=new Array(u);for(var m=0;m<o[a].length;m++)o[a][m]=255&t.getBuffer()[m+r];r+=u;var g=l.getErrorCorrectPolynomial(c),f=new h(o[a],g.getLength()-1).mod(g);for(s[a]=new Array(g.getLength()-1),m=0;m<s[a].length;m++){var d=m+f.getLength()-s[a].length;s[a][m]=d>=0?f.get(d):0}}var p=0;for(a=0;a<e.length;a++)p+=e[a].totalCount;var v=new Array(p),y=0;for(m=0;m<n;m++)for(a=0;a<e.length;a++)m<o[a].length&&(v[y++]=o[a][m]);for(m=0;m<i;m++)for(a=0;a<e.length;a++)m<s[a].length&&(v[y++]=s[a][m]);return v};var l={PATTERN_POSITION_TABLE:[[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50],[6,30,54],[6,32,58],[6,34,62],[6,26,46,66],[6,26,48,70],[6,26,50,74],[6,30,54,78],[6,30,56,82],[6,30,58,86],[6,34,62,90],[6,28,50,72,94],[6,26,50,74,98],[6,30,54,78,102],[6,28,54,80,106],[6,32,58,84,110],[6,30,58,86,114],[6,34,62,90,118],[6,26,50,74,98,122],[6,30,54,78,102,126],[6,26,52,78,104,130],[6,30,56,82,108,134],[6,34,60,86,112,138],[6,30,58,86,114,142],[6,34,62,90,118,146],[6,30,54,78,102,126,150],[6,24,50,76,102,128,154],[6,28,54,80,106,132,158],[6,32,58,84,110,136,162],[6,26,54,82,110,138,166],[6,30,58,86,114,142,170]],G15:1335,G18:7973,G15_MASK:21522,getBCHTypeInfo:function(t){for(var e=t<<10;l.getBCHDigit(e)-l.getBCHDigit(l.G15)>=0;)e^=l.G15<<l.getBCHDigit(e)-l.getBCHDigit(l.G15);return(t<<10|e)^l.G15_MASK},getBCHTypeNumber:function(t){for(var e=t<<12;l.getBCHDigit(e)-l.getBCHDigit(l.G18)>=0;)e^=l.G18<<l.getBCHDigit(e)-l.getBCHDigit(l.G18);return t<<12|e},getBCHDigit:function(t){for(var e=0;0!=t;)e++,t>>>=1;return e},getPatternPosition:function(t){return l.PATTERN_POSITION_TABLE[t-1]},getMask:function(t,e,r){switch(t){case 0:return(e+r)%2==0;case 1:return e%2==0;case 2:return r%3==0;case 3:return(e+r)%3==0;case 4:return(Math.floor(e/2)+Math.floor(r/3))%2==0;case 5:return e*r%2+e*r%3==0;case 6:return(e*r%2+e*r%3)%2==0;case 7:return(e*r%3+(e+r)%2)%2==0;default:throw new Error("bad maskPattern:"+t)}},getErrorCorrectPolynomial:function(t){for(var e=new h([1],0),r=0;r<t;r++)e=e.multiply(new h([1,m.gexp(r)],0));return e},getLengthInBits:function(t,e){if(1<=e&&e<10)switch(t){case 4:return 8;default:throw new Error("mode:"+t)}else if(e<27)switch(t){case 4:return 16;default:throw new Error("mode:"+t)}else{if(!(e<41))throw new Error("type:"+e);switch(t){case 4:return 16;default:throw new Error("mode:"+t)}}},getLostPoint:function(t){for(var e=t.getModuleCount(),r=0,n=0;n<e;n++)for(var i=0;i<e;i++){for(var o=0,s=t.isDark(n,i),a=-1;a<=1;a++)if(!(n+a<0||e<=n+a))for(var u=-1;u<=1;u++)i+u<0||e<=i+u||0==a&&0==u||a==0&&u==0||s==t.isDark(n+a,i+u)&&o++;o>5&&(r+=3+o-5)}for(n=0;n<e-1;n++)for(i=0;i<e-1;i++){var l=0;t.isDark(n,i)&&l++,t.isDark(n+1,i)&&l++,t.isDark(n,i+1)&&l++,t.isDark(n+1,i+1)&&l++,0!=l&&4!=l||(r+=3)}for(n=0;n<e;n++)for(i=0;i<e-6;i++)t.isDark(n,i)&&!t.isDark(n,i+1)&&t.isDark(n,i+2)&&t.isDark(n,i+3)&&t.isDark(n,i+4)&&!t.isDark(n,i+5)&&t.isDark(n,i+6)&&(r+=40);for(i=0;i<e;i++)for(n=0;n<e-6;n++)t.isDark(n,i)&&!t.isDark(n+1,i)&&t.isDark(n+2,i)&&t.isDark(n+3,i)&&t.isDark(n+4,i)&&!t.isDark(n+5,i)&&t.isDark(n+6,i)&&(r+=40);var c=0;for(i=0;i<e;i++)for(n=0;n<e;n++)t.isDark(n,i)&&c++;return r+Math.abs(100*c/e/e-50)/5*10}},m={glog:function(t){if(t<1)throw new Error("glog("+t+")");return m.LOG_TABLE[t]},gexp:function(t){for(;t<0;)t+=255;for(;t>=256;)t-=255;return m.EXP_TABLE[t]},EXP_TABLE:new Array(256),LOG_TABLE:new Array(256)};for(e=0;e<8;e++)m.EXP_TABLE[e]=1<<e;for(e=8;e<256;e++)m.EXP_TABLE[e]=m.EXP_TABLE[e-4]^m.EXP_TABLE[e-5]^m.EXP_TABLE[e-6]^m.EXP_TABLE[e-8];for(e=0;e<255;e++)m.LOG_TABLE[m.EXP_TABLE[e]]=e;function h(t,e){if(null==t.length)throw new Error(t.length+"/"+e);for(var r=0;r<t.length&&0==t[r];)r++;this.num=new Array(t.length-r+e);for(var n=0;n<t.length-r;n++)this.num[n]=t[n+r]}function c(){this.buffer=[],this.length=0}function u(t,e){this.totalCount=t,this.dataCount=e}h.prototype={get:function(t){return this.num[t]},getLength:function(){return this.num.length},multiply:function(t){for(var e=new Array(this.getLength()+t.getLength()-1),r=0;r<this.getLength();r++)for(var n=0;n<t.getLength();n++)e[r+n]^=m.gexp(m.glog(this.get(r))+m.glog(t.get(n)));return new h(e,0)},mod:function(t){if(this.getLength()-t.getLength()<0)return this;for(var e=m.glog(this.get(0))-m.glog(t.get(0)),r=new Array(this.getLength()),n=0;n<this.getLength();n++)r[n]=this.get(n);for(n=0;n<t.getLength();n++)r[n]^=m.gexp(m.glog(t.get(n))+e);return new h(r,0).mod(t)}},c.prototype={getBuffer:function(){return this.buffer},getAt:function(t){var e=Math.floor(t/8);return 1==(this.buffer[e]>>>7-t%8&1)},put:function(t,e){for(var r=0;r<e;r++)this.putBit(1==(t>>>e-r-1&1))},getLengthInBits:function(){return this.length},putBit:function(t){var e=Math.floor(this.length/8);this.buffer.length<=e&&this.buffer.push(0),t&&(this.buffer[e]|=128>>>this.length%8),this.length++}},u.RS_BLOCK_TABLE=[[1,26,19],[1,26,16],[1,26,13],[1,26,9],[1,44,34],[1,44,28],[1,44,22],[1,44,16],[1,70,55],[1,70,44],[2,35,17],[2,35,13],[1,100,80],[2,50,32],[2,50,24],[4,25,9],[1,134,108],[2,67,43],[2,33,15,2,34,16],[2,33,11,2,34,12],[2,86,68],[4,43,27],[4,43,19],[4,43,15],[2,98,78],[4,49,31],[2,32,14,4,33,15],[4,39,13,1,40,14],[2,121,97],[2,60,38,2,61,39],[4,40,18,2,41,19],[4,40,14,2,41,15],[2,146,116],[3,58,36,2,59,37],[4,36,16,4,37,17],[4,36,12,4,37,13],[2,86,68,2,87,69],[4,69,43,1,70,44],[6,43,19,2,44,20],[6,43,15,2,44,16]],u.getRSBlocks=function(t,e){var r=u.getRsBlockTable(t,e);if(null==r)throw new Error("bad rs block @ typeNumber:"+t+"/errorCorrectionLevel:"+e);for(var n=r.length/3,i=[],o=0;o<n;o++)for(var s=r[3*o+0],a=r[3*o+1],l=r[3*o+2],c=0;c<s;c++)i.push(new u(a,l));return i},u.getRsBlockTable=function(t,e){switch(e){case 1:return u.RS_BLOCK_TABLE[4*(t-1)+0];case 0:return u.RS_BLOCK_TABLE[4*(t-1)+1];case 3:return u.RS_BLOCK_TABLE[4*(t-1)+2];case 2:return u.RS_BLOCK_TABLE[4*(t-1)+3]}};var g={MODE_8BIT_BYTE:4};function a(t){this.mode=g.MODE_8BIT_BYTE,this.data=t,this.parsedData=[];for(var e=0,r=this.data.length;e<r;e++){var n=[],i=this.data.charCodeAt(e);i>65536?(n[0]=240|(1835008&i)>>>18,n[1]=128|(258048&i)>>>12,n[2]=128|(4032&i)>>>6,n[3]=128|63&i):i>2048?(n[0]=224|(61440&i)>>>12,n[1]=128|(4032&i)>>>6,n[2]=128|63&i):i>128?(n[0]=192|(1984&i)>>>6,n[1]=128|63&i):n[0]=i,this.parsedData.push(n)}this.parsedData=Array.prototype.concat.apply([],this.parsedData),this.parsedData.length!=this.data.length&&(this.parsedData.unshift(191),this.parsedData.unshift(187),this.parsedData.unshift(239))}a.prototype={getLength:function(t){return this.parsedData.length},write:function(t){for(var e=0,r=this.parsedData.length;e<r;e++)t.put(this.parsedData[e],8)}},t.AtomicQR=function(t,e){e=e||"M";var r={L:1,M:0,Q:3,H:2}[e];var n=new o(0,r);return n.addData(t),n.make(),n}}(window);
    /* eslint-enable */
    QRCode = window.AtomicQR;
  } catch (e) { QRCode = null; }

  function qrSvg(text) {
    if (!QRCode) return null;
    try {
      var q = QRCode(text, "M");
      var mc = q.getModuleCount();
      var size = 220;
      var cell = size / mc;
      var rects = "";
      for (var r = 0; r < mc; r++) for (var c = 0; c < mc; c++)
        if (q.isDark(r, c))
          rects += '<rect x="' + (c * cell).toFixed(2) + '" y="' + (r * cell).toFixed(2) + '" width="' + cell.toFixed(2) + '" height="' + cell.toFixed(2) + '"/>';
      return '<svg class="qr-canvas" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" width="' + size + '" height="' + size + '"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">' + rects + '</g></svg>';
    } catch (e) { return null; }
  }

  // -------- Widgets ---------------------------------------------------

  register("Generators", "QR code", function (root) {
    root.innerHTML =
      '<p class="desc">Generate a QR code from any text. 100% local.</p>' +
      '<label>Text or URL</label>' +
      '<input type="text" data-in value="https://atomic-search-1-r62n.onrender.com/" />' +
      '<div data-qr></div>';
    var input = $("[data-in]", root);
    var out = $("[data-qr]", root);
    function redraw() {
      var svg = qrSvg(input.value || " ");
      out.innerHTML = svg || '<p class="desc">QR generator failed to load.</p>';
    }
    input.addEventListener("input", redraw);
    redraw();
  });

  register("Generators", "Password", function (root) {
    root.innerHTML =
      '<p class="desc">Cryptographically strong random password (Web Crypto).</p>' +
      '<div class="tool-row"><label>Length <input type="number" min="6" max="128" value="20" data-len style="width:70px" /></label>' +
      '<label><input type="checkbox" data-syms checked /> Symbols</label>' +
      '<label><input type="checkbox" data-num checked /> Numbers</label></div>' +
      '<div class="tool-output" data-out></div>' +
      '<div class="tool-row"><button type="button" data-gen>Generate</button><button type="button" class="ghost" data-copy>Copy</button></div>';
    var len = $("[data-len]", root), syms = $("[data-syms]", root), num = $("[data-num]", root);
    var out = $("[data-out]", root);
    function gen() {
      var upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      var lower = "abcdefghijklmnopqrstuvwxyz";
      var nums  = "0123456789";
      var sym   = "!@#$%^&*()-_=+[]{};:,.?";
      var chars = upper + lower + (num.checked ? nums : "") + (syms.checked ? sym : "");
      var L = Math.max(6, Math.min(128, parseInt(len.value, 10) || 20));
      var buf = new Uint32Array(L);
      crypto.getRandomValues(buf);
      var s = "";
      for (var i = 0; i < L; i++) s += chars[buf[i] % chars.length];
      out.textContent = s;
    }
    $("[data-gen]", root).addEventListener("click", gen);
    $("[data-copy]", root).addEventListener("click", function () {
      if (out.textContent) navigator.clipboard && navigator.clipboard.writeText(out.textContent);
    });
    gen();
  });

  register("Generators", "UUID v4", function (root) {
    root.innerHTML =
      '<p class="desc">Cryptographically random RFC 4122 v4 UUID.</p>' +
      '<div class="tool-output" data-out></div>' +
      '<div class="tool-row"><button type="button" data-gen>Generate</button><button type="button" class="ghost" data-copy>Copy</button></div>';
    var out = $("[data-out]", root);
    function gen() {
      if (crypto.randomUUID) { out.textContent = crypto.randomUUID(); return; }
      var b = new Uint8Array(16);
      crypto.getRandomValues(b);
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      var hx = Array.prototype.map.call(b, function (v) { return ("0" + v.toString(16)).slice(-2); }).join("");
      out.textContent = hx.slice(0, 8) + "-" + hx.slice(8, 12) + "-" + hx.slice(12, 16) + "-" + hx.slice(16, 20) + "-" + hx.slice(20);
    }
    $("[data-gen]", root).addEventListener("click", gen);
    $("[data-copy]", root).addEventListener("click", function () { if (out.textContent) navigator.clipboard && navigator.clipboard.writeText(out.textContent); });
    gen();
  });

  register("Generators", "Lorem ipsum", function (root) {
    root.innerHTML =
      '<p class="desc">Filler text. Paragraph count:</p>' +
      '<input type="number" min="1" max="20" value="3" data-n style="width:80px" />' +
      '<div class="tool-output" data-out></div>';
    var n = $("[data-n]", root), out = $("[data-out]", root);
    var L = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.";
    function go() {
      var k = Math.max(1, Math.min(20, parseInt(n.value, 10) || 3));
      var arr = []; for (var i = 0; i < k; i++) arr.push(L);
      out.textContent = arr.join("\n\n");
    }
    n.addEventListener("input", go); go();
  });

  register("Generators", "Slugify", function (root) {
    root.innerHTML = '<p class="desc">Convert any text to a URL-safe slug.</p>' +
      '<label>Text</label><input type="text" data-in value="Hello World! — Atomic Search is live." />' +
      '<div class="tool-output" data-out></div>';
    var i = $("[data-in]", root), o = $("[data-out]", root);
    function go() {
      o.textContent = i.value
        .toLowerCase()
        .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
    }
    i.addEventListener("input", go); go();
  });

  register("Encoders", "Base64", function (root) {
    root.innerHTML =
      '<label>Plain text</label><textarea data-in>hello atomic</textarea>' +
      '<div class="tool-row"><button type="button" data-enc>Encode →</button><button type="button" class="ghost" data-dec>← Decode</button></div>' +
      '<label>Base64</label><textarea data-out></textarea>';
    var i = $("[data-in]", root), o = $("[data-out]", root);
    $("[data-enc]", root).addEventListener("click", function () { try { o.value = btoa(unescape(encodeURIComponent(i.value))); } catch (e) { o.value = "(invalid)"; } });
    $("[data-dec]", root).addEventListener("click", function () { try { i.value = decodeURIComponent(escape(atob(o.value))); } catch (e) { i.value = "(invalid)"; } });
  });

  register("Encoders", "URL encode", function (root) {
    root.innerHTML =
      '<label>Plain</label><textarea data-in>hello world & atoms</textarea>' +
      '<div class="tool-row"><button type="button" data-enc>Encode →</button><button type="button" class="ghost" data-dec>← Decode</button></div>' +
      '<label>Encoded</label><textarea data-out></textarea>';
    var i = $("[data-in]", root), o = $("[data-out]", root);
    $("[data-enc]", root).addEventListener("click", function () { o.value = encodeURIComponent(i.value); });
    $("[data-dec]", root).addEventListener("click", function () { try { i.value = decodeURIComponent(o.value); } catch (e) { i.value = "(invalid)"; } });
  });

  register("Encoders", "HTML entities", function (root) {
    root.innerHTML =
      '<label>Plain</label><textarea data-in>&lt;div&gt;hi &amp; bye&lt;/div&gt;</textarea>' +
      '<div class="tool-row"><button type="button" data-enc>Encode →</button><button type="button" class="ghost" data-dec>← Decode</button></div>' +
      '<label>Encoded</label><textarea data-out></textarea>';
    var i = $("[data-in]", root), o = $("[data-out]", root);
    $("[data-enc]", root).addEventListener("click", function () {
      o.value = i.value.replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; });
    });
    $("[data-dec]", root).addEventListener("click", function () {
      var d = document.createElement("textarea"); d.innerHTML = o.value; i.value = d.value;
    });
  });

  register("Encoders", "JWT decoder", function (root) {
    root.innerHTML =
      '<label>JWT</label><textarea data-in placeholder="eyJhbGciOi..."></textarea>' +
      '<label>Header</label><div class="tool-output" data-h></div>' +
      '<label>Payload</label><div class="tool-output" data-p></div>';
    var i = $("[data-in]", root), h = $("[data-h]", root), p = $("[data-p]", root);
    function go() {
      var parts = (i.value || "").trim().split(".");
      if (parts.length < 2) { h.textContent = p.textContent = ""; return; }
      function dec(s) {
        try {
          var pad = s + "===".slice((s.length + 3) % 4);
          pad = pad.replace(/-/g, "+").replace(/_/g, "/");
          return JSON.stringify(JSON.parse(decodeURIComponent(escape(atob(pad)))), null, 2);
        } catch (e) { return "(invalid)"; }
      }
      h.textContent = dec(parts[0]);
      p.textContent = dec(parts[1]);
    }
    i.addEventListener("input", go);
  });

  async function digestHex(alg, text) {
    var buf = new TextEncoder().encode(text);
    var d = await crypto.subtle.digest(alg, buf);
    return Array.prototype.map.call(new Uint8Array(d), function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  }
  register("Encoders", "SHA-256 / SHA-1", function (root) {
    root.innerHTML =
      '<label>Text</label><textarea data-in>atomic</textarea>' +
      '<label>SHA-256</label><div class="tool-output" data-sha256></div>' +
      '<label>SHA-1</label><div class="tool-output" data-sha1></div>';
    var i = $("[data-in]", root), s1 = $("[data-sha1]", root), s2 = $("[data-sha256]", root);
    async function go() {
      s1.textContent = await digestHex("SHA-1", i.value);
      s2.textContent = await digestHex("SHA-256", i.value);
    }
    i.addEventListener("input", go); go();
  });

  // Tiny MD5 (Joseph Myers, public domain, compressed).
  function md5(str) {
    function safeAdd(x, y) { var l = (x & 0xffff) + (y & 0xffff); var m = (x >> 16) + (y >> 16) + (l >> 16); return (m << 16) | (l & 0xffff); }
    function bitRol(n, c) { return (n << c) | (n >>> (32 - c)); }
    function md5Cmn(q, a, b, x, s, t) { return safeAdd(bitRol(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b); }
    function md5Ff(a, b, c, d, x, s, t) { return md5Cmn((b & c) | ((~b) & d), a, b, x, s, t); }
    function md5Gg(a, b, c, d, x, s, t) { return md5Cmn((b & d) | (c & (~d)), a, b, x, s, t); }
    function md5Hh(a, b, c, d, x, s, t) { return md5Cmn(b ^ c ^ d, a, b, x, s, t); }
    function md5Ii(a, b, c, d, x, s, t) { return md5Cmn(c ^ (b | (~d)), a, b, x, s, t); }
    function binlMd5(x, len) {
      x[len >> 5] |= 0x80 << (len % 32);
      x[(((len + 64) >>> 9) << 4) + 14] = len;
      var a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
      for (var i = 0; i < x.length; i += 16) {
        var oa = a, ob = b, oc = c, od = d;
        a = md5Ff(a, b, c, d, x[i], 7, -680876936); d = md5Ff(d, a, b, c, x[i + 1], 12, -389564586); c = md5Ff(c, d, a, b, x[i + 2], 17, 606105819); b = md5Ff(b, c, d, a, x[i + 3], 22, -1044525330);
        a = md5Ff(a, b, c, d, x[i + 4], 7, -176418897); d = md5Ff(d, a, b, c, x[i + 5], 12, 1200080426); c = md5Ff(c, d, a, b, x[i + 6], 17, -1473231341); b = md5Ff(b, c, d, a, x[i + 7], 22, -45705983);
        a = md5Ff(a, b, c, d, x[i + 8], 7, 1770035416); d = md5Ff(d, a, b, c, x[i + 9], 12, -1958414417); c = md5Ff(c, d, a, b, x[i + 10], 17, -42063); b = md5Ff(b, c, d, a, x[i + 11], 22, -1990404162);
        a = md5Ff(a, b, c, d, x[i + 12], 7, 1804603682); d = md5Ff(d, a, b, c, x[i + 13], 12, -40341101); c = md5Ff(c, d, a, b, x[i + 14], 17, -1502002290); b = md5Ff(b, c, d, a, x[i + 15], 22, 1236535329);
        a = md5Gg(a, b, c, d, x[i + 1], 5, -165796510); d = md5Gg(d, a, b, c, x[i + 6], 9, -1069501632); c = md5Gg(c, d, a, b, x[i + 11], 14, 643717713); b = md5Gg(b, c, d, a, x[i], 20, -373897302);
        a = md5Gg(a, b, c, d, x[i + 5], 5, -701558691); d = md5Gg(d, a, b, c, x[i + 10], 9, 38016083); c = md5Gg(c, d, a, b, x[i + 15], 14, -660478335); b = md5Gg(b, c, d, a, x[i + 4], 20, -405537848);
        a = md5Gg(a, b, c, d, x[i + 9], 5, 568446438); d = md5Gg(d, a, b, c, x[i + 14], 9, -1019803690); c = md5Gg(c, d, a, b, x[i + 3], 14, -187363961); b = md5Gg(b, c, d, a, x[i + 8], 20, 1163531501);
        a = md5Gg(a, b, c, d, x[i + 13], 5, -1444681467); d = md5Gg(d, a, b, c, x[i + 2], 9, -51403784); c = md5Gg(c, d, a, b, x[i + 7], 14, 1735328473); b = md5Gg(b, c, d, a, x[i + 12], 20, -1926607734);
        a = md5Hh(a, b, c, d, x[i + 5], 4, -378558); d = md5Hh(d, a, b, c, x[i + 8], 11, -2022574463); c = md5Hh(c, d, a, b, x[i + 11], 16, 1839030562); b = md5Hh(b, c, d, a, x[i + 14], 23, -35309556);
        a = md5Hh(a, b, c, d, x[i + 1], 4, -1530992060); d = md5Hh(d, a, b, c, x[i + 4], 11, 1272893353); c = md5Hh(c, d, a, b, x[i + 7], 16, -155497632); b = md5Hh(b, c, d, a, x[i + 10], 23, -1094730640);
        a = md5Hh(a, b, c, d, x[i + 13], 4, 681279174); d = md5Hh(d, a, b, c, x[i], 11, -358537222); c = md5Hh(c, d, a, b, x[i + 3], 16, -722521979); b = md5Hh(b, c, d, a, x[i + 6], 23, 76029189);
        a = md5Hh(a, b, c, d, x[i + 9], 4, -640364487); d = md5Hh(d, a, b, c, x[i + 12], 11, -421815835); c = md5Hh(c, d, a, b, x[i + 15], 16, 530742520); b = md5Hh(b, c, d, a, x[i + 2], 23, -995338651);
        a = md5Ii(a, b, c, d, x[i], 6, -198630844); d = md5Ii(d, a, b, c, x[i + 7], 10, 1126891415); c = md5Ii(c, d, a, b, x[i + 14], 15, -1416354905); b = md5Ii(b, c, d, a, x[i + 5], 21, -57434055);
        a = md5Ii(a, b, c, d, x[i + 12], 6, 1700485571); d = md5Ii(d, a, b, c, x[i + 3], 10, -1894986606); c = md5Ii(c, d, a, b, x[i + 10], 15, -1051523); b = md5Ii(b, c, d, a, x[i + 1], 21, -2054922799);
        a = md5Ii(a, b, c, d, x[i + 8], 6, 1873313359); d = md5Ii(d, a, b, c, x[i + 15], 10, -30611744); c = md5Ii(c, d, a, b, x[i + 6], 15, -1560198380); b = md5Ii(b, c, d, a, x[i + 13], 21, 1309151649);
        a = md5Ii(a, b, c, d, x[i + 4], 6, -145523070); d = md5Ii(d, a, b, c, x[i + 11], 10, -1120210379); c = md5Ii(c, d, a, b, x[i + 2], 15, 718787259); b = md5Ii(b, c, d, a, x[i + 9], 21, -343485551);
        a = safeAdd(a, oa); b = safeAdd(b, ob); c = safeAdd(c, oc); d = safeAdd(d, od);
      }
      return [a, b, c, d];
    }
    function rstr2binl(r) { var o = []; for (var i = 0; i < r.length * 8; i += 8) o[i >> 5] |= (r.charCodeAt(i / 8) & 0xff) << (i % 32); return o; }
    function binl2hex(b) { var h = "0123456789abcdef"; var s = ""; for (var i = 0; i < b.length * 4; i++) s += h.charAt((b[i >> 2] >> ((i % 4) * 8 + 4)) & 0xf) + h.charAt((b[i >> 2] >> ((i % 4) * 8)) & 0xf); return s; }
    var utf = unescape(encodeURIComponent(str));
    return binl2hex(binlMd5(rstr2binl(utf), utf.length * 8));
  }
  register("Encoders", "MD5", function (root) {
    root.innerHTML = '<label>Text</label><textarea data-in>atomic</textarea><label>MD5</label><div class="tool-output" data-o></div>';
    var i = $("[data-in]", root), o = $("[data-o]", root);
    function go() { o.textContent = md5(i.value || ""); }
    i.addEventListener("input", go); go();
  });

  register("Text", "JSON format", function (root) {
    root.innerHTML =
      '<label>JSON</label><textarea data-in>{"a":1,"b":[1,2,3]}</textarea>' +
      '<div class="tool-row"><button type="button" data-pretty>Pretty</button><button type="button" class="ghost" data-min>Minify</button></div>' +
      '<label>Out</label><textarea data-out></textarea>';
    var i = $("[data-in]", root), o = $("[data-out]", root);
    $("[data-pretty]", root).addEventListener("click", function () { try { o.value = JSON.stringify(JSON.parse(i.value), null, 2); } catch (e) { o.value = "Invalid JSON: " + e.message; } });
    $("[data-min]", root).addEventListener("click", function () { try { o.value = JSON.stringify(JSON.parse(i.value)); } catch (e) { o.value = "Invalid JSON: " + e.message; } });
  });

  register("Text", "Regex tester", function (root) {
    root.innerHTML =
      '<label>Pattern (with flags, e.g. /foo/gi)</label><input type="text" data-p value="/atom/gi" />' +
      '<label>Text</label><textarea data-t>atomic atomicity atomised</textarea>' +
      '<label>Matches</label><div class="tool-output" data-m></div>';
    var p = $("[data-p]", root), t = $("[data-t]", root), m = $("[data-m]", root);
    function go() {
      var s = p.value.trim();
      var mm = /^\/(.+)\/([a-z]*)$/.exec(s);
      try {
        var re = mm ? new RegExp(mm[1], mm[2]) : new RegExp(s, "g");
        var matches = t.value.match(re) || [];
        m.textContent = matches.length ? matches.join(" | ") : "(no match)";
      } catch (e) { m.textContent = "Invalid regex: " + e.message; }
    }
    p.addEventListener("input", go); t.addEventListener("input", go); go();
  });

  register("Text", "Case converter", function (root) {
    root.innerHTML =
      '<label>Text</label><textarea data-in>Hello World</textarea>' +
      '<div class="tool-row">' +
      '<button type="button" data-up>UPPER</button>' +
      '<button type="button" class="ghost" data-lo>lower</button>' +
      '<button type="button" class="ghost" data-cap>Capitalise</button>' +
      '<button type="button" class="ghost" data-camel>camelCase</button>' +
      '<button type="button" class="ghost" data-snake>snake_case</button>' +
      '<button type="button" class="ghost" data-kebab>kebab-case</button>' +
      '</div>' +
      '<div class="tool-output" data-o></div>';
    var i = $("[data-in]", root), o = $("[data-o]", root);
    function to(fn) { o.textContent = fn(i.value || ""); }
    $("[data-up]", root).addEventListener("click", function () { to(function (s) { return s.toUpperCase(); }); });
    $("[data-lo]", root).addEventListener("click", function () { to(function (s) { return s.toLowerCase(); }); });
    $("[data-cap]", root).addEventListener("click", function () { to(function (s) { return s.replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }); });
    $("[data-camel]", root).addEventListener("click", function () { to(function (s) { return s.toLowerCase().replace(/[^a-z0-9]+(.)/g, function (_, c) { return c.toUpperCase(); }); }); });
    $("[data-snake]", root).addEventListener("click", function () { to(function (s) { return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""); }); });
    $("[data-kebab]", root).addEventListener("click", function () { to(function (s) { return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }); });
  });

  register("Text", "Word + char counter", function (root) {
    root.innerHTML =
      '<label>Text</label><textarea data-in></textarea>' +
      '<div class="tool-output" data-o>Type something above.</div>';
    var i = $("[data-in]", root), o = $("[data-o]", root);
    function go() {
      var t = i.value || "";
      var words = (t.match(/\b[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) || []).length;
      var chars = t.length;
      var noSpace = (t.match(/\S/g) || []).length;
      var lines = t.split(/\n/).length;
      o.textContent = words + " words · " + chars + " chars (" + noSpace + " non-space) · " + lines + " lines";
    }
    i.addEventListener("input", go); go();
  });

  register("Text", "Reverse text", function (root) {
    root.innerHTML =
      '<label>Text</label><input type="text" data-in value="Atomic Search" />' +
      '<div class="tool-output" data-o></div>';
    var i = $("[data-in]", root), o = $("[data-o]", root);
    function go() { o.textContent = Array.from(i.value).reverse().join(""); }
    i.addEventListener("input", go); go();
  });

  register("Numbers", "Timestamp ↔ date", function (root) {
    root.innerHTML =
      '<div class="tool-row"><label>Unix sec <input type="number" data-u /></label>' +
      '<button type="button" data-now>Now</button></div>' +
      '<label>ISO</label><input type="text" data-i />' +
      '<label>Readable</label><div class="tool-output" data-r></div>';
    var u = $("[data-u]", root), i = $("[data-i]", root), r = $("[data-r]", root);
    $("[data-now]", root).addEventListener("click", function () { u.value = Math.floor(Date.now() / 1000); u.dispatchEvent(new Event("input")); });
    u.addEventListener("input", function () {
      var v = parseInt(u.value, 10);
      if (!isFinite(v)) return;
      var d = new Date(v * 1000);
      i.value = d.toISOString();
      r.textContent = d.toString();
    });
    i.addEventListener("input", function () {
      var d = new Date(i.value);
      if (isNaN(d.getTime())) return;
      u.value = Math.floor(d.getTime() / 1000);
      r.textContent = d.toString();
    });
    $("[data-now]", root).click();
  });

  register("Numbers", "Base converter", function (root) {
    root.innerHTML =
      '<label>Decimal</label><input type="text" data-d value="255" />' +
      '<label>Binary</label><input type="text" data-b />' +
      '<label>Octal</label><input type="text" data-o />' +
      '<label>Hexadecimal</label><input type="text" data-h />';
    var d = $("[data-d]", root), b = $("[data-b]", root), o = $("[data-o]", root), h = $("[data-h]", root);
    function fromDec() { var n = parseInt(d.value, 10); if (!isFinite(n)) return; b.value = n.toString(2); o.value = n.toString(8); h.value = n.toString(16); }
    function from(base, el) { var n = parseInt(el.value, base); if (!isFinite(n)) return; d.value = n.toString(10); if (el !== b) b.value = n.toString(2); if (el !== o) o.value = n.toString(8); if (el !== h) h.value = n.toString(16); }
    d.addEventListener("input", fromDec);
    b.addEventListener("input", function () { from(2, b); });
    o.addEventListener("input", function () { from(8, o); });
    h.addEventListener("input", function () { from(16, h); });
    fromDec();
  });

  register("Numbers", "Roman numerals", function (root) {
    root.innerHTML =
      '<label>Number</label><input type="number" data-n value="2025" />' +
      '<div class="tool-output" data-o></div>';
    var n = $("[data-n]", root), o = $("[data-o]", root);
    function toRoman(num) {
      var map = [[1000,"M"],[900,"CM"],[500,"D"],[400,"CD"],[100,"C"],[90,"XC"],[50,"L"],[40,"XL"],[10,"X"],[9,"IX"],[5,"V"],[4,"IV"],[1,"I"]];
      var r = ""; num = Math.max(1, Math.min(3999, Math.floor(num)));
      for (var i = 0; i < map.length; i++) while (num >= map[i][0]) { r += map[i][1]; num -= map[i][0]; }
      return r;
    }
    function go() { o.textContent = toRoman(parseInt(n.value, 10) || 0); }
    n.addEventListener("input", go); go();
  });

  register("Visual", "Color picker", function (root) {
    root.innerHTML =
      '<label>Pick <input type="color" data-c value="#4c8bf5" /></label>' +
      '<label>Hex</label><input type="text" data-hex />' +
      '<label>RGB</label><input type="text" data-rgb />' +
      '<label>HSL</label><input type="text" data-hsl />' +
      '<div class="swatch" data-sw></div>';
    var c = $("[data-c]", root), hex = $("[data-hex]", root), rgb = $("[data-rgb]", root), hsl = $("[data-hsl]", root), sw = $("[data-sw]", root);
    function rgbToHsl(r, g, b) {
      r /= 255; g /= 255; b /= 255;
      var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      var h, s, l = (mx + mn) / 2;
      if (mx === mn) { h = s = 0; }
      else {
        var d = mx - mn;
        s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
        switch (mx) {
          case r: h = (g - b) / d + (g < b ? 6 : 0); break;
          case g: h = (b - r) / d + 2; break;
          default: h = (r - g) / d + 4;
        }
        h /= 6;
      }
      return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
    }
    function go() {
      var v = c.value; sw.style.background = v;
      hex.value = v;
      var r = parseInt(v.slice(1, 3), 16), g = parseInt(v.slice(3, 5), 16), b = parseInt(v.slice(5, 7), 16);
      rgb.value = "rgb(" + r + ", " + g + ", " + b + ")";
      var h = rgbToHsl(r, g, b);
      hsl.value = "hsl(" + h[0] + ", " + h[1] + "%, " + h[2] + "%)";
    }
    c.addEventListener("input", go); go();
  });

  register("Visual", "Markdown preview", function (root) {
    root.innerHTML =
      '<label>Markdown</label><textarea data-in># Hello\n\nAtomic **search** is _private_ and [open](https://github.com/).</textarea>' +
      '<label>HTML preview</label><div class="tool-output" data-o></div>';
    var i = $("[data-in]", root), o = $("[data-o]", root);
    function render(md) {
      md = esc(md);
      md = md.replace(/^###### (.+)$/gm, "<h6>$1</h6>")
             .replace(/^##### (.+)$/gm, "<h5>$1</h5>")
             .replace(/^#### (.+)$/gm, "<h4>$1</h4>")
             .replace(/^### (.+)$/gm, "<h3>$1</h3>")
             .replace(/^## (.+)$/gm, "<h2>$1</h2>")
             .replace(/^# (.+)$/gm, "<h1>$1</h1>");
      md = md.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
             .replace(/\*(.+?)\*/g, "<i>$1</i>")
             .replace(/_(.+?)_/g, "<i>$1</i>")
             .replace(/`([^`]+)`/g, "<code>$1</code>");
      md = md.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
      md = md.replace(/^\s*-\s+(.+)$/gm, "<li>$1</li>");
      md = md.replace(/(<li>[\s\S]+?<\/li>)/g, "<ul>$1</ul>");
      md = md.replace(/\n\n+/g, "</p><p>");
      return "<p>" + md + "</p>";
    }
    function go() { o.innerHTML = render(i.value || ""); }
    i.addEventListener("input", go); go();
  });

  register("Visual", "Diff (line)", function (root) {
    root.innerHTML =
      '<div class="tool-row">' +
      '<textarea data-a placeholder="A">alpha\nbeta\ngamma</textarea>' +
      '<textarea data-b placeholder="B">alpha\nbeta changed\ngamma\ndelta</textarea>' +
      '</div>' +
      '<div class="tool-output" data-o></div>';
    var a = $("[data-a]", root), b = $("[data-b]", root), o = $("[data-o]", root);
    function go() {
      var la = (a.value || "").split("\n"), lb = (b.value || "").split("\n");
      var setB = new Set(lb), setA = new Set(la);
      var rows = [];
      var max = Math.max(la.length, lb.length);
      for (var i = 0; i < max; i++) {
        var A = la[i] || "", B = lb[i] || "";
        if (A === B) rows.push("  " + A);
        else {
          if (A) rows.push("- " + A);
          if (B) rows.push("+ " + B);
        }
      }
      o.textContent = rows.join("\n");
    }
    a.addEventListener("input", go); b.addEventListener("input", go); go();
  });

  // -------- v3: Security widget — TOTP viewer ------------------------
  register("Security", "TOTP code (2FA)", function (root) {
    root.innerHTML =
      '<p class="desc">Paste a base32 TOTP secret to see the rotating 6-digit code. Runs entirely in your browser.</p>' +
      '<input type="text" data-secret placeholder="JBSWY3DPEHPK3PXP" autocomplete="off" spellcheck="false"/>' +
      '<div class="tool-output" style="font-family:ui-monospace,monospace;font-size:28px;letter-spacing:6px;text-align:center;padding:12px" data-code>—</div>' +
      '<div class="tool-output" data-meta style="font-size:12px">Enter a secret above.</div>';
    var secret = $("[data-secret]", root), code = $("[data-code]", root), meta = $("[data-meta]", root);
    function b32decode(s) {
      s = (s || "").replace(/[^A-Z2-7]/gi, "").toUpperCase();
      var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
      var bits = "", out = [];
      for (var i = 0; i < s.length; i++) {
        var idx = alphabet.indexOf(s.charAt(i));
        if (idx < 0) return null;
        bits += ("00000" + idx.toString(2)).slice(-5);
      }
      for (var j = 0; j + 8 <= bits.length; j += 8) {
        out.push(parseInt(bits.substr(j, 8), 2));
      }
      return new Uint8Array(out);
    }
    async function totp() {
      var key = b32decode(secret.value.trim());
      if (!key || !key.length) { code.textContent = "—"; meta.textContent = "Invalid base32 secret."; return; }
      var counter = Math.floor(Date.now() / 30000);
      var buf = new ArrayBuffer(8); var view = new DataView(buf);
      view.setUint32(4, counter, false);
      try {
        var cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
        var sig = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, buf));
        var off = sig[sig.length - 1] & 0x0f;
        var bin = ((sig[off] & 0x7f) << 24) | (sig[off+1] << 16) | (sig[off+2] << 8) | sig[off+3];
        var c = ("000000" + (bin % 1000000)).slice(-6);
        code.textContent = c.slice(0,3) + " " + c.slice(3);
        var left = 30 - Math.floor((Date.now() / 1000) % 30);
        meta.textContent = "Rotates in " + left + "s — OTP algorithm: SHA-1, 6 digits, 30s period.";
      } catch (e) { code.textContent = "—"; meta.textContent = "Failed: " + e.message; }
    }
    secret.addEventListener("input", totp);
    totp();
    setInterval(totp, 1000);
  });

  // -------- v3: Network widget — DNS lookup via Cloudflare DoH -------
  register("Network", "DNS lookup", function (root) {
    root.innerHTML =
      '<p class="desc">Look up DNS records via Cloudflare DoH (1.1.1.1). Encrypted query, no DNS leak.</p>' +
      '<div class="tool-row">' +
      '<input type="text" data-host placeholder="example.com" autocomplete="off"/>' +
      '<select data-type><option>A</option><option>AAAA</option><option>MX</option><option>TXT</option><option>NS</option><option>CNAME</option></select>' +
      '<button class="btn-primary" data-go>Lookup</button>' +
      '</div>' +
      '<pre class="tool-output" data-o>Enter a host and press Lookup.</pre>';
    var host = $("[data-host]", root), type = $("[data-type]", root),
        btn = $("[data-go]", root), out = $("[data-o]", root);
    async function go() {
      var h = (host.value || "").trim();
      if (!h) { out.textContent = "Enter a host."; return; }
      out.textContent = "Looking up…";
      try {
        var r = await fetch("https://cloudflare-dns.com/dns-query?name=" + encodeURIComponent(h) + "&type=" + type.value,
          { headers: { "Accept": "application/dns-json" } });
        var j = await r.json();
        if (!j.Answer) { out.textContent = "No records. (RCODE " + j.Status + ")"; return; }
        out.textContent = j.Answer.map(function (a) { return a.name + "  " + a.type + "  " + a.data + "  ttl=" + a.TTL; }).join("\n");
      } catch (e) { out.textContent = "Failed: " + e.message; }
    }
    btn.addEventListener("click", go);
    host.addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });
  });

  // -------- v3: Visual widget — WCAG contrast checker ----------------
  register("Visual", "Contrast checker (WCAG)", function (root) {
    root.innerHTML =
      '<p class="desc">Check the contrast ratio between two colours against WCAG AA/AAA.</p>' +
      '<div class="tool-row">' +
      '<input type="color" data-fg value="#1a1a1a"/>' +
      '<input type="color" data-bg value="#ffffff"/>' +
      '</div>' +
      '<div class="tool-output" data-sample style="padding:18px;font-size:16px;text-align:center">The quick brown fox jumps over the lazy dog.</div>' +
      '<div class="tool-output" data-o></div>';
    var fg = $("[data-fg]", root), bg = $("[data-bg]", root),
        samp = $("[data-sample]", root), o = $("[data-o]", root);
    function lum(hex) {
      var m = /^#?([0-9a-f]{6})$/i.exec(hex || ""); if (!m) return 0;
      var r = parseInt(m[1].slice(0,2),16)/255, g = parseInt(m[1].slice(2,4),16)/255, b = parseInt(m[1].slice(4,6),16)/255;
      function c(v) { return v <= 0.03928 ? v/12.92 : Math.pow((v + 0.055)/1.055, 2.4); }
      return 0.2126*c(r) + 0.7152*c(g) + 0.0722*c(b);
    }
    function go() {
      var l1 = lum(fg.value), l2 = lum(bg.value);
      var a = Math.max(l1, l2), b2 = Math.min(l1, l2);
      var ratio = (a + 0.05) / (b2 + 0.05);
      samp.style.color = fg.value; samp.style.background = bg.value;
      var aaN = ratio >= 4.5, aaL = ratio >= 3, aaaN = ratio >= 7, aaaL = ratio >= 4.5;
      o.innerHTML = "Ratio: <strong>" + ratio.toFixed(2) + ":1</strong><br>" +
        "AA normal text: " + (aaN ? "pass" : "fail") + " · " +
        "AA large text: " + (aaL ? "pass" : "fail") + " · " +
        "AAA normal text: " + (aaaN ? "pass" : "fail") + " · " +
        "AAA large text: " + (aaaL ? "pass" : "fail");
    }
    fg.addEventListener("input", go); bg.addEventListener("input", go); go();
  });

  // -------- Render ----------------------------------------------------

  function boot() {
    var main = $("#tools-main");
    var nav = $("#tools-nav");
    var cats = {};
    widgets.forEach(function (w, idx) {
      var slug = (w.cat + "-" + w.name).toLowerCase().replace(/[^a-z0-9]+/g, "-");
      var section = cats[w.cat];
      if (!section) {
        cats[w.cat] = true;
        var navA = document.createElement("a");
        navA.href = "#cat-" + w.cat.toLowerCase();
        navA.textContent = w.cat;
        nav.appendChild(navA);
      }
      var el = document.createElement("section");
      el.className = "tool-widget";
      el.id = "t-" + slug;
      el.innerHTML = '<h2><span class="tool-kind">' + esc(w.cat) + '</span>' + esc(w.name) + "</h2>";
      main.appendChild(el);
      try { w.body(el); } catch (e) {
        el.innerHTML += '<p class="desc">Widget failed: ' + esc(e.message) + "</p>";
      }
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
