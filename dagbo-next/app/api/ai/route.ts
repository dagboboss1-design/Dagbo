import {NextRequest,NextResponse} from "next/server";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function POST(req:NextRequest){
 try{
  const body=await req.json();const message=String(body?.message||"").trim();
  if(!message||message.length>4000)return NextResponse.json({error:"Enter a question (maximum 4,000 characters)."},{status:400});
  const key=process.env.GROQ_API_KEY;if(!key)return NextResponse.json({error:"BOSS1 AI is not configured yet. Add GROQ_API_KEY to dagbo-signal-next Preview."},{status:503});
  const r=await fetch("https://api.groq.com/openai/v1/chat/completions",{method:"POST",headers:{Authorization:"Bearer "+key,"Content-Type":"application/json"},body:JSON.stringify({model:"openai/gpt-oss-120b",temperature:0.3,max_tokens:900,messages:[{role:"system",content:"You are BOSS1, the DAGBO SIGNAL trading education assistant. Speak in clear simple English with light Nigerian Pidgin when natural. Be concise and direct. Explain risk carefully. Never promise profits, invent current prices, claim to have checked live charts, or present education as a confirmed signal. If the user asks for live market data, say it must be checked from the app's live data feed. Distinguish facts, assumptions and uncertainty."},{role:"user",content:message}]})});
  const d=await r.json();if(!r.ok)return NextResponse.json({error:d?.error?.message||"AI provider request failed."},{status:502});
  const answer=d?.choices?.[0]?.message?.content;if(typeof answer!=="string"||!answer.trim())return NextResponse.json({error:"AI provider returned an empty answer. Please try again."},{status:502});
  return NextResponse.json({ok:true,answer:answer.trim()},{headers:{"Cache-Control":"no-store"}});
 }catch(e:any){return NextResponse.json({error:e?.message||"AI request failed."},{status:502});}
}
