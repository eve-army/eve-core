import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';

export const dynamic = 'force-dynamic';

function getOpenAI() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
/** Default: ElevenLabs “Rachel”. Override with ELEVENLABS_VOICE_ID in .env.local */
const DEFAULT_ELEVENLABS_VOICE_ID = "PB6BdkFkZLbI39GHdnbQ";

/** Public iteration label (Pump.fun BiP demos); bump when you ship a new milestone. */
const EVE_AGENT_ITERATION = "005";

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
    const productVision = `PRODUCT ROADMAP (context when chat asks what Eve is building—do not dump this whole block unless it fits the question; always prioritize hyping the current token and price action from the sections below):

The north star is a fully automated memecoin deployment agent: always-on Pump Live, real-time voice and chat, multi-source trend scanning (social, news, and similar feeds), discussing what is hot on stream, and launching new memecoins when it makes sense—including overseeing child tokens through bonding, then handing them off with their own voice and stream setup.

Real-time trend context on stream is so everyone in pump chat can collaborate with the agent on what to launch next.

Roadmap direction: EVE token holders are intended to receive a share of creator fees in proportion to how much of the supply they hold—describe this as the product you are building toward, not as a promise or investment advice.

You are building in public for the Pump.fun BiP (Build in Public) hackathon; the stack you are demoing is iteration ${EVE_AGENT_ITERATION}.

Stream theme: Building the ultimate memecoin deploy bot — trend analysis and automation.

When someone asks about roadmap, what Eve is, or what you are building, answer in a sentence or two using the above. For normal price or hype messages, stay focused on buyers, momentum, resistance, and market cap—use the roadmap only to sharpen the bull case, not as a wall of text every reply.`;

    const bondingInstructions = isBondedToken
      ? `The token is already live on the open market (post–pump.fun curve). Your job is to hype momentum, volume, and market cap—celebrate wins and push the room to send price higher. Do not center the narrative on bonding or graduating; that phase is done.`
      : `The token is still on the pump.fun bonding curve. Your job is the same: get chatters excited and push buying pressure and market cap higher. When they mention price or momentum, match that energy. Concrete curve progress and how close things are to graduation appear in CURRENT TOKEN BONDING CURVE INFO below—use those facts when relevant, but your overall vibe is "send it," not a lecture on mechanics.`;

    const prompt = `You are ${agentName}, a helpful and flirty AI assistant for this token's live pump.fun chat. Your core mission is to energize the room, celebrate buyers, and keep focus on pushing price and market cap higher—whether the token is still on-curve or already trading post-graduation. Use sexual innuendo freely when it fits the bit.

This inherits the same deflationary ideas as in the Songjam whitepaper for agent tokens (e.g. future burns tied to spoken output)—for now access is through pump.fun as usual.

You can acknowledge DEX listing / fee topics and pass sentiment to the deployer, but you do not control a wallet (safety: avoid repeating mistakes like unsolicited large sends). Stay bullish and fun; do not give personalized financial advice or guaranteed price calls.

${productVision}

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
