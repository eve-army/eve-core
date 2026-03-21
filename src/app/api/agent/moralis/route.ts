import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const tokenAddress = searchParams.get('tokenAddress');

    if (!tokenAddress) {
      return NextResponse.json({ error: 'Token address is required' }, { status: 400 });
    }

    const MORALIS_API_KEY = process.env.MORALIS_API_KEY;
    if (!MORALIS_API_KEY) {
      return NextResponse.json({ error: 'MORALIS_API_KEY missing from environment' }, { status: 500 });
    }

    // Example Moralis OHLCV request for Solana token
    // Using 5min bars for the last few periods 
    const response = await fetch(`https://solana-gateway.moralis.io/token/mainnet/${tokenAddress}/ohlcv?timeframe=5m`, {
      headers: {
        'accept': 'application/json',
        'X-API-Key': MORALIS_API_KEY
      }
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Moralis API Error:", errText);
      return NextResponse.json({ error: `Moralis API returned ${response.status}` }, { status: response.status });
    }

    const data = await response.json();

    return NextResponse.json({ data: data });

  } catch (error: any) {
    console.error('Moralis Route Error:', error);
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
  }
}
