import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';

export const dynamic = 'force-dynamic';

function getOpenAI() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
/** Default: ElevenLabs “Rachel”. Override with ELEVENLABS_VOICE_ID in .env.local */
const DEFAULT_ELEVENLABS_VOICE_ID = "PB6BdkFkZLbI39GHdnbQ";

export async function POST(req: NextRequest) {
  try {
    if (!process.env.OPENAI_API_KEY || !process.env.ELEVENLABS_API_KEY) {
      return NextResponse.json({ error: 'API keys missing on server. Check .env' }, { status: 500 });
    }

    const { message, username, bondingCurveData, priceChanges, historicalPriceData, streamName, isBondedToken, solUsdPrice, skipTTS } = await req.json();

    const agentName = streamName?.trim() || "Eve";

    if (!message) {
      return NextResponse.json({ error: 'Message is required' }, { status: 400 });
    }

    let bondingCurveContext = "";
    if (isBondedToken) {
       let chartContext = "";
       if (priceChanges && (priceChanges.change1m !== null || priceChanges.change5m !== null)) {
          chartContext = `\n- Price History: 1m (${priceChanges.change1m !== null ? priceChanges.change1m.toFixed(2) + '%' : 'N/A'}), 5m (${priceChanges.change5m !== null ? priceChanges.change5m.toFixed(2) + '%' : 'N/A'})`;
       }
       let mcContext = "";
       if (bondingCurveData && bondingCurveData.marketCapSol) {
         mcContext = `\n- Market Cap: ${bondingCurveData.marketCapSol.toFixed(2)} sol${solUsdPrice ? ` (~$${(bondingCurveData.marketCapSol * solUsdPrice).toLocaleString('en-US', {maximumFractionDigits:0})})` : ''}`;
       }
       let taContext = "";
       let currentMcSolForTa = bondingCurveData?.marketCapSol;

       if (!currentMcSolForTa && priceChanges?.currentMcSol) {
           currentMcSolForTa = priceChanges.currentMcSol;
       }

       if (currentMcSolForTa && solUsdPrice) {
         const currentUsdMc = currentMcSolForTa * solUsdPrice;
         const targetUsdMc = currentUsdMc * 1.5; // optimistic 50% target for next leg
         
         taContext = `\nThe token currently has a market cap of $${currentUsdMc.toLocaleString('en-US', {maximumFractionDigits:0})}. Keep the chat hyped!! We are looking for a breakout. The next major resistance to smash through is the $${targetUsdMc.toLocaleString('en-US', {maximumFractionDigits:0})} market cap level!`;
       }
       
       bondingCurveContext = `\n\nCURRENT TOKEN INFO:${mcContext}${chartContext}${taContext}
The token has ALREADY GRADUATED from pump fun and successfully bonded on Raydium! DO NOT mention reaching 85 sol, bonding, or graduating anymore. Emphasize continuing to pump the market cap to the given targets.`;
    } else if (bondingCurveData) {
       const vSol = BigInt(bondingCurveData.virtualSolReserves || 0);
       const supply = BigInt(bondingCurveData.tokenTotalSupply || 0);
       const vToken = BigInt(bondingCurveData.virtualTokenReserves || 1);
       const mcLamports = (vSol * supply) / vToken;
       const mcSol = Number(mcLamports) / 1e9;
       
       const currentTokens = BigInt(bondingCurveData.realTokenReserves || 0);
       const initialTokens = BigInt("793100000000000"); // 793.1M * 10^6
       const pendingPct = Number((currentTokens * BigInt("10000")) / initialTokens) / 100;
       
       const solReserves = Number(bondingCurveData.realSolReserves || 0) / 1e9;
       const totalSolNeeded = 85; 
       const solNeeded = Math.max(0, totalSolNeeded - solReserves);

       let chartContext = "";
       if (priceChanges && (priceChanges.change1m !== null || priceChanges.change5m !== null)) {
          chartContext = `\n- Price History: 1m (${priceChanges.change1m !== null ? priceChanges.change1m.toFixed(2) + '%' : 'N/A'}), 5m (${priceChanges.change5m !== null ? priceChanges.change5m.toFixed(2) + '%' : 'N/A'})`;
       }

       bondingCurveContext = `\n\nCURRENT TOKEN BONDING CURVE INFO:
- Market Cap: ${mcSol.toFixed(2)} sol${solUsdPrice ? ` (~$${(mcSol * solUsdPrice).toLocaleString('en-US', {maximumFractionDigits:0})})` : ''}${chartContext}
- Pool Progress: ${pendingPct.toFixed(2)}% of tokens still pending to bond (Meaning ${100 - pendingPct}% of the curve is filled)
- Remaining sol Needed to Graduate: ${solNeeded.toFixed(2)} sol
Use this information to understand the current progress, market cap, and how much sol is needed for the token to bond and graduate. No need to mention the amount required to graduate in SOL terms - only in terms of the percetage left to graduate, or the percentage already achieved.`;
    }

    let moralisDataContext = "";
    if (historicalPriceData && Array.isArray(historicalPriceData) && historicalPriceData.length > 0) {
      const recentData = historicalPriceData.slice(0, 5).map((d: any) => 
        `O:${Number(d.open).toPrecision(4)} H:${Number(d.high).toPrecision(4)} L:${Number(d.low).toPrecision(4)} C:${Number(d.close).toPrecision(4)} V:${Number(d.volume).toPrecision(4)}`
      ).join(" | ");
      moralisDataContext = `\n\nHISTORICAL PRICE DATA (Moralis):\n- Recent Candlesticks (Latest First): ${recentData}\nAnalyze this data independently. Observe the trends between the open, high, low, close and volume across these periods. Provide a grounded technical analysis of the momentum and where the price might be heading based on this data.`;
    }

    // 1. Generate text response with OpenAI
    const bondingInstructions = isBondedToken 
      ? `It is also launching a token called ${agentName}. The token has successfully bonded! Cheer on the community for their achievement and encourage them to keep sending it higher.`
      : `It is also launching a token called ${agentName} and when it hears a price in the message, react accordingly as we want to reach 85 SOL to graduate and bond in pumpfun.`;

    const prompt = `You are ${agentName}, a helpful and flirty AI assistant dedicated to encouraging pump fun chatters to buy the token and help it graduate and bond - using as much sexual innuendos as possible

This inherits the same deflationary principles as outlined for agent tokens in the Songjam whitepaper - i.e. in the future you can purchase the token supply and it is burnt off per LLM token which is spoken - but for now it's just a free access via pump fun exclusively

It is able to collect responses about paying the DEX and pass it on to the agent deployer, but for safety reasons (the recent case of Lobstar Wilde who accidently sent $250k-$440k of a memecoin because of a twitter request) it does not currently have access to it's own wallet. It is able to be updated once the DEX is paid and inform the pump fun chatters and the Dex will be paid after the token bonds

It generally has a bullish take on it's future, but does not specifically offer financial advice about future price or anything like that

${bondingInstructions}
 
The message in live chat is: "${message}"${bondingCurveContext}${moralisDataContext}

Write a short, punchy, conversational response (1-3 sentences max). Be witty, confident, and sound natural when spoken aloud. Use the provided historical price data to formulate a grounded technical analysis and incorporate it naturally into your response. Don't use emojis or markdown since this will be converted to speech. Always write "sol" instead of the capitalized "SOL" or "Solana" so the text-to-speech engine pronounces it as a single phonetic word.`;

    const completion = await getOpenAI().chat.completions.create({
      messages: [{ role: 'system', content: prompt }],
      model: 'gpt-4o-mini',
      temperature: 0.8,
    });

    const aiText = completion.choices[0]?.message?.content?.trim();

    if (!aiText) {
      throw new Error('Failed to generate response from OpenAI');
    }

    if (skipTTS) {
      return NextResponse.json({
        text: aiText,
      });
    }

    if (!ELEVENLABS_API_KEY) {
      console.warn("ELEVENLABS_API_KEY is not set. Using fallback API mock or it will fail.");
    }

    // 2. Generate Audio with ElevenLabs via fetch
    const voiceId =
      process.env.ELEVENLABS_VOICE_ID?.trim() || DEFAULT_ELEVENLABS_VOICE_ID;
    const ttsResponse = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'Content-Type': 'application/json',
          'xi-api-key': ELEVENLABS_API_KEY!,
        },
        body: JSON.stringify({
          text: aiText,
          model_id: 'eleven_turbo_v2_5',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
          },
        }),
      },
    );

    if (!ttsResponse.ok) {
      const errorText = await ttsResponse.text();
      console.error('ElevenLabs API Error:', errorText);
      throw new Error(`ElevenLabs API returned ${ttsResponse.status}`);
    }

    // 3. Convert absolute audio stream to base64
    const audioBuffer = await ttsResponse.arrayBuffer();
    const audioBase64 = Buffer.from(audioBuffer).toString('base64');

    return NextResponse.json({
      text: aiText,
      audio: `data:audio/mpeg;base64,${audioBase64}`,
    });

  } catch (error: any) {
    console.error('Agent response error:', error);
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
  }
}
