const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();
const express=require('express');
const crypto=require('crypto');
const path=require('path');
const app=express();
const PORT=process.env.PORT||3000;
app.use(express.json());
app.use(express.static(path.join(__dirname,'..','web')));

const round={id:1,targetTon:10000,maxPerUserTon:1,minPerEntryTon:.1,winners:1000,status:'OPEN',totalConfirmedTon:0};
function validateInitData(initData){
  if(!initData||!process.env.TELEGRAM_BOT_TOKEN) return {ok:false,error:'Telegram validation is not configured'};
  const p=new URLSearchParams(initData); const hash=p.get('hash'); if(!hash) return {ok:false,error:'Missing hash'};
  p.delete('hash'); const dataCheck=[...p.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
  const secret=crypto.createHmac('sha256','WebAppData').update(process.env.TELEGRAM_BOT_TOKEN).digest();
  const calc=crypto.createHmac('sha256',secret).update(dataCheck).digest('hex');
  return {ok:crypto.timingSafeEqual(Buffer.from(calc),Buffer.from(hash)),data:p};
}
app.get('/api/config',(req,res)=>res.json({round,publicAppUrl:process.env.PUBLIC_APP_URL||null,treasuryAddress:process.env.TREASURY_ADDRESS||null,realPaymentEnabled:false}));
app.post('/api/telegram/session',(req,res)=>{const r=validateInitData(req.body?.initData); if(!r.ok)return res.status(401).json(r); let user=null; try{user=JSON.parse(r.data.get('user')||'null')}catch{} res.json({ok:true,user});});
app.post('/api/channel/status',async (req,res)=>{
  try {
    if(!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHANNEL){
      return res.status(503).json({
        ok:false,
        error:'Channel membership check is not configured'
      });
    }

    const session=validateInitData(req.body?.initData);

    if(!session.ok){
      return res.status(401).json({
        ok:false,
        error:'Invalid Telegram session'
      });
    }

    let user=null;
    try {
      user=JSON.parse(session.data.get('user')||'null');
    } catch {}

    if(!user?.id){
      return res.status(400).json({
        ok:false,
        error:'Telegram user not found'
      });
    }

    const channel=process.env.TELEGRAM_CHANNEL.trim();

    const url=
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`+
      `/getChatMember?chat_id=${encodeURIComponent(channel)}`+
      `&user_id=${encodeURIComponent(String(user.id))}`;

    console.log('[membership] checking user:',String(user.id));
    console.log('[membership] channel:',channel);

    const telegramResponse=await fetch(url);
    const data=await telegramResponse.json();

    console.log('[membership] Telegram response:',JSON.stringify(data));

    if(!data.ok){
      return res.status(502).json({
        ok:false,
        error:data.description||'Telegram API error',
        telegramErrorCode:data.error_code||null
      });
    }

    const member=data.result||{};
    const status=member.status;

    const joined=
      status==='creator' ||
      status==='administrator' ||
      status==='member' ||
      (status==='restricted' && member.is_member===true);

    console.log('[membership] status:',status,'joined:',joined);

    res.json({
      ok:true,
      joined,
      status,
      debug:{
        channel,
        telegramStatus:status
      }
    });

  } catch(e) {
    console.error('[membership] error:',e);

    res.status(500).json({
      ok:false,
      error:e.message||'Membership check failed'
    });
  }
});

app.post('/api/payment/verify',(req,res)=>res.status(501).json({ok:false,error:'Real-money payment verification is intentionally not implemented in this shell.'}));
app.get('/*splat',(req,res)=>res.sendFile(path.join(__dirname,'..','web','index.html')));
app.listen(PORT,()=>console.log(`Mini App shell running on http://127.0.0.1:${PORT}`));
