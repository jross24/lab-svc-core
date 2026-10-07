import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

type JsonResponse = APIGatewayProxyStructuredResultV2 & { readonly body: string };

// Mock data. A later phase can replace it with a real data store.
const ITEMS = [
  { id: 'item-1', name: 'First item' },
  { id: 'item-2', name: 'Second item' },
  { id: 'item-3', name: 'Third item' },
] as const;

export async function handler(): Promise<JsonResponse> {
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      service: 'core',
      // The stack sets VERSION at synth time, so the response shows which release runs.
      version: process.env.VERSION ?? 'unknown',
      items: ITEMS,
    }),
  };
}
