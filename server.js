// WeRender Search Hybrid Server
const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// ---------------- Data ----------------
let pages = [];
let crawlQueue = [];
let visited = new Set();

// Load starting index (100K pages)
const indexFile = path.join(__dirname,"index.json");
if(fs.existsSync(indexFile)){
  pages = JSON.parse(fs.readFileSync(indexFile));
  pages.forEach(p => visited.add(p.url));
  console.log("Loaded starting index with", pages.length, "pages");
}

// Save index periodically
setInterval(()=>fs.writeFileSync(indexFile, JSON.stringify(pages,null,2)),30000);

// ---------------- Embeddings ----------------
function simpleEmbedding(text){
  let emb = new Array(128).fill(0);
  for(let i=0;i<text.length;i++) emb[i%128] += text.charCodeAt(i)/255;
  return emb;
}

function cosineSim(a,b){
  let dot=0,nA=0,nB=0;
  for(let i=0;i<a.length;i++){dot+=a[i]*b[i]; nA+=a[i]*a[i]; nB+=b[i]*b[i];}
  return dot/(Math.sqrt(nA)*Math.sqrt(nB)+1e-8);
}

// ---------------- Search ----------------
app.get("/search", async(req,res)=>{
  let q = (req.query.q||"").toLowerCase();
  let qEmb = simpleEmbedding(q);
  let results = pages.map(p=>{
    let score=0;
    if(p.title.toLowerCase().includes(q)) score+=5;
    if(p.text.toLowerCase().includes(q)) score+=3;
    score += 10*cosineSim(qEmb,p.embedding);
    return {page:p,score};
  }).sort((a,b)=>b.score-a.score).slice(0,20).map(x=>x.page);
  res.json(results);
});

// ---------------- AI Answer ----------------
app.post("/ai", async(req,res)=>{
  let q=req.body.q.toLowerCase();
  let qEmb = simpleEmbedding(q);
  let topPages = pages.map(p=>({p,score:cosineSim(qEmb,p.embedding)}))
                      .sort((a,b)=>b.score-a.score)
                      .slice(0,5).map(x=>x.p);
  let answer = "Based on top results:\n";
  topPages.forEach(p=>{
    answer += `- ${p.title}: ${p.text.slice(0,200)}\n`;
  });
  res.json({answer});
});

// ---------------- Site Submission ----------------
app.post("/submit",(req,res)=>{
  let url=req.body.url;
  if(url && !visited.has(url)) crawlQueue.push(url);
  res.json({status:"queued"});
});

// ---------------- Stats ----------------
app.get("/stats",(req,res)=>{
  res.json({pages:pages.length, queue:crawlQueue.length});
});

// ---------------- Distributed Crawl ----------------
app.get("/crawl-task",(req,res)=>{
  let url = crawlQueue.shift();
  if(!url) return res.json({url:null});
  res.json({url});
});

app.post("/crawl-result", async(req,res)=>{
  let data=req.body;
  if(!data.url || visited.has(data.url)) return res.end();
  visited.add(data.url);

  let embedding = simpleEmbedding(data.text || data.title || data.url);
  pages.push({
    url: data.url,
    title: data.title || data.url,
    text: data.text || "",
    embedding
  });

  if(data.links){
    data.links.forEach(l=>{
      if(!visited.has(l) && l.startsWith("http")) crawlQueue.push(l);
    });
  }
  res.json({status:"indexed"});
});

// ---------------- Server-side Parallel Crawling ----------------
async function serverCrawl(){
  if(crawlQueue.length===0) return;
  let url = crawlQueue.shift();
  if(!url || visited.has(url)) return;
  visited.add(url);
  try{
    let r = await axios.get(url,{timeout:5000});
    let html = r.data;
    let $ = cheerio.load(html);
    let title = $("title").text() || url;
    let text = $("p").text().slice(0,1000);
    let links = [];
    $("a").each((i,el)=>{
      let l=$(el).attr("href");
      if(l && l.startsWith("http")) links.push(l);
    });
    let embedding = simpleEmbedding(text || title || url);
    pages.push({url,title,text,embedding});
    links.forEach(l=>{if(!visited.has(l)) crawlQueue.push(l)});
  }catch(e){}
}
setInterval(serverCrawl,3000);

// ---------------- Start Server ----------------
app.listen(process.env.PORT||3000,()=>console.log("WeRender Search Hybrid running"));
