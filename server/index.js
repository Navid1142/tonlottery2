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
async function updateRoundProgress(){
  try{
    const treasury=String(process.env.TREASURY_ADDRESS||'').trim();
    if(!treasury) return;

    const apiKey=process.env.TONCENTER_API_KEY || '';
    const headers=apiKey ? {'X-API-Key':apiKey} : {};

    const fourMonthsAgo =
      Math.floor(Date.now()/1000) - (120 * 24 * 60 * 60);

    let offset=0;
    const limit=1000;
    let totalNano=0n;
    let pages=0;

    while(pages<20){
      const url=
        'https://toncenter.com/api/v3/transactions?account='+
        encodeURIComponent(treasury)+
        '&start_utime='+fourMonthsAgo+
        '&limit='+limit+
        '&offset='+offset+
        '&sort=desc';

      const response=await fetch(url,{headers});
      if(!response.ok) break;

      const data=await response.json();
      const transactions=
        Array.isArray(data?.transactions)
          ? data.transactions
          : [];

      if(!transactions.length) break;

      for(const tx of transactions){
        const msg=tx?.in_msg;
        if(!msg) continue;

        const value=BigInt(String(msg.value||'0'));
        if(value<=0n) continue;

        if(msg.bounced===true) continue;

        totalNano+=value;
      }

      pages++;

      if(transactions.length<limit) break;
      offset+=limit;
    }

    round.totalConfirmedTon=
      Number(totalNano)/1000000000;

    console.log(
      '[progress] confirmed:',
      round.totalConfirmedTon,
      'TON | since:',
      new Date(fourMonthsAgo*1000).toISOString(),
      '| pages:',
      pages
    );

  }catch(error){
    console.error(
      '[progress] blockchain check failed:',
      error.message
    );
  }
}

app.get('/api/config',async (req,res)=>{
  await updateRoundProgress();

  res.json({
    round,
    publicAppUrl:process.env.PUBLIC_APP_URL||null,
    treasuryAddress:process.env.TREASURY_ADDRESS||null,
    realPaymentEnabled:true
  });
});
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

app.post('/api/payment/verify',async (req,res)=>{
  try{
    await updateRoundProgress();

    res.json({
      ok:true,
      round,
      totalConfirmedTon:round.totalConfirmedTon
    });
  }catch(error){
    res.status(500).json({
      ok:false,
      error:error.message||'Payment verification failed'
    });
  }
});
app.get('/*splat',(req,res)=>res.sendFile(path.join(__dirname,'..','web','index.html')));
app.listen(PORT,()=>console.log(`Mini App shell running on http://127.0.0.1:${PORT}`));
