import https from 'node:https';
import { resolve4 } from 'node:dns/promises';
import { isIP } from 'node:net';

export function publicIPv4(address) {
  if(isIP(address)!==4)return false;
  const [a,b,c]=address.split('.').map(Number);
  return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||b===0||b===2))||(a===198&&(b===18||b===19||b===51&&c===100))||(a===203&&b===0&&c===113));
}

export function validatePageUrl(value,allowedHosts=['workbuddy.link','www.workbuddy.link']) {
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.port||!allowedHosts.includes(url.hostname)||isIP(url.hostname)||url.href.length>2048)throw new Error('unsupported_url');
  return url;
}

function requestPinned(url,address,{timeoutMs,maxBytes}) {
  return new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(fn,value)=>{if(settled)return;settled=true;clearTimeout(totalTimer);fn(value);};
    const req=https.request(url,{method:'GET',headers:{'User-Agent':'WarriorBase-LinkCheck/1.0','Accept':'text/html','Accept-Encoding':'identity'},lookup:(hostname,opts,cb)=>opts.all?cb(null,[{address,family:4}]):cb(null,address,4)},res=>{
      if([301,302,303,307,308].includes(res.statusCode)){res.resume();finish(resolve,{redirect:res.headers.location});return;}
      if(res.statusCode!==200){res.resume();finish(reject,new Error('page_unavailable'));return;}
      const type=String(res.headers['content-type']||'');
      if(!/text\/html|text\/plain|application\/xhtml\+xml/.test(type)){res.resume();finish(reject,new Error('unsupported_content'));return;}
      const chunks=[];let size=0;
      res.on('data',chunk=>{size+=chunk.length;if(size>maxBytes){res.destroy();finish(reject,new Error('page_too_large'));}else chunks.push(chunk);});
      res.on('end',()=>finish(resolve,{html:Buffer.concat(chunks).toString('utf8')}));
      res.on('error',error=>finish(reject,error));
    });
    const totalTimer=setTimeout(()=>{req.destroy();finish(reject,new Error('page_timeout'));},timeoutMs);
    req.on('error',error=>finish(reject,error));req.end();
  });
}

export function visiblePageText(html) {
  return html.replace(/<!--[\s\S]*?-->/g,' ').replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi,' ').replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/\s+/g,' ').trim().slice(0,6000);
}

export async function inspectExternalPage(value,{allowedHosts=['workbuddy.link','www.workbuddy.link'],timeoutMs=5000,maxBytes=512*1024,resolve=resolve4,request=requestPinned}={}) {
  let url=validatePageUrl(value,allowedHosts);
  const deadline=Date.now()+timeoutMs;
  for(let hop=0;hop<4;hop++){
    const remaining=deadline-Date.now();if(remaining<=0)throw new Error('page_timeout');
    let timer;
    const addresses=await Promise.race([resolve(url.hostname),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('dns_timeout')),remaining);})]).finally(()=>clearTimeout(timer));
    if(!addresses.length||addresses.some(ip=>!publicIPv4(ip)))throw new Error('private_address');
    const response=await request(url,addresses[0],{timeoutMs:Math.max(1,deadline-Date.now()),maxBytes});
    if(response.redirect){url=validatePageUrl(new URL(response.redirect,url).href,allowedHosts);continue;}
    const text=visiblePageText(response.html);
    if(text.length<25||/页面不存在|作品不存在|页面已关闭|链接已失效|page not found/i.test(text))throw new Error('page_not_readable');
    return {url:url.href,text};
  }
  throw new Error('too_many_redirects');
}
