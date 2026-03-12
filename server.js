const express = require("express")
const axios = require("axios")
const cheerio = require("cheerio")
const fetch = (...args) => import('node-fetch').then(({default:fetch})=>fetch(...args))
const fs = require("fs")

const app = express()
app.use(express.json())
app.use(express.static("public"))

let pages = []
let crawlQueue = [
"https://example.com",
"https://wikipedia.org",
"https://developer.mozilla.org"
]
let visited = new Set()

// Load previous index if exists
if(fs.existsSync("index.json")){
  pages = JSON.parse(fs.readFileSync("index.json"))
  pages.forEach(p=>visited.add(p.url))
}

// Save index periodically
function saveIndex(){
  fs.writeFileSync("index.json",JSON.stringify(pages,null,2))
}
setInterval(saveIndex,30000)

// ---------------- Search Endpoint ----------------
app.get("/search", (req,res)=>{
  let q = (req.query.q||"").toLowerCase()
  let results = pages.map(p=>{
    let score=0
    if(p.title.toLowerCase().includes(q)) score+=5
    if(p.text.toLowerCase().includes(q)) score+=3
    if(p.url.toLowerCase().includes(q)) score+=2
    return {page:p,score}
  }).sort((a,b)=>b.score-a.score)
    .slice(0,20)
    .map(x=>x.page)
  res.json(results)
})

// ---------------- Submit Site ----------------
app.post("/submit",(req,res)=>{
  let url=req.body.url
  if(url && !visited.has(url)){
    crawlQueue.push(url)
  }
  res.json({status:"queued"})
})

// ---------------- Stats ----------------
app.get("/stats",(req,res)=>{
  res.json({pages:pages.length,queue:crawlQueue.length})
})

// ---------------- Distributed Crawler ----------------
app.get("/crawl-task",(req,res)=>{
  let url = crawlQueue.shift()
  if(!url) return res.json({url:null})
  res.json({url})
})

app.post("/crawl-result",(req,res)=>{
  let data=req.body
  if(!data.url || visited.has(data.url)) return res.end()
  visited.add(data.url)
  pages.push({
    url:data.url,
    title:data.title||data.url,
    text:data.text||"",
  })
  if(data.links){
    data.links.forEach(l=>{
      if(!visited.has(l) && l.startsWith("http")) crawlQueue.push(l)
    })
  }
  res.json({status:"indexed"})
})

// ---------------- Local Parallel Crawler ----------------
async function crawl(){
  if(crawlQueue.length===0) return
  let url = crawlQueue.shift()
  if(!url || visited.has(url)) return
  visited.add(url)
  try{
    let r = await axios.get(url,{timeout:5000})
    let html = r.data
    let $ = cheerio.load(html)
    let title = $("title").text()
    let text = $("p").text().slice(0,1000)
    let links = []
    $("a").each((i,el)=>{
      let l=$(el).attr("href")
      if(l && l.startsWith("http")) links.push(l)
    })
    pages.push({url,title,text})
    links.forEach(l=>{if(!visited.has(l)) crawlQueue.push(l)})
  }catch(e){}
}
setInterval(crawl,2000) // parallel crawler every 2s

// ---------------- AI Answer ----------------
app.post("/ai", async(req,res)=>{
  let q=req.body.q
  try{
    let r = await fetch("https://openrouter.ai/api/v1/chat/completions",{
      method:"POST",
      headers:{
        "Authorization":"Bearer "+process.env.OPENROUTER_KEY,
        "Content-Type":"application/json"
      },
      body:JSON.stringify({
        model:"openai/gpt-4o-mini",
        messages:[{role:"user",content:"Answer using sources: "+q}]
      })
    })
    let data = await r.json()
    res.json(data)
  }catch(e){
    res.json({error:"AI failed"})
  }
})

app.listen(process.env.PORT||3000,()=>console.log("Atomic Search running"))
